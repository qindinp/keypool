import { DeployClient } from './deploy-client.mjs';
import { pushKeyExchange } from './key-exchange.mjs';
import { withRetry, sleep } from '../shared/utils.mjs';
import { probeHealth } from '../shared/http.mjs';

const MISSING_SHARE_URL_RETRY_MS = 5 * 60 * 1000;
const SHARE_URL_PROBE_RETRIES = 3;
const SHARE_URL_PROBE_DELAY_MS = 4000;

function parseDeployResult(reply) {
  const text = String(reply || '');
  const normalized = text.replace(/\r/g, '');
  const shareUrlLineMatch = normalized.match(/(?:^|\n)SHARE_URL\s*[=:]\s*(https?:\/\/[^\s`"'<>]+)/i);
  const labeledShareUrl = shareUrlLineMatch ? shareUrlLineMatch[1] : null;
  const tailnetUrlLineMatch = normalized.match(/(?:^|\n)TAILNET_URL\s*[=:]\s*(https?:\/\/[^\s`"'<>]+)/i);
  const labeledTailnetUrl = tailnetUrlLineMatch ? tailnetUrlLineMatch[1] : null;
  const candidateUrls = Array.from(normalized.matchAll(/https?:\/\/[^\s`"'<>]+/g)).map(m => m[0]);
  const shareUrl = [labeledShareUrl, ...candidateUrls]
    .map(url => normalizeShareUrl(url))
    .filter(Boolean)
    .sort((a, b) => getShareUrlPriority(a) - getShareUrlPriority(b))[0] || null;
  const tailnetUrl = normalizeTailnetUrl(labeledTailnetUrl);
  const localUrlMatch = normalized.match(/http:\/\/127\.0\.0\.1:9200(?:\/health)?/);
  const healthOk = /健康检查通过|LOCAL_OK/.test(normalized);
  const started = /服务已成功启动|SERVICE_RUNNING|SERVICE_RESTARTED/.test(normalized);
  const shareUrlMissing = /SHARE_URL_MISSING|未获取到.*分享地址|tunnel.*未产出/i.test(normalized);

  return {
    shareUrl,
    tailnetUrl,
    localUrl: localUrlMatch ? localUrlMatch[0] : null,
    healthOk,
    started,
    shareUrlMissing,
  };
}

function normalizeTailnetUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith('.ts.net')) return null;
    return url.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeShareUrl(url) {
  if (!isValidShareUrl(url)) return null;
  return url.replace(/\/+$/, '');
}

function getShareUrlPriority(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.ts.net')) return 0;
    if (host.endsWith('.lhr.life')) return 1;
    if (host.endsWith('.serveo.net')) return 2;
    if (host.endsWith('.localhost.run')) return 3;
    return 99;
  } catch {
    return 99;
  }
}

function isValidShareUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'admin.localhost.run') return false;
    if (host === 'localhost.run') return false;
    if (host === 'twitter.com') return false;
    if (host.endsWith('.ts.net')) return true;
    if (host.endsWith('.lhr.life')) return true;
    if (host.endsWith('.serveo.net')) return true;
    if (host.endsWith('.localhost.run')) return true;
    return false;
  } catch {
    return false;
  }
}

async function probeShareUrlWithRetry({ shareUrl, timeoutMs = 15_000, retries = SHARE_URL_PROBE_RETRIES, delayMs = SHARE_URL_PROBE_DELAY_MS, log }) {
  let lastHealth = { ok: false, statusCode: 0, body: '', error: 'not probed' };
  for (let i = 0; i < retries; i++) {
    lastHealth = await probeHealth({ baseUrl: shareUrl, timeoutMs });
    if (lastHealth.ok) {
      if (i > 0) log?.('info', `分享地址复检成功（第 ${i + 1} 次）: ${shareUrl}`);
      return lastHealth;
    }
    if (i < retries - 1) {
      log?.('warn', `分享地址健康检查失败（第 ${i + 1}/${retries} 次，${lastHealth.error || `health ${lastHealth.statusCode}`})，${delayMs / 1000}s 后重试`);
      await sleep(delayMs);
    }
  }
  return lastHealth;
}

async function probeLocalUrl(baseUrl, timeoutMs = 10_000) {
  const target = baseUrl || 'http://127.0.0.1:9200';
  return probeHealth({ baseUrl: target, timeoutMs });
}


export function createAccountWorker({ cookie, config, api, stateStore, log }) {
  async function waitForReady() {
    const start = Date.now();
    log('clock', '等待实例就绪...');

    const TERMINAL_STATES = new Set(['FAILED', 'ERROR', 'DESTROYED']);

    while (Date.now() - start < config.readyTimeout) {
      try {
        const status = await api.getStatus(cookie);
        if (status.status === 'AVAILABLE') break;
        if (TERMINAL_STATES.has(status.status)) {
          log('error', `实例进入终态 ${status.status}，无法恢复`);
          return false;
        }
        log('info', `实例状态: ${status.status}，继续等待...`);
      } catch {}
      await sleep(5000);
    }

    if (Date.now() - start >= config.readyTimeout) {
      log('error', '等待实例 AVAILABLE 超时');
      return false;
    }

    const ticketStart = Date.now();
    while (Date.now() - ticketStart < 60_000) {
      try {
        await api.getTicket(cookie);
        const elapsed = Math.round((Date.now() - start) / 1000);
        log('ok', `实例就绪 (${elapsed}s)`);
        return true;
      } catch {}
      await sleep(3000);
    }

    log('error', '等待 ticket 超时 (Gateway 可能未启动)');
    return false;
  }

  async function deployKeyPool() {
    const client = new DeployClient({ cookie, getTicket: api.getTicket, config, log });

    try {
      log('link', '连接实例 WebSocket...');
      await withRetry('WS连接', () => client.connect(), {
        maxRetries: config.maxRetries,
        retryBaseDelay: config.retryBaseDelay,
        retryMaxDelay: config.retryMaxDelay,
        log,
      });

      const marker = `DEPLOY_${Date.now().toString(36)}`;
      const deployPrompt = [
        `这是我的项目地址：${config.deployRepo}`,
        '请在本地工作区使用 keypool 目录部署这个项目。',
        '如果 keypool 目录不存在，就先 clone；如果已存在，请不要保留旧代码，务必强制同步到远端最新 main。',
        '必须执行等价操作：进入 keypool 目录，git fetch origin，然后 git reset --hard origin/main。',
        '同步完成后，请输出一行 `GIT_HEAD=<当前提交SHA>`。',
        '不要覆盖 SOUL.md，不要修改任何全局安全配置。',
        config.tunnelType === 'tailscale'
          ? `本次要求优先使用 Tailscale 隧道。请在启动服务前确保以下环境：TAILSCALE_HOSTNAME=${config.tailscaleHostname}、TAILSCALE_FUNNEL=${config.tailscaleFunnel ? 'true' : 'false'}、TAILSCALE_AUTO_INSTALL=${config.tailscaleAutoInstall ? 'true' : 'false'}${config.tailscaleAuthKey ? `、TAILSCALE_AUTHKEY=${config.tailscaleAuthKey}` : ''}。`
          : `本次要求使用 SSH 隧道，服务启动时应使用 tunnelType=${config.tunnelType}、tunnelService=${config.tunnelService}。`,
        config.tunnelType === 'tailscale'
          ? '如果实例里未安装 tailscale，允许并应当自动安装；如果未登录且已提供 TAILSCALE_AUTHKEY，必须走免交互登录；如果 tailscale 最终失败，再回退到 SSH 隧道。'
          : '如 SSH 隧道失败，请在回复里明确说明。',
        '不要只做口头说明，必须实际执行命令。',
        '必须先停止旧的 keypool 服务进程，避免旧版本继续占用端口。可使用 pkill -f "node server" 或等价方式。',
        '如果是 tailscale 模式，必须在同一个 shell 会话中 export/设置好 TAILSCALE_HOSTNAME、TAILSCALE_FUNNEL、TAILSCALE_AUTO_INSTALL，以及在已提供时设置 TAILSCALE_AUTHKEY。',
        '随后必须在 keypool 目录重新启动新版服务，优先使用类似 `nohup node server/index.mjs >/tmp/keypool.log 2>&1 &` 的方式；如果需要环境变量，必须与启动命令处于同一 shell 生效范围。',
        '启动后检查 http://127.0.0.1:9200/health 是否可访问。',
        '如果服务会异步建立隧道（Tailscale Funnel 或 SSH），请额外等待最多 45 秒，检查 keypool/.tunnel-url 是否出现。',
        '如果 keypool/.tunnel-url 存在，请读取其中地址并按 `SHARE_URL=<地址>` 单独输出一行。',
        '如果没有拿到对外地址，也请明确输出 `SHARE_URL_MISSING`。',
        '如果 tailscale 命令可用，请读取 `tailscale status --json` 中当前节点的 DNSName，并按 `TAILNET_URL=https://<dnsname>` 单独输出一行；如果拿不到则输出 `TAILNET_URL_MISSING`。',
        '如果执行了 tailscale 安装，请额外输出 `TAILSCALE_INSTALL=ok` 或 `TAILSCALE_INSTALL=fail`。',
        '如果 tailscale 命令可用，请额外输出 `TAILSCALE_BIN=present`；否则输出 `TAILSCALE_BIN=missing`。',
        '重要：回复的最后两行必须是以下格式（独占一行，不要包裹在代码块中）：',
        `  ${marker}_OK`,
        `  ${marker}_FAIL`,
        '根据结果二选一，不要两个都输出。前面可以有其他内容，但最后两行必须是 SHARE_URL 行和结果标记行。',
      ].join('\n');

      log('deploy', '下发部署请求...');
      const reply = await client.chat(deployPrompt, { timeoutMs: config.deployTimeout, matchText: marker });
      const parsed = parseDeployResult(reply);

      // 多层匹配：精确匹配 → 模糊匹配 → 强信号判定
      const hasOk = reply?.includes(`${marker}_OK`) || false;
      const hasFail = reply?.includes(`${marker}_FAIL`) || false;

      if (hasOk && !hasFail) {
        log('ok', 'KeyPool 部署成功，健康检查通过');
        if (parsed.tailnetUrl) log('info', `Tailscale 内网地址: ${parsed.tailnetUrl}`);
        if (parsed.shareUrl) log('info', `分享地址: ${parsed.shareUrl}`);
        return { success: true, reply, ...parsed };
      }
      if (hasFail) {
        log('error', 'KeyPool 部署失败');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, ...parsed };
      }

      // Marker 未出现，用强信号兜底
      const strongSuccess = reply && (parsed.started || parsed.healthOk || !!parsed.localUrl);
      if (strongSuccess) {
        log('ok', 'KeyPool 部署成功（根据明确健康状态文本判定）');
        log('info', '回复:', reply?.slice(0, 500));
        if (parsed.tailnetUrl) log('info', `Tailscale 内网地址: ${parsed.tailnetUrl}`);
        if (parsed.shareUrl) log('info', `分享地址: ${parsed.shareUrl}`);
        return { success: true, reply, ...parsed };
      }

      // 最后兜底：如果回复中有明确的失败信号
      const hasFailureSignal = reply && (
        /部署失败|deploy.*fail|健康检查.*失败|health.*fail|无法启动|failed to start/i.test(reply)
      );
      if (hasFailureSignal) {
        log('error', 'KeyPool 部署失败（根据失败文本判定）');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, ...parsed };
      }

      log('error', '部署结果异常：未返回明确标记');
      log('info', '回复:', reply?.slice(0, 500));
      return { success: false, reply, ...parsed };
    } catch (e) {
      log('error', '部署失败:', e.message);
      return { success: false, reply: '', shareUrl: null, tailnetUrl: null, localUrl: null, healthOk: false, started: false };
    } finally {
      client.close();
    }
  }

  async function fetchNewApiKey() {
    const client = new DeployClient({ cookie, getTicket: api.getTicket, config, log });
    try {
      await client.connect();
      const reply = await client.chat(
        '执行命令 echo $MIMO_API_KEY 并将结果原样输出，不要添加任何额外文字或格式',
        30000,
      );
      const match = reply?.match(/(oc_[a-zA-Z0-9_]+)/);
      if (match) {
        log('key', `新 Key: ${match[1].slice(0, 20)}...`);
        return match[1];
      }
      log('warn', '未能提取 Key');
      log('info', '回复:', reply?.slice(0, 200));
      return null;
    } catch (e) {
      log('error', '获取 Key 失败:', e.message);
      return null;
    } finally {
      client.close();
    }
  }

  async function recoverAvailableInstance() {
    const client = new DeployClient({ cookie, getTicket: api.getTicket, config, log });
    try {
      log('link', '分享地址异常，尝试直连实例 Gateway 做原地探测...');
      await withRetry('WS连接', () => client.connect(), {
        maxRetries: config.maxRetries,
        retryBaseDelay: config.retryBaseDelay,
        retryMaxDelay: config.retryMaxDelay,
        log,
      });

      const marker = `RECOVER_${Date.now().toString(36)}`;
      const recoverPrompt = [
        '请不要重新创建实例，也不要重新 git clone。',
        '你现在只做原地检查和原地恢复。',
        '先检查 keypool 目录下服务是否正在运行，并访问 http://127.0.0.1:9200/health 。',
        '如果本地健康检查已经通过，请回复 LOCAL_OK。',
        '如果本地服务未运行或健康检查失败，请在已有 keypool 目录中原地重新启动 node server.mjs，等待健康检查恢复。',
        '如果原地重启成功，请回复 SERVICE_RESTARTED。',
        '如果服务本来就在运行，也可以回复 SERVICE_RUNNING。',
        '请额外检查以下信息并一并返回：',
        '1. keypool/.tunnel-url 是否存在；如果存在，读取内容并按 `SHARE_URL=<地址>` 单独输出一行。',
        '2. 如果不存在，请输出 `SHARE_URL_MISSING`。',
        '3. 输出 `TUNNEL_FILE=present` 或 `TUNNEL_FILE=missing`。',
        '4. 输出 `TAILSCALE_FUNNEL=running` 或 `TAILSCALE_FUNNEL=missing`，用于表示 Tailscale Funnel 是否正常工作。',
        '5. 如果 tailscale 命令可用，请读取 `tailscale status --json` 中当前节点的 DNSName，并按 `TAILNET_URL=https://<dnsname>` 单独输出一行；如果拿不到则输出 `TAILNET_URL_MISSING`。',
        '6. 如可行，附带 /tmp/keypool.log 最后 20 行中的 tunnel/tailscale 相关关键信息。',
        '重要：回复的最后两行必须是以下格式（独占一行，不要包裹在代码块中）：',
        `  ${marker}_OK`,
        `  ${marker}_FAIL`,
        '根据结果二选一。前面可以有其他内容，但最后两行必须是 SHARE_URL 行和结果标记行。',
      ].join('\n');

      const reply = await client.chat(recoverPrompt, { timeoutMs: config.deployTimeout, matchText: marker });
      const parsed = parseDeployResult(reply);

      // 多层匹配：精确匹配 → 强信号判定
      const hasOk = reply?.includes(`${marker}_OK`) || false;
      const hasFail = reply?.includes(`${marker}_FAIL`) || false;
      const hasStrongOkSignal = reply && (
        reply.includes('LOCAL_OK') || reply.includes('SERVICE_RUNNING') || reply.includes('SERVICE_RESTARTED')
      );

      if (!hasOk && !hasStrongOkSignal) {
        // marker 没出现，也没有强成功信号
        if (hasFail) {
          log('warn', '实例原地探测/恢复失败（FAIL 标记）');
        } else {
          log('warn', '实例原地探测/恢复失败（无明确标记）');
        }
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, ...parsed };
      }

      const shareUrl = parsed.shareUrl || null;
      const tailnetUrl = parsed.tailnetUrl || null;
      const accessibleUrl = tailnetUrl || shareUrl || null;
      const localUrl = parsed.localUrl || 'http://127.0.0.1:9200';
      const localRecovered = parsed.healthOk || parsed.started || !!accessibleUrl || reply?.includes('LOCAL_OK') || reply?.includes('SERVICE_RUNNING') || reply?.includes('SERVICE_RESTARTED');
      if (!localRecovered) {
        log('warn', '实例原地探测未能确认本地服务健康恢复');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, shareUrl, tailnetUrl, localUrl, healthOk: false, started: parsed.started, tunnelMissing: false };
      }

      if (!accessibleUrl) {
        log('warn', '实例内服务已恢复，但未返回可访问入口地址');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, shareUrl: null, tailnetUrl, localUrl, healthOk: true, started: parsed.started, tunnelMissing: true };
      }

      const shareHealth = await probeShareUrlWithRetry({ shareUrl: accessibleUrl, timeoutMs: 15_000, log });
      if (!shareHealth.ok) {
        log('warn', `实例返回了可访问入口，但健康检查仍失败 (${shareHealth.error || `health ${shareHealth.statusCode}`})；先保留地址，等待后续复检`);
        log('info', '回复:', reply?.slice(0, 500));
        return {
          success: true,
          reply,
          shareUrl,
          tailnetUrl,
          localUrl,
          healthOk: true,
          started: parsed.started,
          tunnelMissing: false,
          shareUrlPending: true,
          shareUrlHealthError: shareHealth.error || `health ${shareHealth.statusCode}`,
        };
      }

      log('ok', `实例原地恢复成功 | 可访问入口: ${accessibleUrl}`);
      return { success: true, reply, shareUrl, tailnetUrl, localUrl, healthOk: true, started: parsed.started, tunnelMissing: false, shareUrlPending: false };
    } catch (e) {
      log('warn', '实例原地探测失败:', e.message);
      return { success: false, reply: '', shareUrl: null, tailnetUrl: null, localUrl: null, healthOk: false, started: false, tunnelMissing: false };
    } finally {
      client.close();
    }
  }

  async function renewFlow(reason) {
    log('rocket', `开始续期流程 (${reason})`);

    // 保存旧状态，用于部署失败时回滚
    const oldState = stateStore.loadState();
    const oldShareUrl = oldState.currentShareUrl || null;
    const oldTailnetUrl = oldState.currentTailnetUrl || null;
    const oldLocalUrl = oldState.currentLocalUrl || null;
    const oldKey = oldState.currentKey || null;

    let newStatus;
    try {
      newStatus = await withRetry('创建实例', () => api.createInstance(cookie), {
        maxRetries: config.maxRetries,
        retryBaseDelay: config.retryBaseDelay,
        retryMaxDelay: config.retryMaxDelay,
        log,
      });
    } catch (e) {
      log('error', '创建实例失败:', e.message);
      return false;
    }

    if (!newStatus.expireTime) {
      if (newStatus.status === 'CREATING' || newStatus.status === 'AVAILABLE') {
        log('info', `创建请求已接受，当前状态: ${newStatus.status}，继续等待实例就绪`);
      } else {
        log('error', '创建返回异常:', JSON.stringify(newStatus));
        return false;
      }
    } else {
      log('ok', `新实例到期: ${new Date(newStatus.expireTime).toLocaleString()}`);
    }

    const ready = await waitForReady();
    if (!ready) {
      log('error', '实例未就绪，续期流程中止');
      // 尝试恢复旧状态标记，避免丢失旧地址
      if (oldShareUrl) {
        log('info', `保留旧分享地址: ${oldShareUrl}`);
        const state = stateStore.loadState();
        state.currentShareUrl = oldShareUrl;
        state.currentTailnetUrl = oldTailnetUrl;
        state.currentLocalUrl = oldLocalUrl;
        if (oldKey) state.currentKey = oldKey;
        state.lastHealthError = 'renew-failed-kept-old';
        stateStore.saveState(state, log);
      }
      return false;
    }

    const deployResult = await deployKeyPool();
    if (!deployResult.success) {
      log('error', 'KeyPool 部署失败');
      // 部署失败但新实例已创建，旧实例可能已被销毁
      // 记录失败状态，但不回滚（旧实例可能已不存在）
      const state = stateStore.loadState();
      state.lastHealthError = 'deploy-failed-after-renew';
      state.lastDeployAt = Date.now();
      stateStore.saveState(state, log);
      log('warn', '部署失败，旧实例可能已被销毁，需要手动干预或等待下次循环重试');
      return false;
    }

    let newKey = null;
    if (config.keyExchangeUrl) {
      newKey = await fetchNewApiKey();
      if (newKey) {
        await pushKeyExchange(newKey, config.keyExchangeUrl, log);
      } else {
        log('warn', '未能提取临时 MIMO_API_KEY，但部署已成功，继续保留分享入口作为主要产物');
      }
    } else {
      log('info', '未配置 Key 交换，跳过临时 MIMO_API_KEY 提取');
    }

    const state = stateStore.loadState();
    const previousShareUrl = state.currentShareUrl || null;
    const previousTailnetUrl = state.currentTailnetUrl || null;
    let effectiveShareUrl = deployResult.shareUrl || null;
    const effectiveTailnetUrl = deployResult.tailnetUrl || previousTailnetUrl || null;
    if (!effectiveShareUrl && previousShareUrl) {
      try {
        const previousHealth = await probeHealth({ baseUrl: previousShareUrl, timeoutMs: 15_000 });
        if (previousHealth.ok) {
          effectiveShareUrl = previousShareUrl;
          log('info', `本轮未拿到新分享地址，保留已验证健康的旧地址: ${previousShareUrl}`);
        } else {
          log('warn', `本轮未拿到新分享地址，且旧地址已不健康 (${previousHealth.error || `health ${previousHealth.statusCode}`})，不再保留`);
        }
      } catch (e) {
        log('warn', `校验旧分享地址失败 (${e.message})，不再保留`);
      }
    }

    state.lastExpireTime = newStatus.expireTime;
    state.lastDeployAt = Date.now();
    state.deployCount = (state.deployCount || 0) + 1;
    if (newKey) state.currentKey = newKey;
    state.currentShareUrl = effectiveShareUrl;
    state.currentTailnetUrl = effectiveTailnetUrl;
    state.currentLocalUrl = deployResult.localUrl || 'http://127.0.0.1:9200';
    state.history = state.history || [];
    state.history.push({
      at: new Date().toISOString(),
      reason,
      expireTime: newStatus.expireTime,
      key: newKey ? newKey.slice(0, 20) + '...' : null,
      shareUrl: effectiveShareUrl,
      tailnetUrl: effectiveTailnetUrl,
      localUrl: deployResult.localUrl || 'http://127.0.0.1:9200',
      success: true,
    });
    if (state.history.length > 50) state.history = state.history.slice(-50);
    state.lastHealthError = null;
    stateStore.saveState(state, log);

    if (effectiveTailnetUrl) {
      log('ok', `✨ 第 ${state.deployCount} 次续期完成 | Tailscale 内网地址: ${effectiveTailnetUrl}`);
      if (effectiveShareUrl) log('info', `公网分享地址: ${effectiveShareUrl}`);
    } else if (effectiveShareUrl) {
      log('ok', `✨ 第 ${state.deployCount} 次续期完成 | 分享地址: ${effectiveShareUrl}`);
    } else {
      log('warn', `✨ 第 ${state.deployCount} 次续期完成 | 本地服务已恢复，但未获取到新的分享地址`);
      log('info', `本地地址: ${state.currentLocalUrl}`);
    }
    return true;
  }

  async function cmdStatus() {
    const state = stateStore.loadState();
    console.log('\n📊 Controller 状态:');
    console.log('─'.repeat(40));
    console.log(`  部署次数: ${state.deployCount || 0}`);
    console.log(`  当前 Key: ${state.currentKey ? state.currentKey.slice(0, 20) + '...' : '未使用 / 未记录'}`);
    console.log(`  Tailscale 内网地址: ${state.currentTailnetUrl || '未知'}`);
    console.log(`  分享地址: ${state.currentShareUrl || '未知'}`);
    console.log(`  本地地址: ${state.currentLocalUrl || 'http://127.0.0.1:9200'}`);
    console.log(`  上次部署: ${state.lastDeployAt ? new Date(state.lastDeployAt).toLocaleString() : '无'}`);

    try {
      const status = await api.getStatus(cookie);
      const remaining = status.expireTime - Date.now();
      console.log(`\n  实例状态: ${status.status}`);
      console.log(`  剩余时间: ${Math.round(remaining / 60_000)}min`);
      console.log(`  到期时间: ${new Date(status.expireTime).toLocaleString()}`);
    } catch (e) {
      console.log(`\n  ❌ 获取实例状态失败: ${e.message}`);
    }

    if (state.history?.length > 0) {
      console.log('\n  最近续期记录:');
      for (const h of state.history.slice(-5)) {
        console.log(`    ${h.at} | ${h.reason} | ${h.success ? '✅' : '❌'} | ${h.shareUrl || h.localUrl || '-'}`);
      }
    }
    console.log();
  }

  async function cmdDeploy() {
    log('deploy', '强制重新部署...');
    await renewFlow('manual-deploy');
  }

  async function runLoop({ once = false }) {
    let state = stateStore.loadState();

    log('info', '═'.repeat(50));
    log('info', 'KeyPool Controller (Part 2) 启动');
    log('info', `检查间隔: ${config.checkInterval / 1000}s | 续期阈值: 到期前 ${config.renewBefore / 1000}s`);
    log('info', `仓库: ${config.deployRepo}`);
    if (config.keyExchangeUrl) log('info', `Key 交换: ${config.keyExchangeUrl}`);
    log('info', `模式: ${once ? '单次检查' : '持续运行'}`);
    log('info', '═'.repeat(50));

    if (state.deployCount > 0) {
      log('info', `历史: 已续期 ${state.deployCount} 次, 上次: ${state.lastDeployAt ? new Date(state.lastDeployAt).toLocaleString() : '未知'}`);
    }

    while (true) {
      state = stateStore.loadState();
      try {
        const status = await api.getStatus(cookie);
        const now = Date.now();
        const expireTime = Number(status.expireTime || 0);
        const hasExpireTime = Number.isFinite(expireTime) && expireTime > 0;
        const remaining = hasExpireTime ? (expireTime - now) : -1;
        const remainMin = hasExpireTime ? Math.round(remaining / 60_000) : null;

        const currentStatus = status.status || 'UNKNOWN';
        const currentShareUrl = state.currentShareUrl || null;
        const currentTailnetUrl = state.currentTailnetUrl || null;
        const currentLocalUrl = state.currentLocalUrl || null;
        const currentBaseUrl = currentTailnetUrl || currentShareUrl || null;
        const hasDeployment = Boolean(state.lastDeployAt) && Boolean(currentBaseUrl || currentLocalUrl);
        let endpointUnhealthy = false;
        let endpointError = null;
        if (state.lastExpireTime !== status.expireTime || state.lastObservedStatus !== currentStatus) {
          const remainText = hasExpireTime ? `${remainMin}min` : '未知';
          const expireText = hasExpireTime ? new Date(expireTime).toLocaleString() : '未知';
          log('info', `实例 ${currentStatus} | 剩余 ${remainText} | 到期 ${expireText}`);
          state.lastExpireTime = status.expireTime || null;
          state.lastObservedStatus = currentStatus;
          stateStore.saveState(state, log);
        }

        if (currentStatus === 'DESTROYED' || currentStatus === 'FAILED' || currentStatus === 'ERROR') {
          log('warn', `实例状态异常: ${currentStatus}，尝试自动重建`);
          await renewFlow(`status-${String(currentStatus).toLowerCase()}`);
        } else if (!hasExpireTime) {
          log('warn', '实例缺少 expireTime，尝试自动重建');
          await renewFlow('missing-expire-time');
        } else if (currentStatus === 'AVAILABLE' && !hasDeployment) {
          log('warn', '实例已可用但尚未完成部署，尝试自动部署');
          await renewFlow('available-but-not-deployed');
        } else if (currentStatus === 'AVAILABLE' && currentBaseUrl) {
          const localBaseUrl = currentLocalUrl || 'http://127.0.0.1:9200';
          const localHealth = await probeLocalUrl(localBaseUrl, 10_000);
          const shareHealth = await probeHealth({ baseUrl: currentBaseUrl, timeoutMs: 15_000 });
          const localUnhealthy = !localHealth.ok;
          endpointUnhealthy = !shareHealth.ok;
          endpointError = shareHealth.error || `health ${shareHealth.statusCode}`;

          if (localUnhealthy) {
            const localError = localHealth.error || `health ${localHealth.statusCode}`;
            log('warn', `本地服务健康检查失败 (${localError})，先尝试实例内原地恢复`);
            state.lastHealthError = `local:${localError}`;
            stateStore.saveState(state, log);

            const recovered = await recoverAvailableInstance();
            if (recovered.success) {
              state.currentShareUrl = recovered.shareUrl || state.currentShareUrl || null;
              state.currentTailnetUrl = recovered.tailnetUrl || state.currentTailnetUrl || null;
              state.currentLocalUrl = recovered.localUrl || state.currentLocalUrl || 'http://127.0.0.1:9200';
              state.lastHealthError = null;
              stateStore.saveState(state, log);
              if (state.currentTailnetUrl || state.currentShareUrl) {
                log('ok', '实例原地恢复成功，跳过重部署');
              } else {
                log('warn', '实例原地恢复成功，但未获得新的分享地址；将等待后续重新获取');
              }
            } else {
              state.currentShareUrl = null;
              stateStore.saveState(state, log);
              log('warn', '实例原地恢复失败，已清除失效分享地址，回退到完整续期/重部署流程');
              await renewFlow('available-but-local-unhealthy');
            }
          } else if (endpointUnhealthy) {
            log('warn', `本地服务正常，但可访问入口健康检查失败 (${endpointError})；跳过恢复/重部署，仅保留地址等待后续复检`);
            state.lastHealthError = `share:${endpointError}`;
            state.currentLocalUrl = localBaseUrl;
            stateStore.saveState(state, log);
          } else if (state.lastHealthError) {
            state.lastHealthError = null;
            stateStore.saveState(state, log);
          }
        } else if (currentStatus === 'AVAILABLE' && !currentBaseUrl) {
          const lastDeployAt = Number(state.lastDeployAt || 0);
          const missingSinceLastDeploy = lastDeployAt > 0 ? (now - lastDeployAt) : Number.POSITIVE_INFINITY;

          if (missingSinceLastDeploy < MISSING_SHARE_URL_RETRY_MS) {
            const waitSec = Math.max(1, Math.ceil((MISSING_SHARE_URL_RETRY_MS - missingSinceLastDeploy) / 1000));
            log('warn', `实例缺少分享地址；暂不重部署，等待 tunnel 输出（约 ${waitSec}s 后再试）`);
          } else {
            log('warn', '实例长时间缺少分享地址；先尝试实例内原地探测 tunnel 状态');
            const recovered = await recoverAvailableInstance();
            if (recovered.success && (recovered.tailnetUrl || recovered.shareUrl)) {
              state.currentShareUrl = recovered.shareUrl || state.currentShareUrl || null;
              state.currentTailnetUrl = recovered.tailnetUrl || state.currentTailnetUrl || null;
              state.currentLocalUrl = recovered.localUrl || currentLocalUrl || state.currentLocalUrl || 'http://127.0.0.1:9200';
              state.lastHealthError = null;
              stateStore.saveState(state, log);
              log('ok', '实例原地探测成功，已恢复可访问入口');
            } else if (recovered.tunnelMissing) {
              state.currentShareUrl = null;
              state.currentTailnetUrl = recovered.tailnetUrl || state.currentTailnetUrl || null;
              state.currentLocalUrl = recovered.localUrl || currentLocalUrl || state.currentLocalUrl || 'http://127.0.0.1:9200';
              state.lastHealthError = 'missing shareUrl';
              stateStore.saveState(state, log);
              log('warn', '实例内服务正常，但 tunnel 地址仍未产出；暂不重部署，等待下一轮再探测');
            } else {
              log('warn', '实例缺少分享地址，且原地探测未恢复；尝试自动重新部署');
              await renewFlow('available-without-share-url');
            }
          }
        } else if (remaining > 0 && remaining < config.renewBefore) {
          log('clock', `⏰ 即将到期 (剩余 ${remainMin}min)`);
          await renewFlow('expiring');
        } else if (remaining <= 0) {
          log('error', '❌ 实例已过期!');
          await renewFlow('expired');
        }
      } catch (e) {
        log('error', '主循环异常:', e.message);
      }

      if (once) break;
      await sleep(config.checkInterval);
    }
  }

  return { waitForReady, deployKeyPool, fetchNewApiKey, recoverAvailableInstance, renewFlow, cmdStatus, cmdDeploy, runLoop };
}

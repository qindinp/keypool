import { DeployClient } from './deploy-client.mjs';
import { pushKeyExchange } from './key-exchange.mjs';
import { withRetry, sleep } from './utils.mjs';
import { probeHealth } from '../relay/proxy.mjs';

const MISSING_SHARE_URL_RETRY_MS = 5 * 60 * 1000;

function parseDeployResult(reply) {
  const text = String(reply || '');
  const normalized = text.replace(/\r/g, '');
  const shareUrlLineMatch = normalized.match(/(?:^|\n)SHARE_URL\s*[=:]\s*(https?:\/\/[^\s`"'<>]+)/i);
  const labeledShareUrl = shareUrlLineMatch ? shareUrlLineMatch[1] : null;
  const candidateUrls = Array.from(normalized.matchAll(/https?:\/\/[^\s`"'<>]+/g)).map(m => m[0]);
  const shareUrl = [labeledShareUrl, ...candidateUrls]
    .map(url => normalizeShareUrl(url))
    .filter(Boolean)
    .sort((a, b) => getShareUrlPriority(a) - getShareUrlPriority(b))[0] || null;
  const localUrlMatch = normalized.match(/http:\/\/127\.0\.0\.1:9200(?:\/health)?/);
  const healthOk = /健康检查通过|LOCAL_OK/.test(normalized);
  const started = /服务已成功启动|SERVICE_RUNNING|SERVICE_RESTARTED/.test(normalized);

  return {
    shareUrl,
    localUrl: localUrlMatch ? localUrlMatch[0] : null,
    healthOk,
    started,
  };
}

function normalizeShareUrl(url) {
  if (!isValidShareUrl(url)) return null;
  return url.replace(/\/+$/, '');
}

function getShareUrlPriority(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
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
    if (host.endsWith('.lhr.life')) return true;
    if (host.endsWith('.serveo.net')) return true;
    if (host.endsWith('.localhost.run')) return true;
    return false;
  } catch {
    return false;
  }
}


export function createAccountWorker({ cookie, config, api, stateStore, log }) {
  async function waitForReady() {
    const start = Date.now();
    log('clock', '等待实例就绪...');

    while (Date.now() - start < config.readyTimeout) {
      try {
        const status = await api.getStatus(cookie);
        if (status.status === 'AVAILABLE') break;
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
        '请把这个项目拉取到本地工作区目录 keypool。',
        '不要覆盖 SOUL.md，不要修改任何全局安全配置。',
        '拉取完成后进入 keypool 目录，启动 node server.mjs。',
        '启动后检查 http://127.0.0.1:9200/health 是否可访问。',
        '如果服务会异步建立 SSH 隧道，请额外等待最多 25 秒，检查 keypool/.tunnel-url 是否出现。',
        '如果 keypool/.tunnel-url 存在，请读取其中地址并按 `SHARE_URL=<地址>` 单独输出一行。',
        '如果没有拿到对外地址，也请明确输出 `SHARE_URL_MISSING`。',
        `如果健康检查通过，请只回复 ${marker}_OK。`,
        `如果失败，请只回复 ${marker}_FAIL，并附上一句最短原因。`,
      ].join('\n');


      log('deploy', '下发部署请求...');
      const reply = await client.chat(deployPrompt, config.deployTimeout);
      const parsed = parseDeployResult(reply);

      if (reply?.includes(`${marker}_OK`)) {
        log('ok', 'KeyPool 部署成功，健康检查通过');
        if (parsed.shareUrl) log('info', `分享地址: ${parsed.shareUrl}`);
        return { success: true, reply, ...parsed };
      }
      if (reply?.includes(`${marker}_FAIL`)) {
        log('error', 'KeyPool 部署失败');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, ...parsed };
      }

      const strongSuccess = reply && (parsed.started || parsed.healthOk || !!parsed.localUrl);
      if (strongSuccess) {
        log('ok', 'KeyPool 部署成功（根据明确健康状态文本判定）');
        log('info', '回复:', reply?.slice(0, 500));
        if (parsed.shareUrl) log('info', `分享地址: ${parsed.shareUrl}`);
        return { success: true, reply, ...parsed };
      }

      log('error', '部署结果异常：未返回明确标记');
      log('info', '回复:', reply?.slice(0, 500));
      return { success: false, reply, ...parsed };
    } catch (e) {
      log('error', '部署失败:', e.message);
      return { success: false, reply: '', shareUrl: null, localUrl: null, healthOk: false, started: false };
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
        '4. 输出 `SSH_TUNNEL=running` 或 `SSH_TUNNEL=missing`，用于表示 ssh -R 隧道进程是否存在。',
        '5. 如可行，附带 /tmp/keypool.log 最后 20 行中的 tunnel/ssh 相关关键信息。',
        `如果最终本地健康检查通过，请只回复 ${marker}_OK，并附带最短状态摘要。`,
        `如果最终仍失败，请只回复 ${marker}_FAIL，并附带一句最短原因。`,
      ].join('\n');



      const reply = await client.chat(recoverPrompt, config.deployTimeout);
      const parsed = parseDeployResult(reply);

      if (!reply?.includes(`${marker}_OK`)) {
        log('warn', '实例原地探测/恢复失败');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, ...parsed };
      }

      const shareUrl = parsed.shareUrl || null;
      const localUrl = parsed.localUrl || 'http://127.0.0.1:9200';
      const localRecovered = parsed.healthOk || parsed.started || !!shareUrl || reply?.includes('LOCAL_OK') || reply?.includes('SERVICE_RUNNING') || reply?.includes('SERVICE_RESTARTED');
      if (!localRecovered) {
        log('warn', '实例原地探测未能确认本地服务健康恢复');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, shareUrl, localUrl, healthOk: false, started: parsed.started, tunnelMissing: false };
      }

      if (!shareUrl) {
        log('warn', '实例内服务已恢复，但未返回可对外访问的分享地址');
        log('info', '回复:', reply?.slice(0, 500));
        return { success: false, reply, shareUrl: null, localUrl, healthOk: true, started: parsed.started, tunnelMissing: true };
      }

      log('ok', `实例原地恢复成功 | 分享地址: ${shareUrl}`);
      return { success: true, reply, shareUrl, localUrl, healthOk: true, started: parsed.started, tunnelMissing: false };
    } catch (e) {
      log('warn', '实例原地探测失败:', e.message);
      return { success: false, reply: '', shareUrl: null, localUrl: null, healthOk: false, started: false, tunnelMissing: false };
    } finally {
      client.close();
    }
  }

  async function renewFlow(reason) {
    log('rocket', `开始续期流程 (${reason})`);

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
      return false;
    }

    const deployResult = await deployKeyPool();
    if (!deployResult.success) {
      log('error', 'KeyPool 部署失败');
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
    let effectiveShareUrl = deployResult.shareUrl || null;
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
    state.currentLocalUrl = deployResult.localUrl || 'http://127.0.0.1:9200';
    state.history = state.history || [];
    state.history.push({
      at: new Date().toISOString(),
      reason,
      expireTime: newStatus.expireTime,
      key: newKey ? newKey.slice(0, 20) + '...' : null,
      shareUrl: effectiveShareUrl,
      localUrl: deployResult.localUrl || 'http://127.0.0.1:9200',
      success: true,
    });
    if (state.history.length > 50) state.history = state.history.slice(-50);
    state.lastHealthError = null;
    stateStore.saveState(state, log);

    if (effectiveShareUrl) {
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
    const state = stateStore.loadState();

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
      try {
        const status = await api.getStatus(cookie);
        const now = Date.now();
        const expireTime = Number(status.expireTime || 0);
        const hasExpireTime = Number.isFinite(expireTime) && expireTime > 0;
        const remaining = hasExpireTime ? (expireTime - now) : -1;
        const remainMin = hasExpireTime ? Math.round(remaining / 60_000) : null;

        const currentStatus = status.status || 'UNKNOWN';
        const currentShareUrl = state.currentShareUrl || null;
        const currentLocalUrl = state.currentLocalUrl || null;
        const hasDeployment = Boolean(state.lastDeployAt) && Boolean(currentShareUrl || currentLocalUrl);
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
        } else if (currentStatus === 'AVAILABLE' && currentShareUrl) {
          const health = await probeHealth({ baseUrl: currentShareUrl, timeoutMs: 15_000 });
          endpointUnhealthy = !health.ok;
          endpointError = health.error || `health ${health.statusCode}`;
          if (endpointUnhealthy) {
            log('warn', `分享地址健康检查失败 (${endpointError})，先尝试实例内原地恢复`);
            state.lastHealthError = endpointError;
            stateStore.saveState(state, log);

            const recovered = await recoverAvailableInstance();
            if (recovered.success) {
              state.currentShareUrl = recovered.shareUrl || null;
              state.currentLocalUrl = recovered.localUrl || state.currentLocalUrl || 'http://127.0.0.1:9200';
              state.lastHealthError = null;
              stateStore.saveState(state, log);
              if (state.currentShareUrl) {
                log('ok', '实例原地恢复成功，跳过重部署');
              } else {
                log('warn', '实例原地恢复成功，但未获得新的分享地址；将等待后续重新获取');
              }
            } else {
              state.currentShareUrl = null;
              stateStore.saveState(state, log);
              log('warn', '实例原地恢复失败，已清除失效分享地址，回退到完整续期/重部署流程');
              await renewFlow('available-but-unhealthy');
            }
          } else if (state.lastHealthError) {
            state.lastHealthError = null;
            stateStore.saveState(state, log);
          }
        } else if (currentStatus === 'AVAILABLE' && !currentShareUrl) {
          const lastDeployAt = Number(state.lastDeployAt || 0);
          const missingSinceLastDeploy = lastDeployAt > 0 ? (now - lastDeployAt) : Number.POSITIVE_INFINITY;

          if (missingSinceLastDeploy < MISSING_SHARE_URL_RETRY_MS) {
            const waitSec = Math.max(1, Math.ceil((MISSING_SHARE_URL_RETRY_MS - missingSinceLastDeploy) / 1000));
            log('warn', `实例缺少分享地址；暂不重部署，等待 tunnel 输出（约 ${waitSec}s 后再试）`);
          } else {
            log('warn', '实例长时间缺少分享地址；先尝试实例内原地探测 tunnel 状态');
            const recovered = await recoverAvailableInstance();
            if (recovered.success && recovered.shareUrl) {
              state.currentShareUrl = recovered.shareUrl;
              state.currentLocalUrl = recovered.localUrl || currentLocalUrl || state.currentLocalUrl || 'http://127.0.0.1:9200';
              state.lastHealthError = null;
              stateStore.saveState(state, log);
              log('ok', '实例原地探测成功，已恢复分享地址');
            } else if (recovered.tunnelMissing) {
              state.currentShareUrl = null;
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

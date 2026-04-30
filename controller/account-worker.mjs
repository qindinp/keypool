import { DeployClient } from './deploy-client.mjs';
import { pushKeyExchange } from './key-exchange.mjs';
import { withRetry, sleep } from './utils.mjs';

function parseDeployResult(reply) {
  const text = String(reply || '');
  const shareUrlMatch = text.match(/https:\/\/[^\s`]+/);
  const localUrlMatch = text.match(/http:\/\/127\.0\.0\.1:9200(?:\/health)?/);
  const healthOk = /健康检查通过/.test(text);
  const started = /服务已成功启动/.test(text);

  return {
    shareUrl: shareUrlMatch ? shareUrlMatch[0] : null,
    localUrl: localUrlMatch ? localUrlMatch[0] : null,
    healthOk,
    started,
  };
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
        '如果服务额外提供了可对外访问的分享地址，请一并返回该地址。',
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
    state.lastExpireTime = newStatus.expireTime;
    state.lastDeployAt = Date.now();
    state.deployCount = (state.deployCount || 0) + 1;
    if (newKey) state.currentKey = newKey;
    state.currentShareUrl = deployResult.shareUrl || state.currentShareUrl || null;
    state.currentLocalUrl = deployResult.localUrl || 'http://127.0.0.1:9200';
    state.history = state.history || [];
    state.history.push({
      at: new Date().toISOString(),
      reason,
      expireTime: newStatus.expireTime,
      key: newKey ? newKey.slice(0, 20) + '...' : null,
      shareUrl: deployResult.shareUrl || null,
      localUrl: deployResult.localUrl || 'http://127.0.0.1:9200',
      success: true,
    });
    if (state.history.length > 50) state.history = state.history.slice(-50);
    stateStore.saveState(state, log);

    if (deployResult.shareUrl) {
      log('ok', `✨ 第 ${state.deployCount} 次续期完成 | 分享地址: ${deployResult.shareUrl}`);
    } else {
      log('ok', `✨ 第 ${state.deployCount} 次续期完成 | 本地地址: ${state.currentLocalUrl}`);
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

  return { waitForReady, deployKeyPool, fetchNewApiKey, renewFlow, cmdStatus, cmdDeploy, runLoop };
}

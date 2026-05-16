/**
 * Deployer — 部署 Tunnel Proxy 到 MiMo 沙箱实例
 *
 * 流程：
 * 1. 通过 DeployClient 连接到沙箱 OpenClaw
 * 2. 读取 skill/ 目录中的静态文件，替换模板变量
 * 3. 让沙箱创建 tunnel-proxy skill（写入文件 + 验证）
 * 4. 启动 tunnel proxy（后台运行）
 * 5. 等待 Gateway 收到 tunnel 连接 → 实例自动变为 ACTIVE
 *
 * v3.1 变更：
 * - 删除 generateTunnelProxyCode()，改为读取 skill/ 静态文件
 * - 新增沙箱拒绝部署的降级处理（cat → base64 -d, nohup → bash -c）
 * - 不注入 API Key，tunnel proxy 自行从沙箱 OpenClaw 配置读取
 */

import { DeployClient } from './deploy-client.mjs';
import { createMimoApi } from './instance.mjs';
import {
  SKILL_DIR, SCRIPT_DIR,
  readSkillFiles, planFileWrites, buildChunkPrompt,
  buildCreateSkillPrompt, buildFallbackCreatePrompt,
  buildStartProxyPrompt, buildInstallPrompt, buildStartPrompt,
} from './skill-installer.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 拒绝识别模式
const REFUSE_PATTERNS = [
  /拒绝执行/i,
  /无法执行/i,
  /安全策略/i,
  /高风险操作/i,
  /not allowed/i,
  /permission denied/i,
  /policy.*denied/i,
];

function buildStageMarkers(accountId) {
  const runId = `${accountId}-${Date.now().toString(36)}`;
  return {
    create: `KEYPOOL_TUNNEL_CREATED_${runId}`,
    start: `KEYPOOL_TUNNEL_STARTED_${runId}`,
    runId,
  };
}

export async function waitForTunnelRegistration({ registry, accountId, runId, timeoutMs = 180_000, intervalMs = 1_000 }) {
  if (!registry || typeof registry.getInstanceState !== 'function') {
    throw new Error('Missing registry for tunnel registration wait');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = registry.getInstanceState(accountId);
    const hasTunnel = !!state?.tunnel;
    const runMatches = !runId || !state?.tunnelRunId || state.tunnelRunId === runId;
    if (hasTunnel && runMatches && state.verified !== false && state.healthOk !== false) {
      return state;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for tunnel registration accountId=${accountId} runId=${runId || '-'}`);
}

function classifyDeployError(err) {
  const message = err?.message || String(err || 'unknown error');
  const lower = message.toLowerCase();
  const timedOut = /timeout|超时/.test(lower);
  const refused = REFUSE_PATTERNS.some(p => p.test(message));
  const disconnected = /socket closed|ws .*1002|not connected|websocket/.test(lower);
  const unavailable = /资源当前不可用|resource.*unavailable|ticket/.test(lower);

  let failureType = 'unknown';
  if (timedOut) failureType = 'timeout';
  else if (refused) failureType = 'refused';
  else if (disconnected) failureType = 'disconnected';
  else if (unavailable) failureType = 'upstream_unavailable';

  return { message, failureType, timedOut, refused, disconnected, unavailable, retryable: !refused };
}

function getUsableTunnelState(registry, accountId, runId = null) {
  if (!registry || typeof registry.getInstanceState !== 'function') return null;
  const state = registry.getInstanceState(accountId);
  if (!state?.tunnel || state.verified === false || state.healthOk === false) return null;
  if (runId && state.tunnelRunId && state.tunnelRunId !== runId) return null;
  return state;
}

function markTunnelAdoptedResult(result, tunnelState, stage, accountId) {
  result.ok = true;
  result.created = true;
  result.started = true;
  result.verified = true;
  result.healthOk = true;
  result.failureType = null;
  result.lastError = null;
  result.retryable = true;
  result.stage = stage;
  result.stageStatus = 'ok';
  result.confirmationSource = 'tunnel-registration';
  result.timeline.push({
    at: new Date().toISOString(),
    stage,
    status: 'ok',
    confirmationSource: 'tunnel-registration',
    tunnelRunId: tunnelState?.tunnelRunId || null,
    tunnelConnectedAt: tunnelState?.tunnelConnectedAt || null,
    note: `Adopted already registered tunnel for ${accountId}`,
  });
  return result;
}

async function runDeployStage({ client, log, accountId, stage, prompt, timeoutMs, matchText }) {
  try {
    const response = await client.chat(prompt, {
      timeoutMs,
      matchText,
      requireMatch: true,
      useHistoryFallback: true,
      historyLimit: 12,
      sessionKey: `deploy-${stage}-${accountId}-${Date.now().toString(36)}`,
    });
    return {
      ok: true, stage, status: 'ok', matchText,
      confirmationSource: response?.confirmationSource || 'live',
      sessionKey: response?.sessionKey || null,
      responseText: response?.text || '',
    };
  } catch (err) {
    const meta = classifyDeployError(err);
    return {
      ok: false, stage,
      status: meta.timedOut ? 'timeout' : meta.refused ? 'refused' : 'failed',
      matchText, confirmationSource: 'none', sessionKey: null, responseText: '',
      ...meta,
    };
  }
}

export function createDeployer(config) {
  const api = createMimoApi({ sleep });
  const deployQueues = new Map();

  function enqueueDeploy(accountId, task) {
    const previous = deployQueues.get(accountId) || Promise.resolve();
    const run = async () => {
      console.log(`[INFO] [deploy:${accountId}] 等待账号级部署锁`);
      return task();
    };
    const next = previous.then(run, run);
    const guarded = next.catch(() => {});
    deployQueues.set(accountId, guarded);
    guarded.finally(() => {
      if (deployQueues.get(accountId) === guarded) {
        deployQueues.delete(accountId);
      }
    });
    return next;
  }

  async function deploy(account) {
    return enqueueDeploy(account.id, async () => {
      const log = (level, ...args) => console.log(`[${level.toUpperCase()}] [deploy:${account.id}]`, ...args);

      const client = new DeployClient({
        cookie: account.cookie,
        getTicket: api.getTicket,
        config: {
          wsConnectTimeout: config.wsConnectTimeout || 30_000,
          chatTimeout: config.chatTimeout || 180_000,
        },
        log,
      });

      const markers = buildStageMarkers(account.id);
      const gatewayWsUrl = config.gatewayUrl || 'wss://pc-20250301fuan.tail59e491.ts.net/tunnel';

      const result = {
        ok: false,
        deployMode: 'tunnel',
        proxyUrl: null, // tunnel 模式不需要 proxyUrl，通过 WS 转发
        created: false,
        started: false,
        healthOk: false,
        verified: false,
        stage: 'init',
        stageStatus: 'pending',
        retryable: true,
        failureType: null,
        lastError: null,
        timeline: [],
        runId: markers.runId,
        refuseMeta: null,
      };

      const markStage = (stage, status, extra = {}) => {
        result.stage = stage;
        result.stageStatus = status;
        Object.assign(result, extra);
        result.timeline.push({ at: new Date().toISOString(), stage, status, ...extra });
      };

      try {
        // 阶段 1: 连接
        markStage('connect', 'running');
        log('info', '连接沙箱 OpenClaw...');
        await client.connect();
        markStage('connect', 'ok');
        log('ok', '已连接到沙箱');

        // 阶段 2: 安装 skill（通过 clawhub 官方渠道）
        log('info', '通过 clawhub 安装 keypool-tunnel skill...');
        markStage('install', 'running');

        const installPrompt = buildInstallPrompt(markers.create);
        log('info', `Install prompt size: ${Buffer.byteLength(installPrompt, 'utf-8')} bytes`);

        const installStage = await runDeployStage({
          client, log, accountId: account.id, stage: 'install',
          prompt: installPrompt,
          timeoutMs: 120_000, matchText: markers.create,
        });

        if (!installStage.ok) {
          const tunnelState = getUsableTunnelState(config.registry, account.id);
          if (tunnelState) {
            log('ok', `检测到 Gateway 已有可用 tunnel 注册，忽略 install marker 失败并采用该连接 (runId=${tunnelState.tunnelRunId || '-'})`);
            return markTunnelAdoptedResult(result, tunnelState, 'install', account.id);
          }

          markStage('install', installStage.status, {
            retryable: installStage.retryable, failureType: installStage.failureType,
            lastError: installStage.message, confirmationSource: installStage.confirmationSource,
            responseText: installStage.responseText, sessionKey: installStage.sessionKey,
          });
          const err = new Error(installStage.message);
          err.deployResult = result;
          throw err;
        }
        result.created = true;
        markStage('install', 'ok', {
          confirmationSource: installStage.confirmationSource,
          responseText: installStage.responseText, sessionKey: installStage.sessionKey,
        });
        log('ok', 'skill 安装完成');

        // 阶段 3: 启动 tunnel proxy
        log('info', '启动 tunnel proxy...');
        markStage('start', 'running');

        const startPrompt = buildStartPrompt(markers.start, gatewayWsUrl, account.id, markers.runId);

        const startStage = await runDeployStage({
          client, log, accountId: account.id, stage: 'start',
          prompt: startPrompt,
          timeoutMs: 60_000, matchText: markers.start,
        });

        if (!startStage.ok) {
          const tunnelState = getUsableTunnelState(config.registry, account.id, markers.runId) || getUsableTunnelState(config.registry, account.id);
          if (tunnelState) {
            log('ok', `检测到 Gateway 已有可用 tunnel 注册，忽略 start marker 失败并采用该连接 (runId=${tunnelState.tunnelRunId || '-'})`);
            return markTunnelAdoptedResult(result, tunnelState, 'start', account.id);
          }

          markStage('start', startStage.status, {
            retryable: startStage.retryable, failureType: startStage.failureType,
            lastError: startStage.message, confirmationSource: startStage.confirmationSource,
            responseText: startStage.responseText, sessionKey: startStage.sessionKey,
          });
          const err = new Error(startStage.message);
          err.deployResult = result;
          throw err;
        }
        result.started = true;
        markStage('start', 'ok', {
          confirmationSource: startStage.confirmationSource,
          responseText: startStage.responseText, sessionKey: startStage.sessionKey,
        });
        log('ok', 'tunnel proxy 启动完成');

        // 阶段 4: 等待 tunnel register 成为正式成功信号
        log('info', '等待远端 tunnel 连接到 Gateway...');
        markStage('tunnel-wait', 'running');

        const tunnelState = await waitForTunnelRegistration({
          registry: config.registry,
          accountId: account.id,
          runId: markers.runId,
          timeoutMs: config.readyTimeout || 180_000,
          intervalMs: 1_000,
        });

        result.ok = true;
        result.verified = true;
        result.healthOk = true;
        markStage('tunnel-wait', 'ok', {
          tunnelRunId: tunnelState.tunnelRunId || markers.runId,
          tunnelConnectedAt: tunnelState.tunnelConnectedAt || new Date().toISOString(),
        });
        log('ok', '远端 tunnel 已注册到 Gateway');

        return result;
      } catch (err) {
        if (!err.deployResult) err.deployResult = result;
        log('error', `部署失败 [${result.stage}/${result.stageStatus}]:`, result.lastError || err.message);
        throw err;
      } finally {
        client.close();
      }
    });
  }

  return { deploy };
}

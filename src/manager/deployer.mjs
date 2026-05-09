/**
 * Deployer — 部署 Tunnel Proxy 到 MiMo 沙箱实例
 *
 * 流程：
 * 1. 通过 DeployClient 连接到沙箱 OpenClaw
 * 2. 让沙箱创建 tunnel-proxy skill（WS 反连回 Gateway）
 * 3. 写入 tunnel proxy 代码
 * 4. 启动 tunnel proxy（后台运行）
 * 5. 等待 Gateway 收到 tunnel 连接 → 实例自动变为 ACTIVE
 *
 * 与旧方案的区别：
 * - 旧：远端 HTTP proxy + Gateway 主动连远端（不可达）
 * - 新：远端 WS client 主动连回 Gateway（可达）
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployClient } from './deploy-client.mjs';
import { createMimoApi } from './instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SKILL_NAME = 'keypool-tunnel';
const SKILL_DIR = `/root/.openclaw/skills/${SKILL_NAME}`;
const SCRIPT_DIR = `${SKILL_DIR}/scripts`;
const PROXY_PATH = `${SCRIPT_DIR}/tunnel-proxy.mjs`;

function buildStageMarkers(accountId) {
  const runId = `${accountId}-${Date.now().toString(36)}`;
  return {
    create: `KEYPOOL_TUNNEL_CREATED_${runId}`,
    start: `KEYPOOL_TUNNEL_STARTED_${runId}`,
    runId,
  };
}

function classifyDeployError(err) {
  const message = err?.message || String(err || 'unknown error');
  const lower = message.toLowerCase();
  const timedOut = /timeout|超时/.test(lower);
  const refused = /拒绝|不能执行|无法执行|安全策略|高风险|not allowed|policy|permission denied/.test(lower);
  const disconnected = /socket closed|ws .*1002|not connected|websocket/.test(lower);
  const unavailable = /资源当前不可用|resource.*unavailable|ticket/.test(lower);

  let failureType = 'unknown';
  if (timedOut) failureType = 'timeout';
  else if (refused) failureType = 'refused';
  else if (disconnected) failureType = 'disconnected';
  else if (unavailable) failureType = 'upstream_unavailable';

  return { message, failureType, timedOut, refused, disconnected, unavailable, retryable: !refused };
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

/**
 * 生成 Tunnel Proxy 代码
 * 这段代码运行在远端沙箱实例上，通过 WS 反连回 Gateway
 *
 * @param {string} accountId
 * @param {string} gatewayWsUrl - Gateway 的 WS 地址 (ws://IP:PORT/tunnel)
 * @param {string} runId - 本次部署的唯一标识
 */
function generateTunnelProxyCode(accountId, gatewayWsUrl, runId) {
  // 用模板字符串生成，避免转义地狱
  return `#!/usr/bin/env node
/**
 * KeyPool Tunnel Proxy
 * 主动 WebSocket 反连 Gateway，接收并执行 API 请求
 */
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';

// ─── 配置 ──────────────────────────────────────────────────
const ACCOUNT_ID = ${JSON.stringify(accountId)};
const GATEWAY_WS_URL = ${JSON.stringify(gatewayWsUrl)};
const RUN_ID = ${JSON.stringify(runId)};

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const env = {};
  for (const line of content.split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const instanceEnv = readEnvFile('/root/.openclaw/.env');
const apiKey = process.env.MIMO_API_KEY || instanceEnv.MIMO_API_KEY;
if (!apiKey) { console.error('MIMO_API_KEY missing'); process.exit(1); }

const baseUrl = (process.env.MIMO_BASE_URL || instanceEnv.MIMO_BASE_URL || 'https://api-oc.xiaomimimo.com/v1').replace(/\\/$/, '');

console.log('[tunnel-proxy] baseUrl:', baseUrl);
console.log('[tunnel-proxy] hasKey:', !!apiKey);

// ─── 读取内置 ws 模块 ─────────────────────────────────────
let WebSocket;
try {
  const wsMod = await import('ws');
  WebSocket = wsMod.default || wsMod;
} catch {
  console.error('ws module not found, installing...');
  const { execSync } = await import('node:child_process');
  execSync('npm install ws', { stdio: 'inherit' });
  const wsMod = await import('ws');
  WebSocket = wsMod.default || wsMod;
}

// ─── HTTP 请求执行 ─────────────────────────────────────────
function handleProxyRequest(req) {
  return new Promise((resolve) => {
    const targetPath = req.path || '/v1/chat/completions';
    const target = new URL(targetPath, baseUrl);
    const headers = { ...(req.headers || {}) };
    delete headers.host;
    delete headers['content-length'];
    headers['authorization'] = 'Bearer ' + apiKey;
    headers['accept-encoding'] = 'identity';

    const proxyReq = httpsRequest({
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      method: req.method || 'POST',
      headers,
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const respHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (Array.isArray(value)) respHeaders[key] = value.join(', ');
          else if (value) respHeaders[key] = value;
        }
        resolve({
          type: 'proxy_response',
          id: req.id,
          status: proxyRes.statusCode,
          headers: respHeaders,
          body,
        });
      });
    });

    proxyReq.on('error', (err) => {
      resolve({
        type: 'proxy_error',
        id: req.id,
        error: err.message,
      });
    });

    proxyReq.setTimeout(120_000, () => {
      proxyReq.destroy(new Error('upstream timeout'));
    });

    if (req.body) proxyReq.write(req.body);
    proxyReq.end();
  });
}

// ─── WebSocket 连接 ────────────────────────────────────────
let ws = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connect() {
  const url = GATEWAY_WS_URL + '?accountId=' + encodeURIComponent(ACCOUNT_ID) + '&runId=' + encodeURIComponent(RUN_ID);
  console.log('[tunnel-proxy] 连接 Gateway:', url);

  ws = new WebSocket(url, {
    headers: { 'User-Agent': 'KeyPool-Tunnel-Proxy/1.0' },
  });

  ws.on('open', () => {
    console.log('[tunnel-proxy] 已连接到 Gateway');
    reconnectDelay = 1000;

    // 注册
    ws.send(JSON.stringify({
      type: 'register',
      accountId: ACCOUNT_ID,
      runId: RUN_ID,
    }));
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'registered') {
      console.log('[tunnel-proxy] 注册成功, accountId:', msg.accountId);
      return;
    }

    if (msg.type === 'proxy_request') {
      try {
        const response = await handleProxyRequest(msg);
        ws.send(JSON.stringify(response));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'proxy_error',
          id: msg.id,
          error: err.message,
        }));
      }
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[tunnel-proxy] 连接关闭:', code, reason?.toString());
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[tunnel-proxy] WS 错误:', err.message);
  });
}

function scheduleReconnect() {
  console.log('[tunnel-proxy] ' + reconnectDelay + 'ms 后重连...');
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

// ─── 启动 ──────────────────────────────────────────────────
connect();

process.on('SIGINT', () => { if (ws) ws.close(); process.exit(0); });
process.on('SIGTERM', () => { if (ws) ws.close(); process.exit(0); });
`;
}

function buildCreateSkillPrompt(proxyCode, marker, skillName) {
  const escapedCode = proxyCode.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

  return [
    '请帮我在本机创建一个 OpenClaw skill，用于运行 Tunnel Proxy（WebSocket 反连代理）。',
    '',
    '请严格按顺序执行以下步骤：',
    '',
    '步骤 1：创建 skill 目录',
    '```bash',
    `mkdir -p ${SCRIPT_DIR}`,
    '```',
    '',
    '步骤 2：写入 SKILL.md',
    '```bash',
    `cat > ${SKILL_DIR}/SKILL.md << 'SKILLEOF'`,
    '---',
    `name: ${skillName}`,
    'version: 0.2.0',
    'description: KeyPool Tunnel Proxy (WebSocket reverse tunnel)',
    '---',
    '# KeyPool Tunnel Proxy',
    'WebSocket 反连代理，主动连接 Gateway 接收 API 请求',
    'SKILLEOF',
    '```',
    '',
    '步骤 3：写入 tunnel proxy 代码',
    '```bash',
    `cat > ${PROXY_PATH} << 'PROXYEOF'`,
    escapedCode,
    'PROXYEOF',
    '```',
    '',
    '步骤 4：验证文件存在和语法',
    '```bash',
    `test -f ${PROXY_PATH}`,
    `node --check ${PROXY_PATH}`,
    `echo ${marker}`,
    '```',
    '',
    `如果上述步骤执行成功，只回复 ${marker}。失败请回复实际错误。`,
  ].join('\n');
}

function buildStartProxyPrompt(marker) {
  return [
    '请启动刚才创建的 Tunnel Proxy 服务。',
    '',
    '请严格按顺序执行以下命令：',
    '```bash',
    `cd ${SCRIPT_DIR}`,
    'pkill -f "tunnel-proxy.mjs" 2>/dev/null || true',
    'sleep 1',
    'nohup node tunnel-proxy.mjs > tunnel-proxy.log 2>&1 &',
    'sleep 2',
    'if pgrep -f "tunnel-proxy.mjs" >/dev/null; then',
    `  echo ${marker}`,
    'else',
    '  echo "FAILED: process not running"',
    '  cat tunnel-proxy.log 2>/dev/null',
    'fi',
    '```',
    '',
    `如果启动命令已执行成功，只回复 ${marker}。失败请回复实际错误。`,
  ].join('\n');
}

export function createDeployer(config) {
  const api = createMimoApi({ sleep });
  let deployQueue = Promise.resolve();

  function enqueueDeploy(accountId, task) {
    const run = async () => {
      console.log(`[INFO] [deploy:${accountId}] 等待全局部署锁`);
      return task();
    };
    const next = deployQueue.then(run, run);
    deployQueue = next.catch(() => {});
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
      const gatewayWsUrl = config.gatewayUrl || `ws://127.0.0.1:${process.env.PORT || 9300}/tunnel`;
      const proxyCode = generateTunnelProxyCode(account.id, gatewayWsUrl, markers.runId);

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

        // 阶段 2: 创建 skill + 写入代码
        log('info', `创建 tunnel proxy skill (${proxyCode.length} bytes)...`);
        markStage('create', 'running');
        const createStage = await runDeployStage({
          client, log, accountId: account.id, stage: 'create',
          prompt: buildCreateSkillPrompt(proxyCode, markers.create, SKILL_NAME),
          timeoutMs: 120_000, matchText: markers.create,
        });
        if (!createStage.ok) {
          markStage('create', createStage.status, {
            retryable: createStage.retryable, failureType: createStage.failureType,
            lastError: createStage.message, confirmationSource: createStage.confirmationSource,
            responseText: createStage.responseText, sessionKey: createStage.sessionKey,
          });
          const err = new Error(createStage.message);
          err.deployResult = result;
          throw err;
        }
        result.created = true;
        markStage('create', 'ok', {
          confirmationSource: createStage.confirmationSource,
          responseText: createStage.responseText, sessionKey: createStage.sessionKey,
        });
        log('ok', 'Tunnel Proxy 代码已写入');

        // 阶段 3: 启动
        log('info', '启动 tunnel proxy...');
        markStage('start', 'running');
        const startStage = await runDeployStage({
          client, log, accountId: account.id, stage: 'start',
          prompt: buildStartProxyPrompt(markers.start),
          timeoutMs: 60_000, matchText: markers.start,
        });
        if (!startStage.ok) {
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
        log('ok', 'Tunnel Proxy 启动命令已执行');

        // 阶段 4: 等待 tunnel 连接（由 Scheduler 或 AccountWorker 轮询确认）
        // 这里不阻塞等待，因为 tunnel 连接是异步的
        // Scheduler 下次 tick 时会检查 registry 中是否有 tunnel 连接
        result.ok = true;
        result.verified = false; // 需要等 tunnel 连接后才 verified
        result.healthOk = false;
        markStage('tunnel-wait', 'pending');
        log('info', '等待远端 tunnel 连接到 Gateway...');

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

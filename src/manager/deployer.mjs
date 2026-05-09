/**
 * Deployer — 通过 Skill 方式部署 API 代理到 MiMo 沙箱实例
 *
 * 流程：
 * 1. 通过 DeployClient 连接到沙箱 OpenClaw
 * 2. 让沙箱在 ~/.openclaw/skills/ 创建 keypool-proxy skill
 * 3. 写入 skill-proxy/server.mjs 到远端 skill 目录
 * 4. 启动代理服务（localhost:9200）
 * 5. 校验 localhost:9200/health
 *
 * 设计目标：
 * - 部署步骤分阶段可观测
 * - 不把“命令发出成功”等同于“实例已 ACTIVE”
 * - 返回结构化结果，交由 AccountWorker 决定状态推进
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeployClient } from './deploy-client.mjs';
import { createMimoApi } from './instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROXY_PORT = 9200;
const SKILL_NAME = 'keypool-proxy';
const SKILL_DIR = `/root/.openclaw/skills/${SKILL_NAME}`;
const SCRIPT_DIR = `${SKILL_DIR}/scripts`;
const SERVER_PATH = `${SCRIPT_DIR}/server.mjs`;

function buildStageMarkers(accountId) {
  const runId = `${accountId}-${Date.now().toString(36)}`;
  return {
    create: `KEYPOOL_SKILL_CREATED_${runId}`,
    start: `KEYPOOL_PROXY_STARTED_${runId}`,
    health: `KEYPOOL_PROXY_HEALTHY_${runId}`,
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

  const retryable = !refused;

  return {
    message,
    failureType,
    timedOut,
    refused,
    disconnected,
    unavailable,
    retryable,
  };
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
      ok: true,
      stage,
      status: 'ok',
      matchText,
      confirmationSource: response?.confirmationSource || 'live',
      sessionKey: response?.sessionKey || null,
      responseText: response?.text || '',
    };
  } catch (err) {
    const meta = classifyDeployError(err);
    return {
      ok: false,
      stage,
      status: meta.timedOut ? 'timeout' : meta.refused ? 'refused' : 'failed',
      matchText,
      confirmationSource: 'none',
      sessionKey: null,
      responseText: '',
      ...meta,
    };
  }
}


function loadServerCode() {
  const localPath = resolve(__dirname, '..', '..', 'skill-proxy', 'server.mjs');
  try {
    return readFileSync(localPath, 'utf-8');
  } catch {}

  return `#!/usr/bin/env node
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
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

const baseUrl = (process.env.MIMO_BASE_URL || instanceEnv.MIMO_BASE_URL || 'https://api-oc.xiaomimimo.com/v1').replace(/\/$/, '');
const PORT = parseInt(process.env.KEYPOOL_PROXY_PORT || '${PROXY_PORT}');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', baseUrl, hasKey: !!apiKey }));
    return;
  }

  if (url.pathname.startsWith('/v1/')) {
    const body = req.method === 'GET' ? null : await readBody(req);
    const target = new URL(url.pathname + url.search, baseUrl);
    const proxyReq = httpsRequest({
      hostname: target.hostname, port: 443,
      path: target.pathname + target.search,
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'authorization': 'Bearer ' + apiKey,
        'accept-encoding': 'identity',
      },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'content-type': proxyRes.headers['content-type'] || 'application/json',
        'cache-control': 'no-cache',
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
    proxyReq.setTimeout(120000, () => proxyReq.destroy(new Error('timeout')));
    if (body) proxyReq.write(body);
    proxyReq.end();
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: 'KeyPool Proxy', version: '0.1.0', port: PORT }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('KeyPool Proxy on http://127.0.0.1:' + PORT);
});
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;
}

function buildCreateSkillPrompt(serverCode, marker) {
  const escapedServerCode = serverCode.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

  return [
    '请帮我在本机创建一个 OpenClaw skill，用于运行 MiMo API 代理服务。',
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
    `cat > ${SKILL_DIR}/SKILL.md << \'SKILLEOF\'`,
    '---',
    `name: ${SKILL_NAME}`,
    'version: 0.1.0',
    'description: MiMo API proxy on localhost:9200',
    '---',
    '# KeyPool Proxy',
    'MiMo API 代理服务，运行在 localhost:9200',
    'SKILLEOF',
    '```',
    '',
    '步骤 3：直接写入代理服务器代码',
    '```bash',
    `cat > ${SERVER_PATH} << \'SERVEREOF\'`,
    escapedServerCode,
    'SERVEREOF',
    '```',
    '',
    '步骤 4：验证文件存在和语法',
    '```bash',
    `test -f ${SERVER_PATH}`,
    `node --check ${SERVER_PATH}`,
    `echo ${marker}`,
    '```',
    '',
    `如果上述步骤执行成功，只回复 ${marker}。失败请回复实际错误。`,
  ].join('\n');
}

function buildStartProxyPrompt(marker) {
  return [
    '请启动刚才创建的 MiMo API 代理服务。',
    '',
    '请严格按顺序执行以下命令：',
    '```bash',
    `cd ${SCRIPT_DIR}`,
    `if curl -fsS http://127.0.0.1:${PROXY_PORT}/health >/dev/null 2>&1; then`,
    `  echo ${marker}`,
    'else',
    '  node server.mjs > keypool-proxy.log 2>&1 &',
    '  sleep 2',
    `  curl -fsS http://127.0.0.1:${PROXY_PORT}/health >/dev/null`,
    `  echo ${marker}`,
    'fi',
    '```',
    '',
    `如果启动命令已执行成功，或者代理本来就在运行，只回复 ${marker}。失败请回复实际错误。`,
  ].join('\n');
}

function buildVerifyHealthPrompt(marker) {
  return [
    '请验证本机代理服务是否已健康运行。',
    '',
    '请严格按顺序执行以下命令：',
    '```bash',
    `curl -fsS http://127.0.0.1:${PROXY_PORT}/health`,
    `echo ${marker}`,
    '```',
    '',
    `如果 health 成功，只回复 ${marker}。失败请回复实际错误。`,
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
      const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;

      const client = new DeployClient({
        cookie: account.cookie,
        getTicket: api.getTicket,
        config: {
          wsConnectTimeout: config.wsConnectTimeout || 30_000,
          chatTimeout: config.chatTimeout || 180_000,
        },
        log,
      });

      const result = {
        ok: false,
        deployMode: 'skill-proxy',
        proxyUrl,
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
      };

      const markStage = (stage, status, extra = {}) => {
        result.stage = stage;
        result.stageStatus = status;
        Object.assign(result, extra);
        result.timeline.push({
          at: new Date().toISOString(),
          stage,
          status,
          ...extra,
        });
      };

      try {
        markStage('connect', 'running');
        log('info', '连接沙箱 OpenClaw...');
        await client.connect();
        markStage('connect', 'ok');
        log('ok', '已连接到沙箱');

        const serverCode = loadServerCode();
        const markers = buildStageMarkers(account.id);

        log('info', `创建 skill (${serverCode.length} bytes 代码)...`);
        markStage('create', 'running');
        const createStage = await runDeployStage({
          client,
          log,
          accountId: account.id,
          stage: 'create',
          prompt: buildCreateSkillPrompt(serverCode, markers.create),
          timeoutMs: 120_000,
          matchText: markers.create,
        });
        if (!createStage.ok) {
          markStage('create', createStage.status, {
            retryable: createStage.retryable,
            failureType: createStage.failureType,
            lastError: createStage.message,
            confirmationSource: createStage.confirmationSource,
            responseText: createStage.responseText,
            sessionKey: createStage.sessionKey,
          });
          const err = new Error(createStage.message);
          err.deployResult = result;
          throw err;
        }
        result.created = true;
        markStage('create', 'ok', {
          confirmationSource: createStage.confirmationSource,
          responseText: createStage.responseText,
          sessionKey: createStage.sessionKey,
        });
        log('ok', 'Skill 创建完成');

        log('info', '启动代理服务...');
        markStage('start', 'running');
        const startStage = await runDeployStage({
          client,
          log,
          accountId: account.id,
          stage: 'start',
          prompt: buildStartProxyPrompt(markers.start),
          timeoutMs: 60_000,
          matchText: markers.start,
        });
        if (!startStage.ok) {
          markStage('start', startStage.status, {
            retryable: startStage.retryable,
            failureType: startStage.failureType,
            lastError: startStage.message,
            confirmationSource: startStage.confirmationSource,
            responseText: startStage.responseText,
            sessionKey: startStage.sessionKey,
          });
          const err = new Error(startStage.message);
          err.deployResult = result;
          throw err;
        }
        result.started = true;
        markStage('start', 'ok', {
          confirmationSource: startStage.confirmationSource,
          responseText: startStage.responseText,
          sessionKey: startStage.sessionKey,
        });
        log('ok', '代理服务启动命令已执行');

        log('info', '验证代理健康状态...');
        markStage('health', 'running');
        const healthStage = await runDeployStage({
          client,
          log,
          accountId: account.id,
          stage: 'health',
          prompt: buildVerifyHealthPrompt(markers.health),
          timeoutMs: 60_000,
          matchText: markers.health,
        });
        if (!healthStage.ok) {
          markStage('health', healthStage.status, {
            retryable: healthStage.retryable,
            failureType: healthStage.failureType,
            lastError: healthStage.message,
            confirmationSource: healthStage.confirmationSource,
            responseText: healthStage.responseText,
            sessionKey: healthStage.sessionKey,
          });
          const err = new Error(healthStage.message);
          err.deployResult = result;
          throw err;
        }
        result.healthOk = true;
        result.verified = true;
        result.ok = true;
        markStage('health', 'ok', {
          confirmationSource: healthStage.confirmationSource,
          responseText: healthStage.responseText,
          sessionKey: healthStage.sessionKey,
        });
        markStage('complete', 'ok');
        log('ok', '代理健康检查通过');

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

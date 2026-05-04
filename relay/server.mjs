#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRegistry } from '../controller/registry.mjs';
import { getAccountsPath, loadAccounts } from '../controller/accounts.mjs';
import { createConfig } from '../controller/config.mjs';
import { createStateStore } from '../controller/state-store.mjs';
import { createMimoApi } from '../controller/mimo-api.mjs';
import { createLogger } from '../controller/logger.mjs';
import { createAccountWorker } from '../controller/account-worker.mjs';
import { sleep } from '../controller/utils.mjs';
import { pickUpstream, listFallbackUpstreams } from './router.mjs';
import { proxyJson, proxyStream } from './proxy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.RELAY_PORT || '9300', 10);
const host = process.env.RELAY_HOST || '127.0.0.1';
const registryPath = process.env.RELAY_REGISTRY_PATH
  ? resolve(process.env.RELAY_REGISTRY_PATH)
  : resolve(__dirname, '..', '.manager', 'registry.json');
const registry = createRegistry(registryPath);
const MAX_ATTEMPTS = parseInt(process.env.RELAY_MAX_ATTEMPTS || '3', 10);
const adminHtmlPath = resolve(__dirname, 'admin.html');
const rootDir = resolve(__dirname, '..');
const managerDataDir = resolve(rootDir, '.manager');
const accountsPath = getAccountsPath();

const managerControl = {
  child: null,
  lastExit: null,
};

function managerStatus() {
  return {
    running: Boolean(managerControl.child && managerControl.child.exitCode === null && !managerControl.child.killed),
    pid: managerControl.child?.pid || null,
    lastExit: managerControl.lastExit,
  };
}

function startManagerProcess() {
  const status = managerStatus();
  if (status.running) {
    return { ok: true, alreadyRunning: true, ...status };
  }

  const child = spawn(process.execPath, ['manager.mjs'], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[manager-control] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[manager-control] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    managerControl.lastExit = {
      code: code ?? null,
      signal: signal ?? null,
      at: new Date().toISOString(),
    };
    if (managerControl.child === child) {
      managerControl.child = null;
    }
  });

  managerControl.child = child;
  return { ok: true, alreadyRunning: false, ...managerStatus() };
}

function stopManagerProcess() {
  const child = managerControl.child;
  if (!child || child.exitCode !== null || child.killed) {
    managerControl.child = null;
    return Promise.resolve({ ok: true, alreadyStopped: true, ...managerStatus() });
  }

  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve({ ok: true, alreadyStopped: false, ...managerStatus() });
    };

    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!finished) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 1500);
    setTimeout(done, 2200);
  });
}

async function restartManagerProcess() {
  await stopManagerProcess();
  return startManagerProcess();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-cache',
  });
  res.end(html);
}

function loadAdminHtml() {
  if (existsSync(adminHtmlPath)) {
    return readFileSync(adminHtmlPath, 'utf-8');
  }
  return `<!doctype html><meta charset="utf-8"><title>KeyPool Relay Admin</title><body><h1>admin.html missing</h1></body>`;
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return safeJsonParse(readFileSync(filePath, 'utf-8'), fallback);
  } catch {
    return fallback;
  }
}

function tailLines(text, limit = 80) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit);
}

function readRecentLogs(limit = 120) {
  if (!existsSync(managerDataDir)) return [];
  const files = readdirSync(managerDataDir)
    .filter(name => name.endsWith('.log'))
    .sort();

  const lines = [];
  for (const name of files) {
    const fullPath = resolve(managerDataDir, name);
    const fileLines = tailLines(readFileSync(fullPath, 'utf-8'), Math.max(20, Math.floor(limit / Math.max(files.length, 1))));
    for (const line of fileLines) {
      lines.push({ file: name, line });
    }
  }

  return lines.slice(-limit);
}

function loadAccountStates() {
  if (!existsSync(managerDataDir)) return [];
  const files = readdirSync(managerDataDir)
    .filter(name => name.endsWith('.state.json'))
    .sort();

  return files.map((name) => {
    const fullPath = resolve(managerDataDir, name);
    const state = readJsonIfExists(fullPath, {});
    return {
      file: name,
      accountId: name.replace(/\.state\.json$/i, ''),
      currentShareUrl: state?.currentShareUrl || null,
      currentLocalUrl: state?.currentLocalUrl || null,
      deployCount: state?.deployCount || 0,
      lastDeployAt: state?.lastDeployAt || null,
      lastHealthError: state?.lastHealthError || null,
      recentRenewals: Array.isArray(state?.renewHistory) ? state.renewHistory.slice(-8).reverse() : [],
    };
  });
}

function parseAccountsFile() {
  if (!existsSync(accountsPath)) {
    return { exists: false, raw: { accounts: [] }, list: [] };
  }

  const raw = readJsonIfExists(accountsPath, { accounts: [] });
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.accounts)
      ? raw.accounts
      : [];

  return { exists: true, raw, list };
}

function sanitizeTags(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function maskAccountForClient(raw, index) {
  const id = String(raw?.id || raw?.name || `account-${index + 1}`);
  const cookie = typeof raw?.cookie === 'string' ? raw.cookie.trim() : '';
  const cookieFile = typeof raw?.cookieFile === 'string' ? raw.cookieFile.trim() : '';

  return {
    id,
    name: raw?.name || id,
    enabled: raw?.enabled !== false,
    priority: Number.isFinite(raw?.priority) ? raw.priority : 100,
    tags: sanitizeTags(raw?.tags),
    meta: raw?.meta && typeof raw.meta === 'object' ? raw.meta : {},
    cookie: '',
    cookieFile,
    hasCookie: Boolean(cookie),
    hasCookieFile: Boolean(cookieFile),
  };
}

function loadAccountsConfigForClient() {
  const parsed = parseAccountsFile();
  return {
    path: accountsPath,
    exists: parsed.exists,
    accounts: parsed.list.map(maskAccountForClient),
  };
}

function buildStoredAccount(input, index, previousById) {
  const id = String(input?.id || input?.name || `account-${index + 1}`).trim();
  if (!id) {
    throw new Error(`第 ${index + 1} 个账号缺少 id`);
  }

  const previous = previousById.get(id) || {};
  const cookie = typeof input?.cookie === 'string' ? input.cookie.trim() : '';
  const cookieFile = typeof input?.cookieFile === 'string' ? input.cookieFile.trim() : '';

  const stored = {
    id,
    name: String(input?.name || id).trim() || id,
    enabled: input?.enabled !== false,
    priority: Number.isFinite(Number(input?.priority)) ? Number(input.priority) : 100,
    tags: sanitizeTags(input?.tags),
  };

  const meta = input?.meta && typeof input.meta === 'object'
    ? input.meta
    : previous?.meta && typeof previous.meta === 'object'
      ? previous.meta
      : undefined;
  if (meta && Object.keys(meta).length > 0) {
    stored.meta = meta;
  }

  if (cookie) stored.cookie = cookie;
  else if (typeof previous?.cookie === 'string' && previous.cookie.trim()) stored.cookie = previous.cookie.trim();

  if (cookieFile) stored.cookieFile = cookieFile;
  else if (typeof previous?.cookieFile === 'string' && previous.cookieFile.trim()) stored.cookieFile = previous.cookieFile.trim();

  if (!stored.cookie && !stored.cookieFile) {
    throw new Error(`账号 ${id} 缺少 cookie 或 cookieFile`);
  }

  return stored;
}

function buildActionRuntime(account) {
  const accountId = String(account.id).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const logPath = resolve(managerDataDir, `${accountId}.log`);
  const statePath = resolve(managerDataDir, `${accountId}.state.json`);
  const baseLogger = createLogger(logPath);
  const prefixedLog = (level, ...args) => baseLogger.log(level, `[${account.name}]`, ...args);
  const stateStore = createStateStore(statePath);
  const api = createMimoApi({ sleep });
  const worker = createAccountWorker({
    cookie: account.cookie,
    config: createConfig(),
    api,
    stateStore,
    log: prefixedLog,
  });
  return { account, log: prefixedLog, stateStore, api, worker };
}

async function runAccountAction(accountId, action) {
  const accounts = loadAccounts();
  const account = accounts.find(item => String(item.id) === String(accountId));
  if (!account) {
    throw new Error(`未找到账号: ${accountId}`);
  }

  const runtime = buildActionRuntime(account);
  const auth = await runtime.api.validateCookie(account.cookie);
  if (!auth.valid) {
    throw new Error(`账号 ${accountId} Cookie 无效: ${auth.reason}`);
  }

  if (action === 'deploy') {
    await runtime.worker.renewFlow('admin-manual-deploy');
  } else if (action === 'recover') {
    await runtime.worker.recoverAvailableInstance();
  } else if (action === 'destroy') {
    await runtime.api.destroyInstance(account.cookie);
  } else {
    throw new Error(`不支持的账号动作: ${action}`);
  }

  return {
    ok: true,
    accountId: account.id,
    accountName: account.name,
    action,
    state: runtime.stateStore.loadState(),
  };
}

function saveAccountsConfigFromClient(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const parsed = parseAccountsFile();
  const previousById = new Map(
    parsed.list.map((item, index) => [String(item?.id || item?.name || `account-${index + 1}`), item])
  );
  const seen = new Set();

  const storedAccounts = accounts.map((item, index) => {
    const normalized = buildStoredAccount(item, index, previousById);
    if (seen.has(normalized.id)) {
      throw new Error(`账号 id 重复: ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  });

  mkdirSync(dirname(accountsPath), { recursive: true });
  writeFileSync(accountsPath, JSON.stringify({ accounts: storedAccounts }, null, 2) + '\n', 'utf-8');

  return {
    ok: true,
    path: accountsPath,
    exists: true,
    count: storedAccounts.length,
    accounts: storedAccounts.map(maskAccountForClient),
  };
}

function buildOverview() {
  const registryData = registry.load();
  const upstreams = Array.isArray(registryData.upstreams) ? registryData.upstreams : [];
  const healthyUpstreams = upstreams.filter((u) => u.healthy === true);
  const missingShareUrl = upstreams.filter((u) => !u.shareUrl).length;
  const availableInstances = upstreams.filter((u) => u.instanceStatus === 'AVAILABLE').length;
  const degradedUpstreams = upstreams.filter((u) => !u.healthy && u.instanceStatus === 'AVAILABLE').length;
  const states = loadAccountStates();
  const accountsConfig = loadAccountsConfigForClient();

  return {
    generatedAt: new Date().toISOString(),
    manager: managerStatus(),
    relay: {
      host,
      port,
      baseUrl: `http://${host}:${port}`,
      accessUrl: `http://${host}:${port}/v1`,
      adminUrl: `http://${host}:${port}/admin`,
    },
    summary: {
      totalUpstreams: upstreams.length,
      healthyUpstreams: healthyUpstreams.length,
      availableInstances,
      degradedUpstreams,
      missingShareUrl,
      primaryAccountName: upstreams[0]?.accountName || upstreams[0]?.accountId || null,
      updatedAt: registryData.updatedAt || null,
      configuredAccounts: accountsConfig.accounts.length,
      accountsConfigExists: accountsConfig.exists,
    },
    accounts: accountsConfig,
    registry: registryData,
    states,
    logs: readRecentLogs(160),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function candidateList() {
  const primary = pickUpstream(registry);
  if (!primary) return [];
  return [primary, ...listFallbackUpstreams(registry, [primary.accountId])].slice(0, MAX_ATTEMPTS);
}

function passthroughHeaders(headers) {
  const allow = [
    'content-type',
    'cache-control',
    'connection',
    'x-request-id',
    'transfer-encoding',
    'date',
    'x-accel-buffering',
  ];
  const next = {};
  for (const key of allow) {
    if (headers[key]) next[key] = headers[key];
  }
  return next;
}

function isStreamingChatRequest(path, body) {
  if (!path.startsWith('/v1/chat/completions')) return false;
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed?.stream === true;
  } catch {
    return false;
  }
}

function isClientAbortError(error) {
  const message = error?.message || '';
  return message.includes('客户端已断开') || message.includes('aborted');
}

function bindClientAbort(req) {
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
      }
    }
    listeners.clear();
  };

  req.on('aborted', notify);
  req.on('close', notify);

  return (listener) => {
    if (typeof listener === 'function') listeners.add(listener);
  };
}

async function forwardViaUpstream(upstream, req, path, body, onAbort) {
  registry.markInflight(upstream.accountId, 1);
  try {
    const result = await proxyJson({
      baseUrl: upstream.baseUrl,
      method: req.method,
      path,
      body,
      onAbort,
      headers: {
        authorization: req.headers.authorization || '',
      },
    });

    if (result.statusCode >= 500) {
      registry.markFailure(upstream.accountId, `upstream ${result.statusCode}`, { statusCode: result.statusCode });
      return { ok: false, retryable: true, upstream, result };
    }

    registry.markSuccess(upstream.accountId, { lastStatusCode: result.statusCode });
    return { ok: true, upstream, result };
  } catch (e) {
    if (isClientAbortError(e)) {
      return { ok: false, retryable: false, upstream, error: e, aborted: true };
    }
    registry.markFailure(upstream.accountId, e.message);
    return { ok: false, retryable: true, upstream, error: e };
  } finally {
    registry.markInflight(upstream.accountId, -1);
  }
}

async function handleStreamProxy(req, res, path, body) {
  const upstreams = candidateList();
  if (upstreams.length === 0) {
    return sendJson(res, 503, {
      error: 'no_healthy_upstream',
      message: '当前没有可用上游，请先运行 manager 完成部署并同步 registry',
    });
  }

  const onAbort = bindClientAbort(req);
  const attempts = [];
  for (const upstream of upstreams) {
    registry.markInflight(upstream.accountId, 1);
    let responseStarted = false;
    try {
      await proxyStream({
        baseUrl: upstream.baseUrl,
        method: req.method,
        path,
        body,
        onAbort,
        headers: {
          authorization: req.headers.authorization || '',
        },
        onResponse: async (upstreamRes, upstreamReq) => {
          const statusCode = upstreamRes.statusCode || 502;

          if (statusCode >= 500) {
            let errorBody = '';
            for await (const chunk of upstreamRes) errorBody += chunk;
            registry.markFailure(upstream.accountId, `upstream ${statusCode}`, { statusCode });
            attempts.push({
              accountId: upstream.accountId,
              baseUrl: upstream.baseUrl,
              statusCode,
              error: errorBody || `upstream ${statusCode}`,
            });
            return;
          }

          responseStarted = true;
          registry.markSuccess(upstream.accountId, { lastStatusCode: statusCode });
          res.writeHead(statusCode, passthroughHeaders(upstreamRes.headers));

          onAbort(() => {
            upstreamRes.destroy(new Error('客户端已断开'));
            upstreamReq.destroy(new Error('客户端已断开'));
            if (!res.writableEnded) res.end();
          });

          upstreamRes.on('data', chunk => res.write(chunk));
          upstreamRes.on('end', () => res.end());
          upstreamRes.on('error', (error) => {
            if (!isClientAbortError(error)) {
              registry.markFailure(upstream.accountId, error.message);
            }
            if (!res.writableEnded) res.end();
          });
        },
      });

      if (responseStarted) return;
    } catch (e) {
      if (isClientAbortError(e)) {
        if (!res.writableEnded) res.end();
        return;
      }
      registry.markFailure(upstream.accountId, e.message);
      attempts.push({
        accountId: upstream.accountId,
        baseUrl: upstream.baseUrl,
        statusCode: 0,
        error: e.message,
      });
    } finally {
      registry.markInflight(upstream.accountId, -1);
    }
  }

  return sendJson(res, 502, {
    error: 'all_upstreams_failed',
    attempts,
  });
}

async function handleProxy(req, res, path) {
  const upstreams = candidateList();
  if (upstreams.length === 0) {
    return sendJson(res, 503, {
      error: 'no_healthy_upstream',
      message: '当前没有可用上游，请先运行 manager 完成部署并同步 registry',
    });
  }

  const body = req.method === 'GET' ? null : await readBody(req);
  if (isStreamingChatRequest(path, body)) {
    return handleStreamProxy(req, res, path, body);
  }

  const onAbort = bindClientAbort(req);
  const attempts = [];
  for (const upstream of upstreams) {
    const forwarded = await forwardViaUpstream(upstream, req, path, body, onAbort);
    if (forwarded.ok) {
      res.writeHead(forwarded.result.statusCode, {
        'content-type': forwarded.result.headers['content-type'] || 'application/json; charset=utf-8',
      });
      res.end(forwarded.result.body);
      return;
    }

    if (forwarded.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }

    attempts.push({
      accountId: upstream.accountId,
      baseUrl: upstream.baseUrl,
      statusCode: forwarded.result?.statusCode || 0,
      error: forwarded.error?.message || null,
    });

    if (!forwarded.retryable) break;
  }

  return sendJson(res, 502, {
    error: 'all_upstreams_failed',
    attempts,
  });
}

async function handleControlApi(req, res, url) {
  if (url.pathname === '/api/control/status' && req.method === 'GET') {
    return sendJson(res, 200, managerStatus());
  }

  if (url.pathname === '/api/control/start' && req.method === 'POST') {
    return sendJson(res, 200, startManagerProcess());
  }

  if (url.pathname === '/api/control/stop' && req.method === 'POST') {
    return sendJson(res, 200, await stopManagerProcess());
  }

  if (url.pathname === '/api/control/retry' && req.method === 'POST') {
    return sendJson(res, 200, await restartManagerProcess());
  }

  return sendJson(res, 404, { error: 'not_found', message: '支持的控制路径: /api/control/status /api/control/start /api/control/stop /api/control/retry' });
}

async function handleAdminApi(req, res, url) {
  if (url.pathname === '/api/admin/overview' && req.method === 'GET') {
    return sendJson(res, 200, buildOverview());
  }

  if (url.pathname === '/api/admin/logs' && req.method === 'GET') {
    const requested = Number(url.searchParams.get('limit') || 120);
    const limit = Math.max(20, Math.min(500, requested || 120));
    return sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      lines: readRecentLogs(limit),
    });
  }

  if (url.pathname === '/api/admin/accounts' && req.method === 'GET') {
    return sendJson(res, 200, loadAccountsConfigForClient());
  }

  const accountActionMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/(deploy|recover|destroy)$/);
  if (accountActionMatch && req.method === 'POST') {
    const [, accountIdEncoded, action] = accountActionMatch;
    const accountId = decodeURIComponent(accountIdEncoded);
    try {
      const result = await runAccountAction(accountId, action);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 400, { error: 'account_action_failed', message: e.message, accountId, action });
    }
  }

  if (url.pathname === '/api/admin/accounts' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readBody(req);
    const payload = safeJsonParse(body, null);
    if (!payload || typeof payload !== 'object') {
      return sendJson(res, 400, { error: 'invalid_json', message: '请求体必须是 JSON 对象' });
    }

    const saved = saveAccountsConfigFromClient(payload);
    const shouldRestartManager = payload.restartManager === true;
    const manager = shouldRestartManager ? await restartManagerProcess() : managerStatus();

    return sendJson(res, 200, {
      ...saved,
      restartedManager: shouldRestartManager,
      manager,
    });
  }

  return sendJson(res, 404, { error: 'not_found', message: '支持的管理路径: /api/admin/overview /api/admin/logs /api/admin/accounts /api/admin/accounts/:id/deploy /api/admin/accounts/:id/recover /api/admin/accounts/:id/destroy' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/' || url.pathname === '/admin') {
      return sendHtml(res, 200, loadAdminHtml());
    }

    if (url.pathname.startsWith('/api/control/')) {
      return handleControlApi(req, res, url);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      return await handleAdminApi(req, res, url);
    }

    if (url.pathname === '/health') {
      const data = registry.load();
      const healthy = (data.upstreams || []).filter(u => u.healthy).length;
      return sendJson(res, healthy > 0 ? 200 : 503, {
        ok: healthy > 0,
        healthyUpstreams: healthy,
        totalUpstreams: (data.upstreams || []).length,
        updatedAt: data.updatedAt,
      });
    }

    if (url.pathname === '/registry') {
      return sendJson(res, 200, registry.load());
    }

    if (
      url.pathname === '/v1/models' ||
      url.pathname === '/v1/embeddings' ||
      url.pathname === '/v1/chat/completions'
    ) {
      return handleProxy(req, res, url.pathname + url.search);
    }

    return sendJson(res, 404, {
      error: 'not_found',
      message: '支持的路径: / /admin /api/control/status /api/control/start /api/control/stop /api/control/retry /api/admin/overview /api/admin/logs /api/admin/accounts /api/admin/accounts/:id/deploy /api/admin/accounts/:id/recover /api/admin/accounts/:id/destroy /health /registry /v1/models /v1/embeddings /v1/chat/completions',
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'relay_internal_error', message: e.message });
  }
});

server.listen(port, host, () => {
  console.log(`✅ relay 已启动: http://${host}:${port}`);
  console.log(`📁 registry: ${registryPath}`);
});

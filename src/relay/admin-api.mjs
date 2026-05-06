/**
 * Admin REST API（/api/admin/*）
 *
 * 从 relay/server.mjs 中提取，负责管理后台的数据接口。
 * 使用工厂函数 createAdminApi(deps) 注入依赖，返回 handleAdminApi。
 */

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { loadAccounts } from '../manager/accounts.mjs';
import { createConfig } from '../manager/config.mjs';
import { createStateStore } from '../shared/state-store.mjs';
import { createMimoApi } from '../manager/mimo-api.mjs';
import { createLogger } from '../shared/logger.mjs';
import { createAccountWorker } from '../manager/account-worker.mjs';
import { sleep } from '../shared/utils.mjs';
import { probeHealth } from '../shared/http.mjs';
import { sendJson, readBody, safeJsonParse } from './utils.mjs';

export function createAdminApi(deps) {
  const {
    registry,
    rootDir,
    managerDataDir,
    accountsPath,
    managerStatus,
    appStatus,
    restartManagerProcess,
  } = deps;

  const host = deps.host || '127.0.0.1';
  const port = deps.port || 9300;
  const adminHtmlPath = deps.adminHtmlPath || resolve(rootDir, 'relay', 'admin.html');

  // ─── 内部工具函数 ──────────────────────────────────────────────

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
      const recovered = await runtime.worker.recoverAvailableInstance();
      if (!recovered?.success) {
        const detail = recovered?.invalidShareUrl
          ? `原地恢复拿到了失效 tunnel 地址: ${recovered.invalidShareUrl}`
          : '原地恢复未拿到可确认的可用分享地址';
        throw new Error(detail);
      }

      const state = runtime.stateStore.loadState();
      state.currentShareUrl = recovered.shareUrl || state.currentShareUrl || null;
      state.currentLocalUrl = recovered.localUrl || state.currentLocalUrl || 'http://127.0.0.1:9200';
      state.lastHealthError = null;
      state.history = state.history || [];
      state.history.push({
        at: new Date().toISOString(),
        reason: 'admin-manual-recover',
        expireTime: state.lastExpireTime || null,
        key: null,
        shareUrl: state.currentShareUrl,
        localUrl: state.currentLocalUrl,
        success: true,
      });
      if (state.history.length > 50) state.history = state.history.slice(-50);
      runtime.stateStore.saveState(state, runtime.log);

      let instanceStatus = 'UNKNOWN';
      let expireTime = state.lastExpireTime || null;
      try {
        const status = await runtime.api.getStatus(account.cookie);
        instanceStatus = status.status || 'UNKNOWN';
        expireTime = status.expireTime || expireTime;
      } catch {}

      const endpointHealth = await probeHealth({ baseUrl: state.currentShareUrl, timeoutMs: 15_000 });
      registry.upsert({
        accountId: account.id,
        accountName: account.name,
        userId: auth.userId || null,
        userName: auth.userName || null,
        baseUrl: state.currentShareUrl || null,
        shareUrl: state.currentShareUrl || null,
        localUrl: state.currentLocalUrl || 'http://127.0.0.1:9200',
        healthy: Boolean(state.currentShareUrl) && endpointHealth.ok,
        priority: account.priority,
        tags: account.tags || [],
        instanceStatus,
        expireTime,
        deployed: true,
        deployCount: state.deployCount || 0,
        lastDeployAt: state.lastDeployAt || null,
        lastError: endpointHealth.ok ? null : (endpointHealth.error || `health ${endpointHealth.statusCode}`),
        lastStatusCode: endpointHealth.statusCode || 0,
      });
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
      appControl: (() => {
        try {
          return appStatus();
        } catch (error) {
          return { ok: false, running: false, error: error.message };
        }
      })(),
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

  function loadAdminHtml() {
    if (existsSync(adminHtmlPath)) {
      return readFileSync(adminHtmlPath, 'utf-8');
    }
    return `<!doctype html><meta charset="utf-8"><title>KeyPool Relay Admin</title><body><h1>admin.html missing</h1></body>`;
  }

  // ─── 主处理函数 ────────────────────────────────────────────────

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

    return sendJson(res, 404, {
      error: 'not_found',
      message: '支持的管理路径: /api/admin/overview /api/admin/logs /api/admin/accounts /api/admin/accounts/:id/deploy /api/admin/accounts/:id/recover /api/admin/accounts/:id/destroy',
    });
  }

  return {
    handleAdminApi,
    loadAdminHtml,
  };
}

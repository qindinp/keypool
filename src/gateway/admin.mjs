/**
 * Gateway Admin API + 状态页面
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '..', '..');
const accountsPath = resolve(workspaceRoot, 'accounts.json');

/**
 * 创建 Admin API 处理器
 * @param {import('./registry.mjs').Registry} registry
 * @param {object} [context]
 * @param {ReturnType<import('../manager/index.mjs').createManager>} [context.manager]
 * @returns {Function}
 */
export function createAdminHandler(registry, context = {}) {
  return async function handleAdmin(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderAdminPage());
      return;
    }

    if (url.pathname === '/admin/api/overview') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildOverview(registry, req, context), null, 2));
      return;
    }

    if (url.pathname === '/admin/api/control/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, manager: buildManagerStatus(context.manager) }, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/control/start' && req.method === 'POST') {
      const result = await startManager(context.manager);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/control/stop' && req.method === 'POST') {
      const result = await stopManager(context.manager);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/control/restart' && req.method === 'POST') {
      const result = await restartManager(context.manager);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/accounts' && req.method === 'POST') {
      const result = await createAccount(context.manager, req);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    const cookieMatch = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)\/cookie$/);
    if (cookieMatch && req.method === 'POST') {
      const [, accountId] = cookieMatch;
      const result = await updateAccountCookie(context.manager, accountId, req);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    const accountManageMatch = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)$/);
    if (accountManageMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const [, accountId] = accountManageMatch;
      const result = req.method === 'PUT'
        ? await updateAccount(context.manager, accountId, req)
        : await deleteAccount(context.manager, accountId);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    const actionMatch = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)\/(deploy|recover|destroy|stop)$/);
    if (actionMatch && req.method === 'POST') {
      const [, accountId, action] = actionMatch;
      const result = await runAccountAction(context.manager, accountId, action);
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/agents') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ agents: buildAgents(registry) }, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/instances') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ instances: buildInstances(registry) }, null, 2));
      return;
    }

    if (url.pathname === '/admin/api/accounts') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(loadAccountsSummary(), null, 2));
      return;
    }

    if (url.pathname === '/health') {
      const healthyAgents = registry.getHealthy();
      const instanceStates = [...registry.getAllInstances().values()];
      const verifiedInstances = instanceStates.filter(state => state?.verified || state?.status === 'ACTIVE');
      const deployingInstances = instanceStates.filter(state => ['DEPLOYING', 'DEPLOYED_UNVERIFIED', 'READY', 'RECOVERING'].includes(state?.status));
      const failedInstances = instanceStates.filter(state => state?.status === 'FAILED');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: verifiedInstances.length > 0 || healthyAgents.length > 0 ? 'ok' : 'degraded',
        agents: healthyAgents.length,
        verifiedInstances: verifiedInstances.length,
        deployingInstances: deployingInstances.length,
        failedInstances: failedInstances.length,
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

function buildManagerStatus(manager) {
  if (!manager) {
    return { running: false, workers: 0, enabled: false, note: 'Manager 未挂载到 Gateway' };
  }

  return {
    running: true,
    workers: Array.isArray(manager.workers) ? manager.workers.length : 0,
    enabled: true,
    config: sanitizeManagerConfig(manager.config || null),
  };
}

function sanitizeManagerConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const clone = { ...config };
  if (typeof clone.tailscaleAuthKey === 'string' && clone.tailscaleAuthKey) {
    clone.tailscaleAuthKey = '<redacted>';
  }
  return clone;
}

async function startManager(manager) {
  if (!manager) {
    return { ok: false, error: 'manager_unavailable', message: 'Manager 未挂载到 Gateway' };
  }
  try {
    manager.start();
    return { ok: true, message: 'Manager 已启动', manager: buildManagerStatus(manager) };
  } catch (error) {
    return { ok: false, error: 'manager_start_failed', message: error?.message || String(error) };
  }
}

async function stopManager(manager) {
  if (!manager) {
    return { ok: false, error: 'manager_unavailable', message: 'Manager 未挂载到 Gateway' };
  }
  try {
    await manager.stop();
    return {
      ok: true,
      message: 'Manager 已停止',
      manager: { running: false, workers: Array.isArray(manager.workers) ? manager.workers.length : 0 },
    };
  } catch (error) {
    return { ok: false, error: 'manager_stop_failed', message: error?.message || String(error) };
  }
}

async function restartManager(manager) {
  const stopped = await stopManager(manager);
  if (!stopped.ok) return stopped;
  return startManager(manager);
}

async function runAccountAction(manager, accountId, action) {
  if (!manager) {
    return { ok: false, error: 'manager_unavailable', message: 'Manager 未挂载到 Gateway' };
  }

  const worker = Array.isArray(manager.workers)
    ? manager.workers.find(item => String(item.account?.id) === String(accountId))
    : null;

  if (!worker) {
    return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
  }

  try {
    if (action === 'deploy') {
      await worker.create();
    } else if (action === 'recover') {
      await worker.recover();
    } else if (action === 'destroy') {
      await worker.api.destroyInstance(worker.account.cookie);
      worker.instance = null;
      worker.state = 'DESTROYED';
      worker.registry.setInstanceStatus(worker.account.id, 'DESTROYED');
    } else if (action === 'stop') {
      await worker.manualStop();
    }

    return {
      ok: true,
      action,
      accountId: worker.account.id,
      state: worker.snapshot(),
    };
  } catch (error) {
    return {
      ok: false,
      error: 'account_action_failed',
      action,
      accountId: worker.account.id,
      message: error?.message || String(error),
    };
  }
}

async function updateAccountCookie(manager, accountId, req) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return { ok: false, error: 'invalid_json', message: error?.message || '请求体不是合法 JSON' };
  }

  const cookie = String(payload?.cookie || '').trim();
  if (!cookie) {
    return { ok: false, error: 'cookie_required', message: 'cookie 不能为空' };
  }

  return mutateAccountsConfig(async ({ raw, list }) => {
    const target = list.find((item, index) => String(item?.id || item?.name || `account-${index + 1}`) === String(accountId));
    if (!target) {
      return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
    }

    target.cookie = cookie;
    delete target.cookieFile;

    if (manager && Array.isArray(manager.workers)) {
      const worker = manager.workers.find(item => String(item.account?.id) === String(accountId));
      if (worker?.account) worker.account.cookie = cookie;
    }

    return {
      ok: true,
      accountId,
      message: `账号 ${accountId} 的 cookie 已更新`,
      raw,
      list,
      restartManagerAfterSave: false,
    };
  });
}

async function createAccount(manager, req) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return { ok: false, error: 'invalid_json', message: error?.message || '请求体不是合法 JSON' };
  }

  const id = String(payload?.id || '').trim();
  const name = String(payload?.name || id).trim();
  const cookie = String(payload?.cookie || '').trim();
  const enabled = payload?.enabled !== false;
  const priority = Number.isFinite(Number(payload?.priority)) ? Number(payload.priority) : 100;
  const weight = Number.isFinite(Number(payload?.weight)) ? Math.max(0, Math.round(Number(payload.weight))) : 100;
  const tags = normalizeTags(payload?.tags);

  if (!id) return { ok: false, error: 'id_required', message: '账号 ID 不能为空' };
  if (!cookie) return { ok: false, error: 'cookie_required', message: 'cookie 不能为空' };

  return mutateAccountsConfig(async ({ raw, list }) => {
    const exists = list.some((item, index) => String(item?.id || item?.name || `account-${index + 1}`) === id);
    if (exists) {
      return { ok: false, error: 'account_exists', message: `账号 ${id} 已存在` };
    }

    list.push({ id, name, enabled, priority, weight, tags, cookie });
    return {
      ok: true,
      accountId: id,
      message: `账号 ${id} 已创建，并已重载 Manager`,
      raw,
      list,
      restartManagerAfterSave: true,
    };
  }, manager);
}

async function updateAccount(manager, accountId, req) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return { ok: false, error: 'invalid_json', message: error?.message || '请求体不是合法 JSON' };
  }

  return mutateAccountsConfig(async ({ raw, list }) => {
    const target = list.find((item, index) => String(item?.id || item?.name || `account-${index + 1}`) === String(accountId));
    if (!target) {
      return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
    }

    const nextId = String(payload?.id || target.id || accountId).trim();
    const nextName = String(payload?.name || target.name || nextId).trim();
    const nextCookie = typeof payload?.cookie === 'string' ? payload.cookie.trim() : '';
    const nextEnabled = payload?.enabled !== undefined ? payload.enabled !== false : target.enabled !== false;
    const nextPriority = payload?.priority !== undefined ? (Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 100) : (Number.isFinite(Number(target.priority)) ? Number(target.priority) : 100);
    const nextWeight = payload?.weight !== undefined ? (Number.isFinite(Number(payload.weight)) ? Math.max(0, Math.round(Number(payload.weight))) : 100) : (Number.isFinite(Number(target.weight)) ? Math.max(0, Math.round(Number(target.weight))) : 100);
    const nextTags = payload?.tags !== undefined ? normalizeTags(payload.tags) : (Array.isArray(target.tags) ? target.tags : []);

    if (!nextId) return { ok: false, error: 'id_required', message: '账号 ID 不能为空' };
    const conflict = list.some((item, index) => item !== target && String(item?.id || item?.name || `account-${index + 1}`) === nextId);
    if (conflict) return { ok: false, error: 'account_exists', message: `账号 ${nextId} 已存在` };

    target.id = nextId;
    target.name = nextName || nextId;
    target.enabled = nextEnabled;
    target.priority = nextPriority;
    target.weight = nextWeight;
    target.tags = nextTags;
    if (nextCookie) {
      target.cookie = nextCookie;
      delete target.cookieFile;
    }

    return {
      ok: true,
      accountId: nextId,
      message: `账号 ${accountId} 已更新，并已重载 Manager`,
      raw,
      list,
      restartManagerAfterSave: true,
    };
  }, manager);
}

async function deleteAccount(manager, accountId) {
  return mutateAccountsConfig(async ({ raw, list }) => {
    const index = list.findIndex((item, idx) => String(item?.id || item?.name || `account-${idx + 1}`) === String(accountId));
    if (index < 0) {
      return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
    }

    list.splice(index, 1);
    return {
      ok: true,
      accountId,
      message: `账号 ${accountId} 已删除，并已重载 Manager`,
      raw,
      list,
      restartManagerAfterSave: true,
    };
  }, manager);
}

async function mutateAccountsConfig(mutator, manager) {
  if (!existsSync(accountsPath)) {
    return { ok: false, error: 'accounts_missing', message: 'accounts.json 不存在，无法在界面中管理账号' };
  }

  try {
    const raw = JSON.parse(readFileSync(accountsPath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : null;
    if (!Array.isArray(list)) {
      return { ok: false, error: 'accounts_invalid', message: 'accounts.json 结构不受支持' };
    }

    const result = await mutator({ raw, list });
    if (!result?.ok) return result;

    writeFileSync(accountsPath, JSON.stringify(Array.isArray(raw) ? list : { ...raw, accounts: list }, null, 2), 'utf-8');

    if (result.restartManagerAfterSave && manager) {
      const restarted = await restartManager(manager);
      if (!restarted.ok) {
        return {
          ok: false,
          error: 'manager_restart_failed',
          message: `账号配置已保存，但 Manager 重载失败：${restarted.message || restarted.error || 'unknown error'}`,
        };
      }
    }

    const { raw: _raw, list: _list, ...sanitized } = result;
    return sanitized;
  } catch (error) {
    return {
      ok: false,
      error: 'accounts_mutation_failed',
      message: error?.message || String(error),
    };
  }
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

const MAX_BODY_BYTES = 512 * 1024; // 512KB

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`请求体超过大小限制 (${MAX_BODY_BYTES / 1024}KB)`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function buildOverview(registry, req, context = {}) {
  const agents = buildAgents(registry);
  const instances = buildInstances(registry);
  const accounts = loadAccountsSummary();
  const host = req?.headers?.host || '127.0.0.1:9300';
  const manager = buildManagerStatus(context.manager);

  const instanceList = Object.values(instances);
  const activeInstances = instanceList.filter(item => item.status === 'ACTIVE').length;
  const creatingInstances = instanceList.filter(item => ['CREATING', 'READY', 'DEPLOYING', 'DEPLOYED_UNVERIFIED', 'RECOVERING'].includes(item.status)).length;
  const failedInstances = instanceList.filter(item => item.status === 'FAILED').length;
  const verifiedInstances = instanceList.filter(item => item.verified || item.status === 'ACTIVE').length;

  return {
    service: {
      status: verifiedInstances > 0 || agents.some(item => item.healthy) ? 'ok' : 'degraded',
      accessUrl: `http://${host}/v1`,
      adminUrl: `http://${host}/admin`,
      healthUrl: `http://${host}/health`,
      generatedAt: new Date().toISOString(),
      manager,
    },
    metrics: {
      agents: agents.length,
      healthyAgents: agents.filter(item => item.healthy).length,
      inflight: agents.reduce((sum, item) => sum + item.inflight, 0),
      accounts: accounts.accounts.length,
      enabledAccounts: accounts.accounts.filter(item => item.enabled).length,
      instances: instanceList.length,
      activeInstances,
      verifiedInstances,
      creatingInstances,
      failedInstances,
      missingAgentBindings: instanceList.filter(item => !item.agentId).length,
      retryableFailures: instanceList.filter(item => item.status === 'FAILED' && item.retryable).length,
      historyConfirmedStages: instanceList.filter(item => item.confirmationSource === 'history').length,
    },
  };
}

function buildAgents(registry) {
  const now = Date.now();
  return registry.getAll().map(entry => ({
    agentId: entry.agentId,
    instanceId: entry.instanceId,
    accountId: entry.accountId,
    models: entry.models,
    connectedAt: entry.connectedAt,
    connectedAgoMs: now - entry.connectedAt,
    healthy: entry.healthy,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
    inflight: entry.inflight,
    avgLatency: entry.successCount > 0 ? Math.round(entry.totalLatency / entry.successCount) : 0,
    lastUsed: entry.lastUsed || 0,
  }));
}

function buildInstances(registry) {
  const result = {};
  for (const [accountId, state] of registry.getAllInstances()) {
    result[accountId] = {
      accountId,
      status: state?.status || 'NONE',
      agentId: state?.agentId || null,
      currentTailnetIpUrl: state?.currentTailnetIpUrl || null,
      currentTailnetUrl: state?.currentTailnetUrl || null,
      currentShareUrl: state?.currentShareUrl || null,
      currentLocalUrl: state?.currentLocalUrl || null,
      lastDeployAt: state?.lastDeployAt || null,
      lastHealthError: state?.lastHealthError || null,
      lastDeployError: state?.lastDeployError || null,
      lastVerifiedAt: state?.lastVerifiedAt || null,
      verified: !!state?.verified,
      healthOk: !!state?.healthOk,
      deployMode: state?.deployMode || null,
      deployStage: state?.deployStage || null,
      deployStatus: state?.deployStatus || null,
      failureType: state?.failureType || null,
      retryable: !!state?.retryable,
      confirmationSource: state?.confirmationSource || null,
      responseText: state?.responseText || null,
      deployTimeline: Array.isArray(state?.deployTimeline) ? state.deployTimeline : [],
      proxyUrl: state?.proxyUrl || null,
      agentOnline: !!state?.agentOnline,
      deployCount: state?.deployCount || 0,
    };
  }
  return result;
}

function loadAccountsSummary() {
  const fallback = { path: accountsPath, exists: false, accounts: [] };
  if (!existsSync(accountsPath)) return fallback;

  try {
    const raw = JSON.parse(readFileSync(accountsPath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
    return {
      path: accountsPath,
      exists: true,
      accounts: list.map((item, index) => ({
        id: String(item?.id || item?.name || `account-${index + 1}`),
        name: String(item?.name || item?.id || `account-${index + 1}`),
        enabled: item?.enabled !== false,
        priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : 100,
        tags: Array.isArray(item?.tags) ? item.tags : [],
        hasCookie: typeof item?.cookie === 'string' && item.cookie.trim().length > 0,
        hasCookieFile: typeof item?.cookieFile === 'string' && item.cookieFile.trim().length > 0,
        weight: Number.isFinite(Number(item?.weight)) ? Math.max(0, Math.round(Number(item.weight))) : 100,
      })),
    };
  } catch (error) {
    return {
      ...fallback,
      exists: true,
      error: error?.message || 'accounts.json 解析失败',
    };
  }
}

function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KeyPool 控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1020;
      --panel: #151c2f;
      --panel2: #1b2540;
      --border: #2d3859;
      --text: #e9eefb;
      --muted: #92a0c4;
      --accent: #66a3ff;
      --ok: #34d399;
      --warn: #fbbf24;
      --bad: #f87171;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif; background: var(--bg); color: var(--text); }
    .shell { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .header, .banner, .toolbar, .tabs, .meta-links { display: flex; gap: 12px; flex-wrap: wrap; }
    .header { justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
    .title h1 { margin: 0; font-size: 28px; }
    .title p { margin: 6px 0 0; color: var(--muted); }
    .banner { align-items: center; justify-content: space-between; margin-bottom: 18px; background: linear-gradient(135deg, rgba(102,163,255,.12), rgba(52,211,153,.08)); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; }
    .banner code { color: var(--accent); font-size: 15px; word-break: break-all; }
    .btn, select { border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 10px; padding: 8px 12px; font: inherit; }
    .btn { cursor: pointer; }
    .btn:hover { filter: brightness(1.08); }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .metric, .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 14px; }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { font-size: 26px; font-weight: 700; margin-top: 6px; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .tabs { border-bottom: 1px solid var(--border); margin: 18px 0 14px; }
    .tab { padding: 10px 14px; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .panel { display: none; }
    .panel.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
    .card h3 { margin: 0 0 6px; font-size: 16px; }
    .sub { color: var(--muted); font-size: 12px; }
    .kv { display: grid; grid-template-columns: 110px 1fr; gap: 6px 10px; margin-top: 10px; font-size: 13px; }
    .k { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    .table-wrap { overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel2); font-size: 12px; }
    .empty { color: var(--muted); text-align: center; padding: 24px; }
    .meta-links { margin-top: 10px; }
    .action-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .action-row .btn { padding: 6px 10px; font-size: 12px; }
    .status-line { margin-top: 8px; color: var(--muted); font-size: 12px; }
    .toolbar { margin: 12px; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(4, 8, 18, 0.72); display: none; align-items: center; justify-content: center; padding: 20px; z-index: 50; }
    .modal-backdrop.open { display: flex; }
    .modal { width: min(680px, 100%); background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
    .modal h3 { margin: 0 0 6px; font-size: 18px; }
    .modal p { margin: 0 0 14px; color: var(--muted); }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label { color: var(--muted); font-size: 12px; }
    .field input, .field textarea, .field select { width: 100%; border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 10px; padding: 10px 12px; font: inherit; }
    .field textarea { min-height: 120px; resize: vertical; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 4px; }
    @media (max-width: 720px) { .form-grid { grid-template-columns: 1fr; } }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .toast-container { position: fixed; top: 20px; right: 20px; z-index: 100; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { pointer-events: auto; padding: 12px 18px; border-radius: 12px; font-size: 14px; color: var(--text); background: var(--panel2); border: 1px solid var(--border); box-shadow: 0 8px 24px rgba(0,0,0,.35); transform: translateX(120%); transition: transform .3s ease; max-width: 360px; word-break: break-word; }
    .toast.show { transform: translateX(0); }
    .toast.ok { border-color: var(--ok); }
    .toast.warn { border-color: var(--warn); }
    .toast.bad { border-color: var(--bad); }
    .card-toggle { cursor: pointer; color: var(--accent); font-size: 12px; margin-top: 8px; display: inline-block; }
    .card-toggle:hover { text-decoration: underline; }
    .card-extra { display: none; }
    .card-extra.expanded { display: block; }
  </style>
</head>
<body>
  <div class="toast-container" id="toastContainer"></div>
  <div class="shell">
    <div class="header">
      <div class="title">
        <h1>KeyPool 控制台</h1>
        <p>新架构兼容视图：Gateway / Agent / Manager / Skill-proxy 状态总览</p>
      </div>
      <div class="toolbar">
        <select id="refreshMs">
          <option value="0">自动刷新：关</option>
          <option value="5000">5 秒</option>
          <option value="10000" selected>10 秒</option>
          <option value="30000">30 秒</option>
        </select>
        <button class="btn" id="refreshBtn">刷新</button>
      </div>
    </div>

    <div class="banner">
      <div>
        <div class="sub">接入地址</div>
        <code id="accessUrl">-</code>
        <div class="meta-links">
          <a href="/health" target="_blank">/health</a>
          <a href="/admin/api/overview" target="_blank">/admin/api/overview</a>
          <a href="/admin/api/agents" target="_blank">/admin/api/agents</a>
          <a href="/admin/api/instances" target="_blank">/admin/api/instances</a>
          <a href="/admin/api/accounts" target="_blank">/admin/api/accounts</a>
          <a href="/admin/api/control/status" target="_blank">/admin/api/control/status</a>
        </div>
      </div>
      <div class="toolbar">
        <button class="btn" id="copyBtn">复制接入地址</button>
        <button class="btn" id="startManagerBtn">启动 Manager</button>
        <button class="btn" id="restartManagerBtn">重启 Manager</button>
        <button class="btn" id="stopManagerBtn">停止 Manager</button>
      </div>
    </div>

    <div class="metrics" id="metrics"></div>

    <div class="tabs">
      <div class="tab active" data-tab="agents">Agents</div>
      <div class="tab" data-tab="instances">实例</div>
      <div class="tab" data-tab="accounts">账号</div>
    </div>

    <div class="panel active" data-panel="agents"><div class="grid" id="agentsGrid"></div></div>
    <div class="panel" data-panel="instances"><div class="grid" id="instancesGrid"></div></div>
    <div class="panel" data-panel="accounts">
      <div class="table-wrap">
        <div class="toolbar">
          <button class="btn" id="newAccountBtn">新增账号</button>
        </div>
        <table>
          <thead><tr><th>ID</th><th>名称</th><th>启用</th><th>优先级</th><th>Weight</th><th>标签</th><th>Cookie</th><th>操作</th></tr></thead>
          <tbody id="accountsBody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="accountModalBackdrop" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="accountModalTitle">
      <h3 id="accountModalTitle">账号管理</h3>
      <p id="accountModalSubtitle">新增或编辑账号配置。保存后会自动写回 accounts.json。</p>
      <form id="accountForm">
        <input type="hidden" id="accountOriginalId">
        <div class="form-grid">
          <div class="field">
            <label for="accountIdInput">账号 ID</label>
            <input id="accountIdInput" name="id" required>
          </div>
          <div class="field">
            <label for="accountNameInput">名称</label>
            <input id="accountNameInput" name="name" required>
          </div>
          <div class="field">
            <label for="accountEnabledInput">是否启用</label>
            <select id="accountEnabledInput" name="enabled">
              <option value="true">启用</option>
              <option value="false">禁用</option>
            </select>
          </div>
          <div class="field">
            <label for="accountPriorityInput">优先级</label>
            <input id="accountPriorityInput" name="priority" type="number" step="1" value="100">
          </div>
          <div class="field">
            <label for="accountWeightInput">Weight（权重）</label>
            <input id="accountWeightInput" name="weight" type="number" step="1" min="0" value="100">
            <div class="hint">同优先级层内负载均衡权重，0 仍有基础概率。默认 100。</div>
          </div>
          <div class="field full">
            <label for="accountTagsInput">标签</label>
            <input id="accountTagsInput" name="tags" placeholder="例如：main, cn, backup">
          </div>
          <div class="field full">
            <label for="accountCookieInput">Cookie</label>
            <textarea id="accountCookieInput" name="cookie" placeholder="新增账号时必填；编辑时留空表示不修改现有 Cookie"></textarea>
            <div class="hint" id="accountCookieHint">新增账号时必须填写 Cookie；编辑时可留空，表示保持原值不变。</div>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancelAccountBtn">取消</button>
          <button type="submit" class="btn" id="saveAccountBtn">保存</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const state = { timer: null, accounts: [], modalMode: 'create' };
    function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
    function fmtAgo(ms) { if (!Number.isFinite(ms) || ms < 0) return '-'; if (ms < 1000) return ms + 'ms'; const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; }
    function statusPill(status) { const cls = ['ACTIVE','READY'].includes(status) ? 'ok' : ['FAILED','DESTROYED'].includes(status) ? 'bad' : 'warn'; return '<span class="pill ' + cls + '">' + escapeHtml(status || 'NONE') + '</span>'; }
    function metricCard(label, value, cls = '') { return '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value ' + cls + '">' + escapeHtml(value) + '</div></div>'; }
    function actionButtons(accountId) { return '<div class="action-row">' + '<button class="btn" data-action="deploy" data-account="' + escapeHtml(accountId) + '">部署</button>' + '<button class="btn" data-action="recover" data-account="' + escapeHtml(accountId) + '">恢复</button>' + '<button class="btn" data-action="destroy" data-account="' + escapeHtml(accountId) + '">销毁</button>' + '</div>'; }
    async function postJson(url) { const resp = await fetch(url, { method: 'POST' }); const text = await resp.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; } if (!resp.ok) { throw new Error(data?.message || data?.error || ('HTTP ' + resp.status)); } return data; }
    async function refresh() { const [overview, agentsRes, instancesRes, accountsRes] = await Promise.all([ fetch('/admin/api/overview').then(r => r.json()), fetch('/admin/api/agents').then(r => r.json()), fetch('/admin/api/instances').then(r => r.json()), fetch('/admin/api/accounts').then(r => r.json()) ]); const accounts = accountsRes.accounts || []; state.accounts = accounts; renderOverview(overview); renderAgents(agentsRes.agents || []); renderInstances(Object.values(instancesRes.instances || {})); renderAccounts(accounts); }
    function renderOverview(data) { document.getElementById('accessUrl').textContent = data?.service?.accessUrl || '-'; document.getElementById('metrics').innerHTML = [ metricCard('服务状态', data?.service?.status || '-'), metricCard('Manager', data?.service?.manager?.running ? '运行中' : '未运行', data?.service?.manager?.running ? 'ok' : 'warn'), metricCard('Agents', data?.metrics?.agents ?? 0), metricCard('Healthy', data?.metrics?.healthyAgents ?? 0, 'ok'), metricCard('Inflight', data?.metrics?.inflight ?? 0), metricCard('实例', data?.metrics?.instances ?? 0), metricCard('已验证', data?.metrics?.verifiedInstances ?? 0, 'ok'), metricCard('可重试失败', data?.metrics?.retryableFailures ?? 0, 'warn'), metricCard('History确认', data?.metrics?.historyConfirmedStages ?? 0, 'warn'), metricCard('异常', data?.metrics?.failedInstances ?? 0, 'bad') ].join(''); }
    function renderAgents(agents) { const root = document.getElementById('agentsGrid'); if (!agents.length) { root.innerHTML = '<div class="card empty">当前没有 Agent 连接到 Gateway</div>'; return; } root.innerHTML = agents.map(agent => { const health = agent.healthy ? '<span class="pill ok">健康</span>' : '<span class="pill bad">异常</span>'; return '<div class="card">' + '<h3>' + escapeHtml(agent.agentId) + '</h3>' + '<div class="sub">account=' + escapeHtml(agent.accountId) + ' · instance=' + escapeHtml(agent.instanceId || '-') + '</div>' + '<div style="margin-top:8px">' + health + '</div>' + '<div class="kv">' + '<div class="k">模型</div><div class="v mono">' + escapeHtml((agent.models || []).join(', ') || '-') + '</div>' + '<div class="k">连接时长</div><div class="v">' + escapeHtml(fmtAgo(agent.connectedAgoMs)) + '</div>' + '<div class="k">Inflight</div><div class="v">' + escapeHtml(agent.inflight) + '</div>' + '<div class="k">成功/失败</div><div class="v">' + escapeHtml(agent.successCount + ' / ' + agent.failureCount) + '</div>' + '<div class="k">平均延迟</div><div class="v">' + escapeHtml(agent.avgLatency + 'ms') + '</div>' + '</div></div>'; }).join(''); }
    function renderInstances(instances) { const root = document.getElementById('instancesGrid'); if (!instances.length) { root.innerHTML = '<div class="card empty">当前还没有实例状态记录</div>'; return; } root.innerHTML = instances.map(item => { const id = 'inst-' + escapeHtml(item.accountId); return '<div class="card">' + '<h3>' + escapeHtml(item.accountId) + '</h3>' + '<div class="sub">' + statusPill(item.status) + '</div>' + '<div class="kv">' + '<div class="k">部署模式</div><div class="v">' + escapeHtml(item.deployMode || '-') + '</div>' + '<div class="k">已验证</div><div class="v">' + escapeHtml(item.verified ? '是' : '否') + '</div>' + '<div class="k">Health OK</div><div class="v">' + escapeHtml(item.healthOk ? '是' : '否') + '</div>' + '<div class="k">绑定 Agent</div><div class="v mono">' + escapeHtml(item.agentId || '-') + '</div>' + '<div class="k">部署阶段</div><div class="v">' + escapeHtml(item.deployStage || '-') + ' / ' + escapeHtml(item.deployStatus || '-') + '</div>' + '<div class="k">最后部署</div><div class="v">' + escapeHtml(item.lastDeployAt || '-') + '</div>' + '</div>' + '<span class="card-toggle" onclick="toggleCard(\'' + id + '\')">展开详情 ▾</span>' + '<div class="card-extra" id="' + id + '">' + '<div class="kv">' + '<div class="k">确认来源</div><div class="v">' + escapeHtml(item.confirmationSource || '-') + '</div>' + '<div class="k">失败类型</div><div class="v">' + escapeHtml(item.failureType || '-') + '</div>' + '<div class="k">可重试</div><div class="v">' + escapeHtml(item.retryable ? '是' : '否') + '</div>' + '<div class="k">Proxy URL</div><div class="v mono">' + escapeHtml(item.proxyUrl || '-') + '</div>' + '<div class="k">Tailnet IP</div><div class="v mono">' + escapeHtml(item.currentTailnetIpUrl || '-') + '</div>' + '<div class="k">Tailnet 域名</div><div class="v mono">' + escapeHtml(item.currentTailnetUrl || '-') + '</div>' + '<div class="k">Share URL</div><div class="v mono">' + escapeHtml(item.currentShareUrl || '-') + '</div>' + '<div class="k">Local URL</div><div class="v mono">' + escapeHtml(item.currentLocalUrl || '-') + '</div>' + '<div class="k">部署次数</div><div class="v">' + escapeHtml(item.deployCount || 0) + '</div>' + '<div class="k">最后验证</div><div class="v">' + escapeHtml(item.lastVerifiedAt || '-') + '</div>' + '<div class="k">阶段轨迹</div><div class="v mono">' + escapeHtml((item.deployTimeline || []).map(step => [step?.stage || '?', step?.stageStatus || '?', step?.confirmationSource || '-'].join(':')).join(' | ') || '-') + '</div>' + '<div class="k">最近响应</div><div class="v mono">' + escapeHtml(item.responseText || '-') + '</div>' + '<div class="k">部署错误</div><div class="v">' + escapeHtml(item.lastDeployError || '-') + '</div>' + '<div class="k">健康错误</div><div class="v">' + escapeHtml(item.lastHealthError || '-') + '</div>' + '</div>' + '</div>' + actionButtons(item.accountId) + '<div class="status-line">当前状态：' + escapeHtml(item.status || '-') + '</div></div>'; }).join(''); }
    function toggleCard(id) { const el = document.getElementById(id); if (!el) return; el.classList.toggle('expanded'); const toggle = el.previousElementSibling; if (toggle) toggle.textContent = el.classList.contains('expanded') ? '收起 ▴' : '展开详情 ▾'; }
    function renderAccounts(accounts) { const body = document.getElementById('accountsBody'); if (!accounts.length) { body.innerHTML = '<tr><td colspan="8" class="empty">未找到账号配置</td></tr>'; return; } body.innerHTML = accounts.map(item => '<tr>' + '<td class="mono">' + escapeHtml(item.id) + '</td>' + '<td>' + escapeHtml(item.name) + '</td>' + '<td>' + escapeHtml(item.enabled ? '是' : '否') + '</td>' + '<td>' + escapeHtml(item.priority) + '</td>' + '<td>' + escapeHtml(item.weight ?? 100) + '</td>' + '<td>' + escapeHtml((item.tags || []).join(', ') || '-') + '</td>' + '<td>' + escapeHtml(item.hasCookie ? '已配置' : (item.hasCookieFile ? 'cookieFile' : '缺失')) + '</td>' + '<td><div class="action-row"><button class="btn" data-edit-account="' + escapeHtml(item.id) + '">编辑</button><button class="btn" data-delete-account="' + escapeHtml(item.id) + '">删除</button></div></td>' + '</tr>').join(''); }
    function bindTabs() { document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.panel').forEach(p => p.classList.remove('active')); tab.classList.add('active'); document.querySelector('[data-panel="' + tab.dataset.tab + '"]').classList.add('active'); })); }
    function bindRefresh() { const select = document.getElementById('refreshMs'); const applyTimer = () => { if (state.timer) clearInterval(state.timer); const ms = Number(select.value || 0); if (ms > 0) state.timer = setInterval(() => refresh().catch(showError), ms); }; select.addEventListener('change', applyTimer); applyTimer(); document.getElementById('refreshBtn').addEventListener('click', () => refresh().catch(showError)); }
    function openAccountModal(mode, initial = {}) {
      state.modalMode = mode;
      document.getElementById('accountModalTitle').textContent = mode === 'create' ? '新增账号' : '编辑账号';
      document.getElementById('accountModalSubtitle').textContent = mode === 'create'
        ? '创建新账号，保存后会写回 accounts.json 并自动重载 Manager。'
        : '编辑账号配置。若 Cookie 留空，则保持原值不变。';
      document.getElementById('accountOriginalId').value = initial.id || '';
      document.getElementById('accountIdInput').value = initial.id || '';
      document.getElementById('accountNameInput').value = initial.name || initial.id || '';
      document.getElementById('accountEnabledInput').value = initial.enabled === false ? 'false' : 'true';
      document.getElementById('accountPriorityInput').value = Number.isFinite(Number(initial.priority)) ? Number(initial.priority) : 100;
      document.getElementById('accountWeightInput').value = Number.isFinite(Number(initial.weight)) ? Math.max(0, Math.round(Number(initial.weight))) : 100;
      document.getElementById('accountTagsInput').value = Array.isArray(initial.tags) ? initial.tags.join(', ') : (initial.tags || '');
      document.getElementById('accountCookieInput').value = '';
      document.getElementById('accountCookieHint').textContent = mode === 'create'
        ? '新增账号时必须填写 Cookie。'
        : '编辑账号时可留空，表示保持原值不变；填写则会覆盖旧 Cookie。';
      document.getElementById('accountModalBackdrop').classList.add('open');
      document.getElementById('accountModalBackdrop').setAttribute('aria-hidden', 'false');
      setTimeout(() => document.getElementById('accountIdInput').focus(), 0);
    }
    function closeAccountModal() {
      document.getElementById('accountModalBackdrop').classList.remove('open');
      document.getElementById('accountModalBackdrop').setAttribute('aria-hidden', 'true');
      document.getElementById('accountForm').reset();
      document.getElementById('accountOriginalId').value = '';
    }
    function collectAccountFormPayload() {
      return {
        id: document.getElementById('accountIdInput').value.trim(),
        name: document.getElementById('accountNameInput').value.trim(),
        enabled: document.getElementById('accountEnabledInput').value !== 'false',
        priority: Number(document.getElementById('accountPriorityInput').value || 100),
        weight: Number(document.getElementById('accountWeightInput').value || 100),
        tags: document.getElementById('accountTagsInput').value.trim(),
        cookie: document.getElementById('accountCookieInput').value.trim(),
      };
    }

    function showToast(msg, type = 'ok') { const c = document.getElementById('toastContainer'); const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = msg; c.appendChild(el); requestAnimationFrame(() => el.classList.add('show')); setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000); }
    function bindActions() {
      document.getElementById('copyBtn').addEventListener('click', async () => { const text = document.getElementById('accessUrl').textContent || ''; try { await navigator.clipboard.writeText(text); showToast('已复制接入地址'); } catch (error) { showToast('复制失败：' + error.message, 'bad'); } });
      document.getElementById('newAccountBtn').addEventListener('click', () => openAccountModal('create', { enabled: true, priority: 100, weight: 100, tags: [] }));
      document.getElementById('cancelAccountBtn').addEventListener('click', () => closeAccountModal());
      document.getElementById('accountModalBackdrop').addEventListener('click', (event) => { if (event.target.id === 'accountModalBackdrop') closeAccountModal(); });
      document.getElementById('accountForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = collectAccountFormPayload();
        if (!payload.id) return showToast('账号 ID 不能为空', 'bad');
        if (!payload.name) return showToast('账号名称不能为空', 'bad');
        if (state.modalMode === 'create' && !payload.cookie) return showToast('新增账号时必须填写 Cookie', 'bad');
        try {
          const originalId = document.getElementById('accountOriginalId').value.trim();
          const isCreate = state.modalMode === 'create';
          const url = isCreate ? '/admin/api/accounts' : ('/admin/api/accounts/' + encodeURIComponent(originalId || payload.id));
          const method = isCreate ? 'POST' : 'PUT';
          const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          const text = await res.text();
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
          if (!res.ok) throw new Error(data?.message || ('HTTP ' + res.status));
          closeAccountModal();
          showToast(data.message || (isCreate ? '账号已创建' : '账号已更新'));
          await refresh();
        } catch (error) { showError(error); }
      });
      document.getElementById('startManagerBtn').addEventListener('click', async () => { try { const res = await postJson('/admin/api/control/start'); showToast(res.message || 'Manager 已启动'); await refresh(); } catch (error) { showError(error); } });
      document.getElementById('restartManagerBtn').addEventListener('click', async () => { try { const res = await postJson('/admin/api/control/restart'); showToast(res.message || 'Manager 已重启'); await refresh(); } catch (error) { showError(error); } });
      document.getElementById('stopManagerBtn').addEventListener('click', async () => { try { const res = await postJson('/admin/api/control/stop'); showToast(res.message || 'Manager 已停止'); await refresh(); } catch (error) { showError(error); } });
      document.body.addEventListener('click', async (event) => { const button = event.target.closest('button[data-action]'); if (!button) return; const action = button.dataset.action; const account = button.dataset.account; if (!account || !action) return; if (!confirm('确认对 ' + account + ' 执行 ' + action + '？')) return; try { const res = await postJson('/admin/api/accounts/' + encodeURIComponent(account) + '/' + action); showToast(res.ok ? ('执行成功：' + account + ' / ' + action) : (res.message || '执行失败'), res.ok ? 'ok' : 'bad'); await refresh(); } catch (error) { showError(error); } });
      document.body.addEventListener('click', async (event) => { const button = event.target.closest('button[data-edit-account]'); if (!button) return; const accountId = button.dataset.editAccount; const account = state.accounts.find(item => item.id === accountId); if (!account) return showToast('未找到账号 ' + accountId, 'bad'); openAccountModal('edit', account); });
      document.body.addEventListener('click', async (event) => { const button = event.target.closest('button[data-delete-account]'); if (!button) return; const account = button.dataset.deleteAccount; if (!account || !confirm('确认删除账号 ' + account + '？此操作会写回 accounts.json 并重载 Manager。')) return; try { const res = await fetch('/admin/api/accounts/' + encodeURIComponent(account), { method: 'DELETE' }); const text = await res.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; } if (!res.ok) throw new Error(data?.message || ('HTTP ' + res.status)); showToast(data.message || '账号已删除'); await refresh(); } catch (error) { showError(error); } });
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAccountModal(); });
    }
    function showError(error) { console.error(error); showToast(error?.message || String(error), 'bad'); }
    bindTabs(); bindRefresh(); bindActions(); refresh().catch(showError);
  </script>
</body>
</html>`;
}

/**
 * Admin 路由分发
 * - 声明式路由表替代 18 个 if 分支
 * - 统一 JSON 响应格式 + 错误处理
 */

import { auditLog } from './audit.mjs';
import {
  buildManagerStatus,
  startManager,
  stopManager,
  restartManager,
  reloadAccounts,
  runAccountAction,
  createAccount,
  updateAccount,
  deleteAccount,
  updateAccountCookie,
} from './handlers.mjs';
import {
  buildOverview,
  buildAgents,
  buildInstances,
  loadAccountsSummary,
} from './builders.mjs';
import { renderAdminPage } from './frontend.mjs';

/** JSON 响应 */
function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

/** Action result → JSON（ok ? 200 : 400） */
function jsonResult(res, result) {
  json(res, result, result.ok ? 200 : 400);
}

/**
 * 创建 Admin API 处理器
 * @param {import('../registry.mjs').Registry} registry
 * @param {object} [context]
 * @param {ReturnType<import('../../manager/index.mjs').createManager>} [context.manager]
 * @returns {Function}
 */
export function createAdminHandler(registry, context = {}) {
  const mgr = () => context.manager;

  // ── 声明式路由表 ──
  // path: 精确路径匹配（string）
  // pattern: 正则匹配（RegExp），捕获组作为 params 传入 handler
  // method: 省略 = 任意方法，string = 精确匹配，array = 其中之一
  // handler: (req, res, url, params[]) => void | Promise<void>
  const routes = [
    // ── HTML 页面 ──
    { path: '/admin', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderAdminPage());
    }},
    { path: '/admin/', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderAdminPage());
    }},

    // ── GET：概览 / 状态 / 列表 ──
    { path: '/admin/api/overview', handler: (req, res, url) =>
      json(res, buildOverview(registry, req, context)) },
    { path: '/admin/api/control/status', handler: (req, res) =>
      json(res, { ok: true, manager: buildManagerStatus(mgr()) }) },
    { path: '/admin/api/agents', handler: (req, res) =>
      json(res, { agents: buildAgents(registry) }) },
    { path: '/admin/api/instances', handler: (req, res) =>
      json(res, { instances: buildInstances(registry) }) },
    { path: '/admin/api/accounts', method: 'GET', handler: (req, res) =>
      json(res, loadAccountsSummary()) },
    { path: '/admin/api/audit', handler: (req, res, url) => {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      json(res, { entries: auditLog.slice(-limit).reverse() });
    }},

    // ── Health ──
    { path: '/health', handler: (req, res) => {
      const healthyAgents = registry.getHealthy();
      const instanceStates = [...registry.getAllInstances().values()];
      const verifiedInstances = instanceStates.filter(s => s?.verified || s?.status === 'ACTIVE');
      const deployingInstances = instanceStates.filter(s => ['DEPLOYING', 'DEPLOYED_UNVERIFIED', 'READY', 'RECOVERING'].includes(s?.status));
      const failedInstances = instanceStates.filter(s => s?.status === 'FAILED');
      json(res, {
        status: verifiedInstances.length > 0 || healthyAgents.length > 0 ? 'ok' : 'degraded',
        agents: healthyAgents.length,
        verifiedInstances: verifiedInstances.length,
        deployingInstances: deployingInstances.length,
        failedInstances: failedInstances.length,
      });
    }},

    // ── POST：Manager 控制 ──
    { path: '/admin/api/control/start', method: 'POST',
      handler: async (req, res) => jsonResult(res, await startManager(mgr())) },
    { path: '/admin/api/control/stop', method: 'POST',
      handler: async (req, res) => jsonResult(res, await stopManager(mgr())) },
    { path: '/admin/api/control/restart', method: 'POST',
      handler: async (req, res) => jsonResult(res, await restartManager(mgr())) },
    { path: '/admin/api/accounts/reload', method: 'POST',
      handler: async (req, res) => jsonResult(res, reloadAccounts(mgr())) },

    // ── POST：账号创建 ──
    { path: '/admin/api/accounts', method: 'POST',
      handler: async (req, res) => jsonResult(res, await createAccount(mgr(), req)) },

    // ── 参数化路由（正则） ──
    // cookie 更新
    { pattern: /^\/admin\/api\/accounts\/([^/]+)\/cookie$/, method: 'POST',
      handler: async (req, res, url, [accountId]) =>
        jsonResult(res, await updateAccountCookie(mgr(), accountId, req)) },
    // 实例操作（deploy / recover / destroy / stop）
    { pattern: /^\/admin\/api\/accounts\/([^/]+)\/(deploy|recover|destroy|stop)$/, method: 'POST',
      handler: async (req, res, url, [accountId, action]) =>
        jsonResult(res, await runAccountAction(mgr(), accountId, action)) },
    // 账号更新
    { pattern: /^\/admin\/api\/accounts\/([^/]+)$/, method: 'PUT',
      handler: async (req, res, url, [accountId]) =>
        jsonResult(res, await updateAccount(mgr(), accountId, req)) },
    // 账号删除
    { pattern: /^\/admin\/api\/accounts\/([^/]+)$/, method: 'DELETE',
      handler: async (req, res, url, [accountId]) =>
        jsonResult(res, await deleteAccount(mgr(), accountId)) },
  ];

  return async function handleAdmin(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    for (const route of routes) {
      // 匹配路径
      let params = null;
      if (route.path) {
        if (pathname !== route.path) continue;
      } else if (route.pattern) {
        const match = pathname.match(route.pattern);
        if (!match) continue;
        params = match.slice(1);
      }

      // 匹配方法
      if (route.method) {
        const ok = Array.isArray(route.method) ? route.method.includes(method) : method === route.method;
        if (!ok) continue;
      }

      // 执行
      try {
        await route.handler(req, res, url, params || []);
      } catch (error) {
        if (!res.headersSent) {
          json(res, { error: 'internal_error', message: error?.message || String(error) }, 500);
        }
      }
      return;
    }

    // 404 兜底
    json(res, { error: 'Not found' }, 404);
  };
}

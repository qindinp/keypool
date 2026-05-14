/**
 * Admin 路由分发
 * - 挂载所有 /admin/* 和 /health 路由
 * - 统一 JSON 响应格式
 */

import { auditLog } from './audit.mjs';
import {
  buildManagerStatus,
  startManager,
  stopManager,
  restartManager,
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

/**
 * 创建 Admin API 处理器
 * @param {import('../registry.mjs').Registry} registry
 * @param {object} [context]
 * @param {ReturnType<import('../../manager/index.mjs').createManager>} [context.manager]
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

    if (url.pathname === '/admin/api/audit') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ entries: auditLog.slice(-limit).reverse() }, null, 2));
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

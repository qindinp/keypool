#!/usr/bin/env node
/**
 * KeyPool Relay — HTTP 服务器 + 路由分发
 *
 * 从原 relay/server.mjs 精简而来，Admin API 和 Control API 已拆分到独立模块。
 */

import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createRegistry } from '../manager/registry.mjs';
import { getAccountsPath } from '../manager/accounts.mjs';
import { pickUpstream, listFallbackUpstreams } from './router.mjs';
import { proxyJson, proxyStream } from './proxy.mjs';
import { sendJson, sendHtml, readBody, safeJsonParse } from './utils.mjs';
import { createControlApi } from './control-api.mjs';
import { createAdminApi } from './admin-api.mjs';

// ─── 初始化 ──────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.RELAY_PORT || '9300', 10);
const host = process.env.RELAY_HOST || '127.0.0.1';
const registryPath = process.env.RELAY_REGISTRY_PATH
  ? resolve(process.env.RELAY_REGISTRY_PATH)
  : resolve(__dirname, '..', '..', '.manager', 'registry.json');
const registry = createRegistry(registryPath);
const MAX_ATTEMPTS = parseInt(process.env.RELAY_MAX_ATTEMPTS || '3', 10);
const rootDir = resolve(__dirname, '..', '..');
const adminHtmlPath = resolve(rootDir, 'relay', 'admin.html');
const managerDataDir = resolve(rootDir, '.manager');
const accountsPath = getAccountsPath();
const appBgScriptPath = resolve(rootDir, 'scripts', 'app-bg.mjs');

// ─── 子模块初始化 ────────────────────────────────────────────────

const control = createControlApi({ rootDir, appBgScriptPath });
const admin = createAdminApi({
  registry,
  rootDir,
  managerDataDir,
  accountsPath,
  host,
  port,
  adminHtmlPath,
  managerStatus: control.managerStatus,
  appStatus: control.appStatus,
  restartManagerProcess: control.restartManagerProcess,
});

// ─── Admin HTML ──────────────────────────────────────────────────

function loadAdminHtml() {
  if (existsSync(adminHtmlPath)) {
    return readFileSync(adminHtmlPath, 'utf-8');
  }
  return `<!doctype html><meta charset="utf-8"><title>KeyPool Relay Admin</title><body><h1>admin.html missing</h1></body>`;
}

// ─── 代理相关工具函数 ────────────────────────────────────────────

function candidateList() {
  const primary = pickUpstream(registry);
  if (!primary) return [];
  return [primary, ...listFallbackUpstreams(registry, [primary.accountId])].slice(0, MAX_ATTEMPTS);
}

function passthroughHeaders(headers) {
  const allow = [
    'content-type',
    'cache-control',
    'x-request-id',
    'x-accel-buffering',
  ];
  const next = {};
  for (const key of allow) {
    if (headers[key]) next[key] = headers[key];
  }
  return next;
}

function isStreamingRequest(path, body) {
  if (!(
    path.startsWith('/v1/chat/completions') ||
    path.startsWith('/v1/messages') ||
    path.startsWith('/v1/responses')
  )) return false;
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

// ─── 代理转发逻辑 ────────────────────────────────────────────────

async function forwardViaUpstream(upstream, req, path, body, onAbort) {
  registry.markInflight(upstream.accountId, 1);
  const startMs = Date.now();
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

    const responseMs = Date.now() - startMs;

    if (result.statusCode === 429) {
      // 429 限流：标记为限流状态，跳过但不视为严重故障
      registry.markFailure(upstream.accountId, 'rate limited (429)', { statusCode: 429 });
      return { ok: false, retryable: true, upstream, result, rateLimited: true };
    }

    if (result.statusCode >= 500) {
      registry.markFailure(upstream.accountId, `upstream ${result.statusCode}`, { statusCode: result.statusCode });
      return { ok: false, retryable: true, upstream, result };
    }

    registry.markSuccess(upstream.accountId, { lastStatusCode: result.statusCode, responseMs });
    return { ok: true, upstream, result, responseMs };
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
  for (let i = 0; i < upstreams.length; i++) {
    const upstream = upstreams[i];
    registry.markInflight(upstream.accountId, 1);
    let responseStarted = false;
    let dataWritten = false;
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
        onResponse: (upstreamRes, upstreamReq) => {
          const statusCode = upstreamRes.statusCode || 502;

          // 429 限流：不消费响应，让外层 fallback 到下一个 upstream
          if (statusCode === 429) {
            let errorBody = '';
            upstreamRes.on('data', c => { errorBody += c.toString(); });
            upstreamRes.on('end', () => {
              registry.markFailure(upstream.accountId, 'rate limited (429)', { statusCode: 429 });
              attempts.push({
                accountId: upstream.accountId,
                baseUrl: upstream.baseUrl,
                statusCode: 429,
                error: 'rate limited',
                rateLimited: true,
              });
            });
            upstreamRes.on('error', () => {});
            return;
          }

          if (statusCode >= 500) {
            let errorBody = '';
            upstreamRes.on('data', c => { errorBody += c.toString(); });
            upstreamRes.on('end', () => {
              registry.markFailure(upstream.accountId, `upstream ${statusCode}`, { statusCode });
              attempts.push({
                accountId: upstream.accountId,
                baseUrl: upstream.baseUrl,
                statusCode,
                error: errorBody || `upstream ${statusCode}`,
              });
            });
            upstreamRes.on('error', () => {});
            return;
          }

          responseStarted = true;
          registry.markSuccess(upstream.accountId, { lastStatusCode: statusCode });

          // 设置响应头，添加诊断头标识实际来源和尝试次数
          const respHeaders = passthroughHeaders(upstreamRes.headers);
          respHeaders['x-keypool-upstream'] = upstream.accountId || 'unknown';
          respHeaders['x-keypool-attempt'] = String(i + 1);
          res.writeHead(statusCode, respHeaders);

          onAbort(() => {
            upstreamRes.destroy(new Error('客户端已断开'));
            upstreamReq.destroy(new Error('客户端已断开'));
            if (!res.writableEnded) res.end();
          });

          upstreamRes.on('data', chunk => {
            dataWritten = true;
            res.write(chunk);
          });
          upstreamRes.on('end', () => res.end());
          upstreamRes.on('error', (error) => {
            if (!isClientAbortError(error)) {
              registry.markFailure(upstream.accountId, error.message);
              // 流式传输中途失败：写入 SSE 错误事件让客户端优雅处理
              if (dataWritten && !res.writableEnded) {
                try {
                  res.write(`data: ${JSON.stringify({ error: { message: 'upstream stream interrupted', type: 'upstream_error' } })}\n\n`);
                  res.write('data: [DONE]\n\n');
                } catch {}
              }
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

  // 所有 upstream 都失败，返回结构化错误
  return sendJson(res, 502, {
    error: 'all_upstreams_failed',
    message: `已尝试 ${attempts.length} 个上游，全部失败`,
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
  if (isStreamingRequest(path, body)) {
    return handleStreamProxy(req, res, path, body);
  }

  const onAbort = bindClientAbort(req);
  const attempts = [];
  for (let i = 0; i < upstreams.length; i++) {
    const upstream = upstreams[i];
    const forwarded = await forwardViaUpstream(upstream, req, path, body, onAbort);
    if (forwarded.ok) {
      const respHeaders = passthroughHeaders(forwarded.result.headers);
      respHeaders['x-keypool-upstream'] = upstream.accountId || 'unknown';
      respHeaders['x-keypool-attempt'] = String(i + 1);
      if (forwarded.responseMs) respHeaders['x-keypool-response-ms'] = String(forwarded.responseMs);
      res.writeHead(forwarded.result.statusCode, respHeaders);
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
      rateLimited: forwarded.rateLimited || false,
    });

    if (!forwarded.retryable) break;
  }

  return sendJson(res, 502, {
    error: 'all_upstreams_failed',
    message: `已尝试 ${attempts.length} 个上游，全部失败`,
    attempts,
  });
}

// ─── HTTP 服务器 + 路由分发 ──────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/' || url.pathname === '/admin') {
      return sendHtml(res, 200, loadAdminHtml());
    }

    if (url.pathname.startsWith('/api/control/')) {
      return control.handleControlApi(req, res, url);
    }

    if (url.pathname.startsWith('/api/admin/')) {
      return await admin.handleAdminApi(req, res, url);
    }

    if (url.pathname === '/health') {
      const data = registry.load();
      const upstreams = data.upstreams || [];
      const now = Date.now();
      const healthy = upstreams.filter(u => u.healthy).length;
      const rateLimited = upstreams.filter(u => u.rateLimitedUntil && u.rateLimitedUntil > now).length;
      const coolingDown = upstreams.filter(u => u.cooldownUntil && u.cooldownUntil > now && (!u.rateLimitedUntil || u.rateLimitedUntil <= now)).length;
      return sendJson(res, healthy > 0 ? 200 : 503, {
        ok: healthy > 0,
        healthyUpstreams: healthy,
        rateLimitedUpstreams: rateLimited,
        coolingDownUpstreams: coolingDown,
        totalUpstreams: upstreams.length,
        updatedAt: data.updatedAt,
      });
    }

    if (url.pathname === '/registry') {
      return sendJson(res, 200, registry.load());
    }

    if (
      url.pathname === '/v1/models' ||
      url.pathname === '/v1/embeddings' ||
      url.pathname === '/v1/chat/completions' ||
      url.pathname === '/v1/messages' ||
      url.pathname === '/v1/responses'
    ) {
      return handleProxy(req, res, url.pathname + url.search);
    }

    return sendJson(res, 404, {
      error: 'not_found',
      message: '支持的路径: / /admin /api/control/status /api/control/start /api/control/stop /api/control/restart /api/control/app/status /api/control/app/start /api/control/app/stop /api/control/all/start /api/admin/overview /api/admin/logs /api/admin/accounts /api/admin/accounts/:id/deploy /api/admin/accounts/:id/recover /api/admin/accounts/:id/destroy /health /registry /v1/models /v1/embeddings /v1/chat/completions /v1/messages /v1/responses',
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'relay_internal_error', message: e.message });
  }
});

server.listen(port, host, () => {
  console.log(`✅ relay 已启动: http://${host}:${port}`);
  console.log(`📁 registry: ${registryPath}`);
});

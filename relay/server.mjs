#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../controller/registry.mjs';
import { pickUpstream, listFallbackUpstreams } from './router.mjs';
import { proxyJson } from './proxy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.RELAY_PORT || '9300', 10);
const host = process.env.RELAY_HOST || '127.0.0.1';
const registryPath = resolve(__dirname, '..', '.manager', 'registry.json');
const registry = createRegistry(registryPath);
const MAX_ATTEMPTS = parseInt(process.env.RELAY_MAX_ATTEMPTS || '3', 10);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n';
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
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

async function forwardViaUpstream(upstream, req, path, body) {
  registry.markInflight(upstream.accountId, 1);
  try {
    const result = await proxyJson({
      baseUrl: upstream.baseUrl,
      method: req.method,
      path,
      body,
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
    registry.markFailure(upstream.accountId, e.message);
    return { ok: false, retryable: true, upstream, error: e };
  } finally {
    registry.markInflight(upstream.accountId, -1);
  }
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
  const attempts = [];

  for (const upstream of upstreams) {
    const forwarded = await forwardViaUpstream(upstream, req, path, body);
    if (forwarded.ok) {
      res.writeHead(forwarded.result.statusCode, {
        'content-type': forwarded.result.headers['content-type'] || 'application/json; charset=utf-8',
      });
      res.end(forwarded.result.body);
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

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

    if (url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions') {
      return handleProxy(req, res, url.pathname + url.search);
    }

    return sendJson(res, 404, {
      error: 'not_found',
      message: '支持的路径: /health /registry /v1/models /v1/chat/completions',
    });
  } catch (e) {
    return sendJson(res, 500, { error: 'relay_internal_error', message: e.message });
  }
});

server.listen(port, host, () => {
  console.log(`✅ relay 已启动: http://${host}:${port}`);
  console.log(`📁 registry: ${registryPath}`);
});

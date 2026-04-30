#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../controller/registry.mjs';
import { pickUpstream } from './router.mjs';
import { proxyJson } from './proxy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.RELAY_PORT || '9300', 10);
const host = process.env.RELAY_HOST || '127.0.0.1';
const registryPath = resolve(__dirname, '..', '.manager', 'registry.json');
const registry = createRegistry(registryPath);

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

async function handleProxy(req, res, path) {
  const upstream = pickUpstream(registry);
  if (!upstream) {
    return sendJson(res, 503, {
      error: 'no_healthy_upstream',
      message: '当前没有可用上游，请先运行 manager 完成部署并同步 registry',
    });
  }

  const body = req.method === 'GET' ? null : await readBody(req);
  registry.markInflight(upstream.accountId, 1);
  try {
    const result = await proxyJson({
      baseUrl: upstream.baseUrl,
      method: req.method,
      path,
      body,
    });

    const next = registry.load();
    const row = (next.upstreams || []).find(u => u.accountId === upstream.accountId);
    if (row) {
      row.lastOkAt = Date.now();
      row.lastStatusCode = result.statusCode;
      row.healthy = result.statusCode < 500;
      next.updatedAt = new Date().toISOString();
      registry.save(next);
    }

    res.writeHead(result.statusCode, {
      'content-type': result.headers['content-type'] || 'application/json; charset=utf-8',
    });
    res.end(result.body);
  } catch (e) {
    const next = registry.load();
    const row = (next.upstreams || []).find(u => u.accountId === upstream.accountId);
    if (row) {
      row.healthy = false;
      row.lastError = e.message;
      next.updatedAt = new Date().toISOString();
      registry.save(next);
    }
    sendJson(res, 502, {
      error: 'upstream_request_failed',
      accountId: upstream.accountId,
      message: e.message,
    });
  } finally {
    registry.markInflight(upstream.accountId, -1);
  }
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

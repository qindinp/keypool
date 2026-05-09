#!/usr/bin/env node
/**
 * KeyPool Proxy — MiMo API 代理服务
 *
 * 运行在沙箱实例上，代理 MiMo API 请求。
 * 由 OpenClaw skill 管理，通过 exec 工具启动。
 *
 * 环境变量：
 *   MIMO_API_KEY          — 自动从 /root/.openclaw/.env 读取
 *   MIMO_BASE_URL         — 默认 https://api-oc.xiaomimimo.com/v1
 *   KEYPOOL_PROXY_PORT    — 默认 9200
 */

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';

// ─── 读取环境变量 ─────────────────────────────────────────────

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const instanceEnv = readEnvFile('/root/.openclaw/.env');
const apiKey = process.env.MIMO_API_KEY || instanceEnv.MIMO_API_KEY;
if (!apiKey) {
  console.error('MIMO_API_KEY missing');
  process.exit(1);
}

const baseUrl = (process.env.MIMO_BASE_URL || instanceEnv.MIMO_BASE_URL || 'https://api-oc.xiaomimimo.com/v1').replace(/\/$/, '');
const PORT = parseInt(process.env.KEYPOOL_PROXY_PORT || '9200');

// ─── HTTP 代理 ────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', baseUrl, hasKey: !!apiKey, port: PORT }));
    return;
  }

  // Proxy to MiMo API
  if (url.pathname.startsWith('/v1/')) {
    const body = req.method === 'GET' ? null : await readBody(req);
    const target = new URL(url.pathname + url.search, baseUrl);

    const proxyReq = httpsRequest({
      hostname: target.hostname,
      port: 443,
      path: target.pathname + target.search,
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'authorization': `Bearer ${apiKey}`,
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
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
    });

    proxyReq.setTimeout(120_000, () => proxyReq.destroy(new Error('upstream timeout')));
    if (body) proxyReq.write(body);
    proxyReq.end();
    return;
  }

  // Info
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    name: 'KeyPool Proxy',
    version: '0.1.0',
    port: PORT,
    endpoints: {
      'POST /v1/chat/completions': 'Chat completions',
      'GET /v1/models': 'List models',
      'GET /health': 'Health check',
    },
  }));
});

// ─── 启动 ─────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KeyPool Proxy running on http://127.0.0.1:${PORT}`);
  console.log(`Proxying to ${baseUrl}`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

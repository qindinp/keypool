#!/usr/bin/env node
/**
 * 自包含代理 — API Key 内嵌，不读 .env
 * 用于安全规则严格的沙箱环境
 */

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PORT = 9200;

// 从环境变量或启动参数获取 API Key
const apiKey = process.env.MIMO_API_KEY || process.argv[2];
if (!apiKey) {
  console.error('Usage: node proxy.mjs <API_KEY>');
  process.exit(1);
}

const baseUrl = (process.env.MIMO_BASE_URL || 'https://api-oc.xiaomimimo.com/v1').replace(/\/$/, '');

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
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', baseUrl, hasKey: !!apiKey, port: PORT }));
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
  res.end(JSON.stringify({ name: 'KeyPool Proxy', version: '0.2.0', port: PORT }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KeyPool Proxy on http://127.0.0.1:${PORT}`);
  console.log(`Proxying to ${baseUrl}`);
});
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

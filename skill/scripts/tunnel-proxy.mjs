#!/usr/bin/env node
/**
 * KeyPool Tunnel Proxy — 主入口
 *
 * 1. 定位 ws 模块（项目本地 or OpenClaw 自带）
 * 2. 从沙箱 OpenClaw 环境读取 API 配置（不注入 Key）
 * 3. 启动 HTTP 健康检查服务（127.0.0.1:9201）
 * 4. 连接 Gateway WebSocket
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// ─── 配置 ──────────────────────────────────────────────────

function envOrTemplate(envName, templateValue) {
  const value = process.env[envName];
  if (value && value.trim()) return value.trim();
  if (templateValue && !/^__.+__$/.test(templateValue)) return templateValue;
  console.error(`[tunnel-proxy] missing required env ${envName}`);
  process.exit(1);
}

const GATEWAY_WS_URL = envOrTemplate('KEYPOOL_GATEWAY_URL', '__KEYPOOL_GATEWAY_URL__');
const ACCOUNT_ID = envOrTemplate('KEYPOOL_ACCOUNT_ID', '__KEYPOOL_ACCOUNT_ID__');
const RUN_ID = envOrTemplate('KEYPOOL_RUN_ID', '__KEYPOOL_RUN_ID__');
const HEALTH_PORT = Number(process.env.KEYPOOL_HEALTH_PORT || 9201);

// ─── 1. 定位 ws 模块 ─────────────────────────────────────

const require = createRequire(import.meta.url);

let WebSocket;
try {
  WebSocket = (await import('ws')).default;
} catch {
  try {
    const wsPath = require.resolve('ws', { paths: ['/usr/lib/node_modules/openclaw'] });
    WebSocket = (await import(wsPath)).default;
  } catch {
    console.error('[tunnel-proxy] ws module not found (tried project + openclaw)');
    process.exit(1);
  }
}

// ─── 2. 加载配置 ──────────────────────────────────────────

function readOpenClawConfig() {
  try {
    const raw = readFileSync('/root/.openclaw/openclaw.json', 'utf-8');
    const config = JSON.parse(raw);
    const providers = config?.models?.providers;
    if (!providers || typeof providers !== 'object') return {};

    // 优先查找 xiaomi，其次取第一个有 apiKey 的 provider
    const providerOrder = ['xiaomi', ...Object.keys(providers).filter(k => k !== 'xiaomi')];
    for (const name of providerOrder) {
      const p = providers[name];
      if (p?.apiKey) {
        return {
          apiKey: p.apiKey,
          baseUrl: p.baseUrl || 'https://api-oc.xiaomimimo.com/v1',
        };
      }
    }
    return {};
  } catch {
    return {};
  }
}

const ocConfig = readOpenClawConfig();
const API_KEY = process.env.MIMO_API_KEY || ocConfig.apiKey;
const BASE_URL = (process.env.MIMO_API_ENDPOINT?.replace(/\/chat\/completions$/, '')
  || ocConfig.baseUrl
  || 'https://api-oc.xiaomimimo.com/v1').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('[tunnel-proxy] API key not found (checked MIMO_API_KEY env + openclaw.json)');
  process.exit(1);
}

console.log('[tunnel-proxy] baseUrl:', BASE_URL);
console.log('[tunnel-proxy] hasKey:', !!API_KEY);
console.log('[tunnel-proxy] gateway:', GATEWAY_WS_URL);
console.log('[tunnel-proxy] account:', ACCOUNT_ID);

// ─── 3. 创建 ApiHandler ──────────────────────────────────

const { ApiHandler } = await import('./lib/api-handler.mjs');
const apiHandler = new ApiHandler({ apiKey: API_KEY, baseUrl: BASE_URL });

// ─── 4. 运行时统计（供健康检查） ─────────────────────────

const stats = {
  startedAt: Date.now(),
  requestCount: 0,
  lastRequestAt: null,
  lastError: null,
  lastErrorAt: null,
  consecutiveErrors: 0,
};

// ─── 5. HTTP 健康检查 ────────────────────────────────────

let wsClientRef = null;

const httpServer = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const tunnelStatus = wsClientRef?.status || 'disconnected';
  const status = (tunnelStatus === 'connected' && stats.consecutiveErrors < 5) ? 'ok' : 'degraded';

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    status,
    accountId: ACCOUNT_ID,
    runId: RUN_ID,
    tunnel: tunnelStatus,
    uptimeMs: Date.now() - stats.startedAt,
    requestCount: stats.requestCount,
    lastRequestAt: stats.lastRequestAt,
    lastError: stats.lastError,
    lastErrorAt: stats.lastErrorAt,
    consecutiveErrors: stats.consecutiveErrors,
    reconnectAttempt: wsClientRef?.reconnectAttempt || 0,
    gateway: GATEWAY_WS_URL,
    mimoApi: BASE_URL,
    // 不返回 API_KEY
  }));
});

httpServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[tunnel-proxy] 健康检查: http://127.0.0.1:${HEALTH_PORT}/health`);
});

// ─── 6. 连接 Gateway ─────────────────────────────────────

const { WsClient } = await import('./lib/ws-client.mjs');

wsClientRef = new WsClient({
  WebSocket,
  gatewayWsUrl: GATEWAY_WS_URL,
  accountId: ACCOUNT_ID,
  runId: RUN_ID,
  apiHandler,
  stats,
});

wsClientRef.connect();

// ─── 7. 信号处理 ─────────────────────────────────────────

function shutdown() {
  console.log('[tunnel-proxy] shutting down...');
  wsClientRef?.close();
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

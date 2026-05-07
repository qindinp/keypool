#!/usr/bin/env node
/**
 * KeyPool — OpenAI API Key Pool Proxy
 *
 * 零依赖 Node.js 代理，聚合多个 API Key，智能轮转 + 故障转移。
 *
 * 模块拆分：
 *   - server/config.mjs      — 配置加载 & OpenClaw 检测
 *   - server/key-pool.mjs    — Key 池管理
 *   - server/proxy.mjs       — HTTP 代理核心（有限重试 + 超时）
 *   - server/anthropic-adapter.mjs — Anthropic ↔ OpenAI 格式转换
 *   - server/tunnel.mjs      — SSH 隧道管理
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { KeyPool } from './key-pool.mjs';
import { proxyRequest, readBody } from './proxy.mjs';
import {
  anthropicToOpenAI,
  proxyAnthropicSync,
  proxyAnthropicStream,
} from './anthropic-adapter.mjs';
import { startTunnel, stopTunnel } from './tunnel/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, '..', 'config.json');

// ─── 加载配置 ────────────────────────────────────────────────────
const config = loadConfig(CONFIG_PATH);

const PORT = config.port || 9200;
const BASE_URL = config.baseUrl || 'https://api.openai.com';
const LOG_LEVEL = config.logLevel || 'info';
const HEALTH_CHECK_INTERVAL = config.healthCheckIntervalMs || 5 * 60 * 1000;
const KEY_RETRY_DELAY = config.keyRetryDelayMs || 60 * 1000;
const AVAILABLE_MODELS = config.models || [];
const TUNNEL_ENABLED = config.tunnel !== false;
const TUNNEL_TYPE = config.tunnelType || 'tailscale';
const TUNNEL_SERVICE = config.tunnelService || 'localhost.run';
const TAILSCALE_CONFIG = config.tailscale || {};
const MAX_RETRIES = config.maxRetries || 3;

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? 1;

function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= currentLogLevel) {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = { debug: '🔍', info: 'ℹ️ ', warn: '⚠️ ', error: '❌' }[level] || '  ';
    console.log(`[${ts}] ${prefix}`, ...args);
  }
}

// ─── 初始化 KeyPool ──────────────────────────────────────────────
const pool = new KeyPool(config.keys || [], {
  keyRetryDelay: KEY_RETRY_DELAY,
  log,
});
pool.setDefaultBaseUrl(BASE_URL);

// 定期恢复 key
setInterval(() => pool.recoverKeys(), HEALTH_CHECK_INTERVAL);

// ─── 路由 ────────────────────────────────────────────────────────
function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── Pool stats ──
  if (path === '/pool/stats' && req.method === 'GET') {
    const stats = pool.getStats();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ keys: stats }, null, 2));
  }

  // ── Pool models ──
  if (path === '/pool/models' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      models: AVAILABLE_MODELS,
      sources: pool.keys.map((k) => ({ id: k.id, baseUrl: k.baseUrl || BASE_URL })),
    }, null, 2));
  }

  // ── Health ──
  if (path === '/health') {
    const enabled = pool.keys.filter((k) => k.enabled).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', enabledKeys: enabled, totalKeys: pool.keys.length }));
  }

  // ── Anthropic API: POST /v1/messages ──
  if (path === '/v1/messages' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const anthropicReq = JSON.parse(body);
        const keyEntry = pool.pick();
        if (!keyEntry) {
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'No available API keys' },
          }));
        }

        const openaiReq = anthropicToOpenAI(anthropicReq);
        const model = anthropicReq.model || 'gpt-4';
        const isStream = !!anthropicReq.stream;

        log('info', `→ POST /v1/messages [${keyEntry.id}] Anthropic→OpenAI (model: ${model}, stream: ${isStream})`);

        if (isStream) {
          proxyAnthropicStream(keyEntry, openaiReq, model, res, pool, log, MAX_RETRIES);
        } else {
          proxyAnthropicSync(keyEntry, openaiReq, model, res, pool, log, MAX_RETRIES);
        }
      } catch (e) {
        log('error', `Anthropic request parse error: ${e.message}`);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: e.message },
        }));
      }
    }).catch((e) => {
      log('error', `Request body read error: ${e.message}`);
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: e.message },
      }));
    });
    return;
  }

  // ── /v1/models — 优先返回本地已知模型列表 ──
  if (path === '/v1/models' && req.method === 'GET') {
    if (AVAILABLE_MODELS.length > 0) {
      const models = AVAILABLE_MODELS.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.id.split('/')[0] || 'keypool',
        name: m.name,
        reasoning: m.reasoning || false,
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models }, null, 2));
    }
  }

  // ── Proxy to upstream (OpenAI 兼容路径) ──
  if (path.startsWith('/v1/')) {
    readBody(req).then((body) => {
      const keyEntry = pool.pick();
      if (!keyEntry) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: { message: 'No available API keys', type: 'pool_exhausted' },
        }));
      }
      log('debug', `→ ${req.method} ${path} [${keyEntry.id}]`);
      proxyRequest({
        keyEntry, pool, req, res, body,
        retryCount: 0,
        maxRetries: pool.keys.length - 1, // 最多重试到下一个 key
        log,
      });
    }).catch((e) => {
      log('error', `Request body read error: ${e.message}`);
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'request_error' } }));
    });
    return;
  }

  // ── Catch-all: 使用信息 ──
  res.writeHead(200, { 'content-type': 'application/json' });
  let tunnelUrl = null;
  let tunnelUrlStale = false;
  try {
    const urlFile = resolve(__dirname, '..', '.tunnel-url');
    if (existsSync(urlFile)) {
      const raw = readFileSync(urlFile, 'utf-8').trim();
      if (raw.startsWith('#stale')) {
        // 读取 #stale 后面的 URL
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        const urlLine = lines.find(l => !l.startsWith('#'));
        if (urlLine) {
          tunnelUrl = urlLine;
          tunnelUrlStale = true;
        }
      } else {
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        tunnelUrl = lines[0] || null;
      }
    }
  } catch {}
  res.end(
    JSON.stringify(
      {
        name: 'KeyPool',
        version: '0.4.0',
        description: 'OpenAI API Key Pool Proxy',
        endpoints: {
          'POST /v1/chat/completions': 'Chat completions (OpenAI compatible)',
          'GET  /v1/models': 'List models',
          'POST /v1/embeddings': 'Embeddings',
          'POST /v1/messages': 'Anthropic Messages API (auto-convert)',
          'GET  /pool/stats': 'Key pool usage stats',
          'GET  /pool/models': 'List all known models with details',
          'GET  /health': 'Health check',
        },
        keys: pool.keys.length,
        models: AVAILABLE_MODELS.length,
        maxRetries: MAX_RETRIES,
        tunnel: tunnelUrl ? (tunnelUrlStale ? `${tunnelUrl} (stale)` : tunnelUrl) : 'disabled',
        usage: `Set OPENAI_BASE_URL to http://127.0.0.1:${PORT}/v1${tunnelUrl ? ` or ${tunnelUrl}/v1` : ''}`,
      },
      null,
      2,
    ),
  );
}

// ─── 启动服务器 ──────────────────────────────────────────────────
const server = createServer(handleRequest);

server.listen(PORT, () => {
  log('info', `🚀 KeyPool running on http://127.0.0.1:${PORT}`);
  log('info', `   Proxying to ${BASE_URL}`);
  log('info', `   ${pool.keys.length} key(s) loaded, max retries: ${MAX_RETRIES}`);
  if (AVAILABLE_MODELS.length > 0) {
    log('info', `   ${AVAILABLE_MODELS.length} model(s) available:`);
    for (const m of AVAILABLE_MODELS) {
      log('info', `     • ${m.id}${m.reasoning ? ' 🧠' : ''}`);
    }
  }
  log('info', `   Set OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1 to use`);
  log('info', `   GET /pool/stats for usage, GET /health for status`);

  if (TUNNEL_ENABLED) {
    startTunnel(PORT, {
      tunnelType: TUNNEL_TYPE,
      sshService: TUNNEL_SERVICE,
      tailscaleConfig: TAILSCALE_CONFIG,
      log,
      onUrl: (url) => {
        log('info', `🔗 隧道 URL: ${url}`);
      },
    });
  }
});

// ─── 优雅关闭 ────────────────────────────────────────────────────
function shutdown(signal) {
  log('info', `收到 ${signal}，正在关闭...`);
  stopTunnel();
  server.close(() => {
    log('info', '服务器已关闭');
    process.exit(0);
  });
  // 15 秒后强制退出（给 SSE 流式请求留足时间）
  setTimeout(() => process.exit(1), 15000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

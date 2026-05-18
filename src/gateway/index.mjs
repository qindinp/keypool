/**
 * Gateway 主入口
 *
 * 单进程：HTTP 服务器
 * HTTP：接收用户请求（/v1/chat/completions, /v1/messages, /v1/models, /admin, /health）
 *
 * 不再包含 WS 服务器（已移除 Agent WS 路由）
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Registry } from './registry.mjs';
import { createProxyHandler, readBody } from './proxy.mjs';
import { createAdminHandler } from './admin/index.mjs';
import { anthropicToOpenAI, openAIToAnthropic } from './adapter.mjs';
import { createTunnelServer } from './tunnel.mjs';
import { stripModelPrefix, stripUnsupportedParams, fixMimoReasoningContent, getMimoTunnelTimeoutMs } from './proxy.mjs';
import { createSSETransformer } from './sse-transformer.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')).version;

function makeRequestId() {
  return `kp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function collectModels(registry, tunnel) {
  const models = new Map();
  const upstreams = registry.getVerifiedUpstreams();

  for (const upstream of upstreams) {
    const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;

    // HTTP 直连模式
    if (baseUrl) {
      try {
        const res = await fetch(new URL('/v1/models', baseUrl).toString());
        if (!res.ok) continue;
        const payload = await res.json();
        for (const item of Array.isArray(payload?.data) ? payload.data : []) {
          if (!item?.id) continue;
          models.set(item.id, {
            id: item.id,
            object: item.object || 'model',
            owned_by: item.owned_by || upstream.accountId,
          });
        }
      } catch (err) {
        console.warn(`⚠️ collectModels [${upstream.accountId}]: ${err.message}`);
      }
      continue;
    }

    // Tunnel 模式：通过 tunnel 查询远端 /v1/models
    if (upstream.tunnel) {
      try {
        const resp = await tunnel.sendProxyRequest(upstream.tunnel, {
          method: 'GET',
          path: '/v1/models',
          headers: { 'content-type': 'application/json' },
        }, { timeoutMs: 10_000 });
        const payload = JSON.parse(resp.body || '{}');
        for (const item of Array.isArray(payload?.data) ? payload.data : []) {
          if (!item?.id) continue;
          models.set(item.id, {
            id: item.id,
            object: item.object || 'model',
            owned_by: item.owned_by || upstream.accountId,
          });
        }
      } catch (err) {
        console.warn(`⚠️ collectModels [tunnel:${upstream.accountId}]: ${err.message}`);
      }
    }
  }

  if (models.size === 0 && upstreams.length > 0) {
    for (const id of [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
    ]) {
      models.set(id, { id, object: 'model', owned_by: 'keypool' });
    }
  }

  return [...models.values()];
}

/**
 * 创建 Gateway
 * @param {object} config - { port, host, manager }
 * @returns {{ start: Function, close: Function, registry: Registry }}
 */
export function createGateway(config) {
  const registry = new Registry();
  const adminContext = { manager: config.manager || null };

  function setManager(manager) {
    adminContext.manager = manager;
  }

  const tunnel = createTunnelServer(registry);
  const proxyHandler = createProxyHandler(registry, tunnel.sendProxyRequest);
  const adminHandler = createAdminHandler(registry, adminContext);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const requestId = req.headers['x-request-id'] || req.headers['x-keypool-request-id'] || makeRequestId();
      req.keypoolRequestId = requestId;
      res.setHeader('x-keypool-request-id', requestId);

      // Root — 返回 Gateway 状态（CCSwitch 等工具验证端点用）
      if ((url.pathname === '/' || url.pathname === '/v1') && req.method === 'GET') {
        const verifiedCount = registry.getVerifiedUpstreams().length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          name: 'KeyPool Gateway',
          version: VERSION,
          status: 'ok',
          endpoints: {
            health: '/health',
            models: '/v1/models',
            chat: '/v1/chat/completions',
            messages: '/v1/messages',
            admin: '/admin',
          },
          upstreams: verifiedCount,
        }));
        return;
      }

      // Local-only debug endpoint: bypass KeyPool sanitizer and send the raw body
      // through the selected upstream. This is intentionally before the generic
      // /admin handler so localhost diagnostics can test native upstream params.
      if (url.pathname === '/admin/api/debug/raw-chat' && req.method === 'POST') {
        return handleRawChatDebugRequest(req, res, await readBody(req), registry, tunnel);
      }

      // Admin / Health
      if (url.pathname === '/health' || url.pathname.startsWith('/admin')) {
        return adminHandler(req, res);
      }

      // /v1/models
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = await collectModels(registry, tunnel);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }

      // 读取请求体
      const body = await readBody(req);

      // Anthropic → OpenAI 转换
      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        return handleAnthropicRequest(req, res, body);
      }

      // OpenAI 直接代理
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return proxyHandler(req, res, body);
      }

      // 404
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found', type: 'not_found' } }));
    } catch (err) {
      console.error('❌ HTTP handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: 'Internal error', type: 'server_error' } }));
    }
  });

  async function handleRawChatDebugRequest(req, res, body, registry, tunnel) {
    const remote = req.socket?.remoteAddress || '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === 'localhost';
    if (!isLocal) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'raw debug endpoint is localhost-only', type: 'forbidden' } }));
      return;
    }

    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }));
      return;
    }

    const model = stripModelPrefix(parsed.model || 'mimo-v2.5-pro');
    parsed.model = model;
    const rawBody = JSON.stringify(parsed);
    const upstream = registry.chooseVerifiedUpstream(model);
    if (!upstream) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No healthy upstream available', type: 'service_unavailable' } }));
      return;
    }

    try {
      let upstreamResp;
      if (upstream.tunnel && tunnel.sendProxyRequest) {
        upstreamResp = await tunnel.sendProxyRequest(upstream.tunnel, {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', 'x-keypool-raw-debug': '1' },
          body: rawBody,
        }, { timeoutMs: getMimoTunnelTimeoutMs(rawBody, model) });
      } else {
        const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;
        if (!baseUrl) throw new Error('No upstream connection available');
        const response = await fetch(new URL('/v1/chat/completions', baseUrl).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-keypool-raw-debug': '1' },
          body: rawBody,
        });
        upstreamResp = { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: (upstreamResp.status || 200) < 400,
        upstreamStatus: upstreamResp.status || 200,
        accountId: upstream.accountId,
        body: upstreamResp.body || '',
      }));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message || 'raw debug request failed', type: 'proxy_error' } }));
    }
  }

  // ─── Anthropic 请求子函数 ─────────────────────────────────

  /**
   * 解析 Anthropic body 并转换为 OpenAI 格式
   * @returns {{ openaiBody: string, model: string, isStream: boolean } | { error: true, status: number, message: string }}
   */
  function prepareAnthropicBody(body) {
    let anthropicBody;
    try {
      anthropicBody = JSON.parse(body);
    } catch {
      return { error: true, status: 400, message: 'Invalid JSON' };
    }

    const isStream = !!anthropicBody.stream;
    const openaiReq = anthropicToOpenAI(anthropicBody);
    const model = stripModelPrefix(anthropicBody.model || 'unknown');

    const originalOpenAIModel = openaiReq.model;
    const strippedOpenAIModel = stripModelPrefix(originalOpenAIModel);
    if (strippedOpenAIModel !== originalOpenAIModel) {
      openaiReq.model = strippedOpenAIModel;
      console.log(`🔧 anthropic adapter strip model prefix: "${originalOpenAIModel}" → "${strippedOpenAIModel}"`);
    }

    let finalOpenAI = { ...openaiReq };
    const paramResult = stripUnsupportedParams(finalOpenAI, openaiReq.model);
    if (paramResult) {
      finalOpenAI = paramResult.result;
      console.log(`🔧 anthropic adapter strip unsupported params: ${paramResult.removedParams.join(', ')}`);
    }

    const fixResult = fixMimoReasoningContent(finalOpenAI, openaiReq.model);
    if (fixResult?.patched) {
      finalOpenAI = fixResult.result;
    }

    const openaiBody = JSON.stringify(finalOpenAI);
    try {
      console.log(`📤 anthropic forwarding keys: [${Object.keys(finalOpenAI).join(', ')}] model=${finalOpenAI.model}`);
    } catch {}

    return { openaiBody, model, isStream };
  }

  async function handleTunnelAnthropic(upstream, openaiBody, model, isStream, requestId, res) {
    try {
      if (isStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });

        const sseState = { started: false, blockIndex: 0, thinkingStarted: false, thinkingClosed: false, textStarted: false, textClosed: false, model };
        const transformer = createSSETransformer(sseState, res);

        await tunnel.sendProxyRequest(upstream.tunnel, {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
          body: openaiBody,
        }, { onChunk: (buf) => transformer.processChunk(buf), timeoutMs: getMimoTunnelTimeoutMs(openaiBody, model) });

        transformer.flush();
        res.end();
      } else {
        const tunnelResp = await tunnel.sendProxyRequest(upstream.tunnel, {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
          body: openaiBody,
        }, { timeoutMs: getMimoTunnelTimeoutMs(openaiBody, model) });

        const status = tunnelResp.status || 200;
        if (status >= 400) {
          registry.markProxyUpstreamError(upstream.accountId, status, tunnelResp.body);
          const errBody = tunnelResp.body || '';
          let errMessage;
          try {
            const parsed = JSON.parse(errBody);
            errMessage = parsed.error?.message || parsed.message || errBody;
          } catch {
            errMessage = errBody || `upstream returned HTTP ${status}`;
          }
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `API Error: ${status} ${errMessage}` } }));
          return;
        }

        const oaiResp = JSON.parse(tunnelResp.body || '{}');
        const anthropicResp = openAIToAnthropic(oaiResp, model);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicResp));
      }

      registry.markProxySuccess(upstream.accountId, 0);
    } catch (err) {
      registry.markProxyFailure(upstream.accountId, err.message);
      console.error(`❌ tunnel anthropic proxy failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);
      if (res.headersSent) {
        if (!res.writableEnded) { try { res.end(); } catch {} }
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
      }
    }
  }

  async function handleHttpAnthropic(upstream, openaiBody, model, isStream, requestId, res) {
    const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;
    if (!baseUrl) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'service_unavailable', message: 'No upstream connection' } }));
      return;
    }

    const targetUrl = new URL('/v1/chat/completions', baseUrl).toString();

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': isStream ? 'text/event-stream' : 'application/json', ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
        body: openaiBody,
      });

      if (isStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });

        const sseState = { started: false, blockIndex: 0, thinkingStarted: false, thinkingClosed: false, textStarted: false, textClosed: false, model };
        const transformer = createSSETransformer(sseState, res);
        const decoder = new TextDecoder();

        for await (const chunk of response.body) {
          transformer.processChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(decoder.decode(chunk, { stream: true })));
        }

        transformer.flush();
        res.end();
      } else {
        const errBody = await response.text();
        if (response.status >= 400) {
          registry.markProxyUpstreamError(upstream.accountId, response.status, errBody);
          let errMessage;
          try {
            const parsed = JSON.parse(errBody);
            errMessage = parsed.error?.message || parsed.message || errBody;
          } catch {
            errMessage = errBody || `upstream returned HTTP ${response.status}`;
          }
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `API Error: ${response.status} ${errMessage}` } }));
          return;
        }
        const oaiResp = JSON.parse(errBody || '{}');
        const anthropicResp = openAIToAnthropic(oaiResp, model);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicResp));
      }

      registry.markProxySuccess(upstream.accountId, 0);
    } catch (err) {
      registry.markProxyFailure(upstream.accountId, err.message);
      console.error(`❌ http anthropic proxy failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);
      if (res.headersSent) {
        if (!res.writableEnded) { try { res.end(); } catch {} }
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
      }
    }
  }

  // ─── Anthropic 请求调度器 ─────────────────────────────────
  async function handleAnthropicRequest(req, res, body) {
    const prepared = prepareAnthropicBody(body);
    if (prepared.error) {
      res.writeHead(prepared.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: prepared.message } }));
      return;
    }

    const { openaiBody, model, isStream } = prepared;
    const requestId = req.keypoolRequestId || req.headers['x-request-id'] || req.headers['x-keypool-request-id'] || null;

    const upstream = registry.chooseVerifiedUpstream(model);
    if (!upstream) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'service_unavailable', message: 'No upstream' } }));
      return;
    }

    if (upstream.tunnel && tunnel.sendProxyRequest) {
      await handleTunnelAnthropic(upstream, openaiBody, model, isStream, requestId, res);
    } else {
      await handleHttpAnthropic(upstream, openaiBody, model, isStream, requestId, res);
    }
  }

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(config.port, config.host || '0.0.0.0', () => {
        console.log(`🚀 Gateway 启动: http://${config.host || '0.0.0.0'}:${config.port}`);
        console.log(`   Admin: http://localhost:${config.port}/admin`);
        console.log(`   Health: http://localhost:${config.port}/health`);
        console.log(`   Tunnel: ws://${config.host || '0.0.0.0'}:${config.port}/tunnel`);
        resolve();
      });

      // WebSocket upgrade: /tunnel
      httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/tunnel') {
          tunnel.handleUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });
    });
  }

  function close() {
    httpServer.close();
  }

  return { start, close, registry, httpServer, setManager };
}

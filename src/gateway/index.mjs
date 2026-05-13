/**
 * Gateway 主入口
 *
 * 单进程：HTTP 服务器
 * HTTP：接收用户请求（/v1/chat/completions, /v1/messages, /v1/models, /admin, /health）
 *
 * 不再包含 WS 服务器（已移除 Agent WS 路由）
 */

import { createServer } from 'node:http';
import { PassThrough } from 'node:stream'; // kept for potential future use
import { Registry } from './registry.mjs';
import { createProxyHandler, readBody } from './proxy.mjs';
import { createAdminHandler } from './admin.mjs';
import { anthropicToOpenAI, openAIToAnthropic, openAIChunkToAnthropicEvents } from './adapter.mjs';
import { createTunnelServer } from './tunnel.mjs';
import { stripModelPrefix, stripUnsupportedParams, fixMimoReasoningContent, getMimoTunnelTimeoutMs } from './proxy.mjs';

function makeRequestId() {
  return `kp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
          version: '1.0.0',
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

      // Admin / Health
      if (url.pathname === '/health' || url.pathname.startsWith('/admin')) {
        return adminHandler(req, res);
      }

      // /v1/models
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const models = await collectModels(registry);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }

      // 读取请求体
      const body = await readBody(req);

      // Anthropic → OpenAI 转换
      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        return handleAnthropicRequest(req, res, body, registry, proxyHandler);
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

  async function collectModels(registry) {
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
      // 部分 tunnel 上游不实现 /v1/models；仍可正常转发 chat 请求。
      // 返回常用 Claude 模型，避免 CCSwitch / SDK 因空模型列表误判 Base URL 无效。
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

  // Anthropic 请求处理
  async function handleAnthropicRequest(req, res, body, registry, proxyHandler) {
    let anthropicBody;
    try {
      anthropicBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      return;
    }

    const requestId = req.keypoolRequestId || req.headers['x-request-id'] || req.headers['x-keypool-request-id'] || null;
    const isStream = !!anthropicBody.stream;
    const openaiReq = anthropicToOpenAI(anthropicBody);
    const model = stripModelPrefix(anthropicBody.model || 'unknown');
    // Strip provider prefix from the converted request model as well
    const originalOpenAIModel = openaiReq.model;
    const strippedOpenAIModel = stripModelPrefix(originalOpenAIModel);
    if (strippedOpenAIModel !== originalOpenAIModel) {
      openaiReq.model = strippedOpenAIModel;
      console.log(`🔧 anthropic adapter strip model prefix: "${originalOpenAIModel}" → "${strippedOpenAIModel}"`);
    }
    // Strip unsupported params for MiMo upstream
    const paramResult = stripUnsupportedParams(JSON.stringify(openaiReq));
    let openaiBody;
    if (paramResult) {
      openaiBody = paramResult.strippedBody;
      console.log(`🔧 anthropic adapter strip unsupported params: ${paramResult.removedParams.join(', ')}`);
    } else {
      openaiBody = JSON.stringify(openaiReq);
    }
    // Fix MiMo reasoning_content requirement
    const fixResult = fixMimoReasoningContent(openaiBody, openaiReq.model);
    if (fixResult.patched) {
      openaiBody = fixResult.fixedBody;
    }
    // Debug: log final forwarded body
    try {
      const finalParsed = JSON.parse(openaiBody);
      console.log(`📤 anthropic forwarding keys: [${Object.keys(finalParsed).join(', ')}] model=${finalParsed.model}`);
    } catch {}

    const upstream = registry.chooseVerifiedUpstream(openaiReq.model);
    if (!upstream) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'service_unavailable', message: 'No upstream' } }));
      return;
    }

    let response;

    // ─── Tunnel 模式 ───────────────────────────────────────
    if (upstream.tunnel && tunnel.sendProxyRequest) {
      try {
        if (isStream) {
          // 流式：通过 onChunk 回调实时转换 OpenAI SSE → Anthropic SSE
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });

          const state = {
            started: false, blockIndex: 0,
            thinkingStarted: false, thinkingClosed: false,
            textStarted: false, textClosed: false,
            model,
          };

          let lineBuf = '';

          function onChunk(buf, isFirst, status, headers) {
            // 每个 chunk 到达时同步处理
            lineBuf += buf.toString();
            let nlIdx;
            while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
              const line = lineBuf.slice(0, nlIdx).trim();
              lineBuf = lineBuf.slice(nlIdx + 1);
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') continue;
              try {
                const oaiChunk = JSON.parse(payload);
                const events = openAIChunkToAnthropicEvents(oaiChunk, state);
                for (const event of events) {
                  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                }
              } catch (err) {
                console.warn(`⚠️ SSE chunk parse error: ${err.message}`);
              }
            }
          }

          await tunnel.sendProxyRequest(upstream.tunnel, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
            body: openaiBody,
          }, { onChunk, timeoutMs: getMimoTunnelTimeoutMs(openaiBody, openaiReq.model) });

          // 处理 lineBuf 中可能残留的最后一行
          if (lineBuf.trim()) {
            const line = lineBuf.trim();
            if (line.startsWith('data: ')) {
              const payload = line.slice(6).trim();
              if (payload !== '[DONE]') {
                try {
                  const oaiChunk = JSON.parse(payload);
                  const events = openAIChunkToAnthropicEvents(oaiChunk, state);
                  for (const event of events) {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                  }
                } catch {}
              }
            }
          }

          if (state.started && !state.textClosed && !state.thinkingClosed) {
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          }
          res.end();
        } else {
          // 非流式
          const tunnelResp = await tunnel.sendProxyRequest(upstream.tunnel, {
            method: 'POST',
            path: '/v1/chat/completions',
            headers: { 'content-type': 'application/json', ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
            body: openaiBody,
          }, { timeoutMs: getMimoTunnelTimeoutMs(openaiBody, openaiReq.model) });
          const oaiResp = JSON.parse(tunnelResp.body || '{}');
          const anthropicResp = openAIToAnthropic(oaiResp, model);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(anthropicResp));
        }

        registry.markProxySuccess(upstream.accountId, 0);
        return;
      } catch (err) {
        registry.markProxyFailure(upstream.accountId, err.message);
        console.error(`❌ tunnel anthropic proxy failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);
        if (res.headersSent) {
          if (!res.writableEnded) { try { res.end(); } catch {} }
        } else {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
        }
        return;
      }
    }

    // ─── HTTP 直连模式 ─────────────────────────────────────
    const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;
    if (!baseUrl) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'service_unavailable', message: 'No upstream connection' } }));
      return;
    }

    const targetUrl = new URL('/v1/chat/completions', baseUrl).toString();

    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': isStream ? 'text/event-stream' : 'application/json', ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
        body: openaiBody,
      });

      if (isStream) {
        // 流式：OpenAI SSE → Anthropic SSE
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        });

        const state = {
          started: false, blockIndex: 0,
          thinkingStarted: false, thinkingClosed: false,
          textStarted: false, textClosed: false,
          model,
        };

        let lineBuf = '';
        const encoder = new TextDecoder();

        for await (const chunk of response.body) {
          lineBuf += encoder.decode(chunk, { stream: true });
          let nlIdx;
          while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nlIdx).trim();
            lineBuf = lineBuf.slice(nlIdx + 1);
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const oaiChunk = JSON.parse(payload);
              const events = openAIChunkToAnthropicEvents(oaiChunk, state);
              for (const event of events) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
              }
            } catch (err) {
              console.warn(`⚠️ SSE chunk parse error: ${err.message}`);
            }
          }
        }

        // 确保 message_stop
        if (state.started && !state.textClosed && !state.thinkingClosed) {
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        }
        res.end();
      } else {
        // 非流式
        const oaiResp = await response.json();
        const anthropicResp = openAIToAnthropic(oaiResp, model);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicResp));
      }

      registry.markProxySuccess(upstream.accountId, 0);
    } catch (err) {
      registry.markProxyFailure(upstream.accountId, err.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
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

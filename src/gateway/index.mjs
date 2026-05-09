/**
 * Gateway 主入口
 *
 * 单进程：HTTP 服务器
 * HTTP：接收用户请求（/v1/chat/completions, /v1/messages, /v1/models, /admin, /health）
 *
 * 不再包含 WS 服务器（已移除 Agent WS 路由）
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from './registry.mjs';
import { createProxyHandler, readBody } from './proxy.mjs';
import { createAdminHandler } from './admin.mjs';
import { anthropicToOpenAI, openAIToAnthropic, openAIChunkToAnthropicEvents } from './adapter.mjs';
import { createTunnelServer } from './tunnel.mjs';

/**
 * 创建 Gateway
 * @param {object} config - { port, host, manager }
 * @returns {{ start: Function, close: Function, registry: Registry }}
 */
export function createGateway(config) {
  const registry = new Registry();
  const adminContext = { manager: config.manager || null };
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  function setManager(manager) {
    adminContext.manager = manager;
  }

  const tunnel = createTunnelServer(registry);
  const proxyHandler = createProxyHandler(registry, tunnel.sendProxyRequest);
  const adminHandler = createAdminHandler(registry, adminContext);

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // Admin / Health
      if (url.pathname === '/health' || url.pathname.startsWith('/admin')) {
        return adminHandler(req, res);
      }

      // 文件服务（部署用）
      if (url.pathname.startsWith('/files/')) {
        const fileName = decodeURIComponent(url.pathname.slice('/files/'.length));
        if (!/^[\w.\-]+$/.test(fileName)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid file name' } }));
          return;
        }
        const filePath = resolve(workspaceRoot, fileName);
        if (!existsSync(filePath)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Not found' } }));
          return;
        }
        const content = readFileSync(filePath);
        res.writeHead(200, {
          'content-type': filePath.endsWith('.mjs') || filePath.endsWith('.js')
            ? 'application/javascript; charset=utf-8'
            : 'application/octet-stream',
          'content-length': String(content.length),
          'cache-control': 'no-store',
        });
        res.end(content);
        return;
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
      if (!baseUrl) continue;
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

    const isStream = !!anthropicBody.stream;
    const openaiReq = anthropicToOpenAI(anthropicBody);
    const model = anthropicBody.model || 'unknown';
    const openaiBody = JSON.stringify(openaiReq);

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
        const tunnelResp = await tunnel.sendProxyRequest(upstream.tunnel, {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: { 'content-type': 'application/json', 'accept': isStream ? 'text/event-stream' : 'application/json' },
          body: openaiBody,
        });

        if (isStream) {
          // Tunnel 返回的是缓冲的完整响应，需要重新解析为 Anthropic SSE
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

          // tunnelResp.body 是完整的 SSE 文本
          const lines = (tunnelResp.body || '').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6).trim();
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

          if (state.started && !state.textClosed && !state.thinkingClosed) {
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          }
          res.end();
        } else {
          // 非流式
          const oaiResp = JSON.parse(tunnelResp.body || '{}');
          const anthropicResp = openAIToAnthropic(oaiResp, model);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(anthropicResp));
        }

        registry.markProxySuccess(upstream.accountId, 0);
        return;
      } catch (err) {
        registry.markProxyFailure(upstream.accountId, err.message);
        console.error(`❌ tunnel anthropic proxy failed [${upstream.accountId}]: ${err.message}`);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
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
        headers: { 'content-type': 'application/json', 'accept': isStream ? 'text/event-stream' : 'application/json' },
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

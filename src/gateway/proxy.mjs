import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gateway 请求代理 — 支持 Tunnel（WS 反连）和 HTTP 直连
 *
 * 职责：
 * 1. 解析请求中的 model 字段
 * 2. Strip provider prefix (e.g. "xiaomi/") from model name before forwarding upstream
 * 3. 从 Registry 选择 verified upstream
 * 4. 优先通过 Tunnel（WS）转发，回退到 HTTP fetch
 * 5. 无可用 upstream 时返回 503
 */

/**
 * 已知的 provider 前缀，strip 后再转发给上游 API
 * OpenClaw 等客户端可能用 "xiaomi/mimo-v2.5-pro" 格式，但 MiMo API 只认 "mimo-v2.5-pro"
 */
const PROVIDER_PREFIXES = ['xiaomi/', 'microsoft/', 'google/', 'anthropic/', 'openai/'];

/**
 * Strip provider prefix from model name
 * "xiaomi/mimo-v2.5-pro" → "mimo-v2.5-pro"
 * "mimo-v2-flash" → "mimo-v2-flash" (unchanged)
 */
export function stripModelPrefix(model) {
  if (!model) return model;
  for (const prefix of PROVIDER_PREFIXES) {
    if (model.startsWith(prefix)) return model.slice(prefix.length);
  }
  return model;
}

/**
 * MiMo native parameter probe notes (2026-05-13):
 * - Confirmed rejected: n=2 -> 400 "n is not supported".
 * - Confirmed accepted/ignored with HTTP 200: logprobs, top_logprobs,
 *   store, parallel_tool_calls, text_verbosity, verbosity,
 *   reasoning_effort, metadata, user, response_format, tools/tool_choice,
 *   max_completion_tokens, and unknown top-level fields.
 *
 * Keep the sanitizer deliberately narrow. Over-stripping accepted fields makes
 * KeyPool diverge from Xiaomi's OpenAI-compatible surface and can hide useful
 * client behavior. Only remove fields known to break MiMo, plus normalize the
 * OpenAI max_completion_tokens alias to max_tokens for older compatibility.
 */
const MIMO_REJECTED_PARAMS = new Set([
  'n', // MiMo returns 400: "n is not supported" when n != 1
]);

/**
 * Strip unsupported params from request body for MiMo upstream
 * Returns { strippedBody, removedParams } or null if nothing changed
 */
export function stripUnsupportedParams(body, model = null) {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    const effectiveModel = stripModelPrefix(model || parsed.model || '');
    if (effectiveModel && !effectiveModel.startsWith('mimo-')) return null;

    const removed = [];

    // OpenAI newer clients send max_completion_tokens, while MiMo's
    // OpenAI-compatible endpoint accepts the older max_tokens name.
    // Preserve the user's limit instead of dropping it when possible.
    if ('max_completion_tokens' in parsed) {
      if (!('max_tokens' in parsed)) {
        parsed.max_tokens = parsed.max_completion_tokens;
        removed.push(`max_completion_tokens=${JSON.stringify(parsed.max_completion_tokens)}->max_tokens`);
      } else {
        removed.push(`max_completion_tokens=${JSON.stringify(parsed.max_completion_tokens)}`);
      }
      delete parsed.max_completion_tokens;
    }

    for (const key of MIMO_REJECTED_PARAMS) {
      if (key in parsed) {
        removed.push(`${key}=${JSON.stringify(parsed[key])}`);
        delete parsed[key];
      }
    }

    if (removed.length === 0) return null;
    return { strippedBody: JSON.stringify(parsed), removedParams: removed };
  } catch {
    return null;
  }
}

/**
 * Fix MiMo reasoning_content requirement
 *
 * MiMo API thinking 模式要求：多轮对话中，如果 assistant 消息之前带 reasoning_content，
 * 下一轮请求必须回传该 reasoning_content。OpenClaw 等客户端在构造 messages 时会丢弃
 * reasoning_content，导致 MiMo 返回 400 "Param Incorrect"。
 *
 * 修复策略：对 MiMo 模型，为所有缺少 reasoning_content 的 assistant 消息注入
 * reasoning_content: null，让 MiMo 不再报错。
 *
 * @param {string} body - JSON string of request body
 * @param {string} model - already-stripped model name
 * @returns {{ fixedBody: string, patched: boolean }}
 */
export function fixMimoReasoningContent(body, model) {
  if (!body || !model) return { fixedBody: body, patched: false };
  // Only apply to MiMo models
  if (!model.startsWith('mimo-')) return { fixedBody: body, patched: false };

  try {
    const parsed = JSON.parse(body);
    const messages = parsed.messages;
    if (!Array.isArray(messages)) return { fixedBody: body, patched: false };

    let patched = false;
    let injected = 0;
    let existing = 0;
    let missingToolCalls = 0;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      if ('reasoning_content' in msg) {
        existing++;
        continue;
      }

      // Xiaomi MiMo thinking-mode requirement (2026-05-12 notice):
      // in multi-turn agent chats, historical assistant messages containing
      // tool_calls must carry reasoning_content back to the API. If the client
      // already preserved the original value, keep it. If it omitted the field,
      // inject null as a compatibility shim; native probing shows a missing
      // field returns 400, while null is accepted. This cannot reconstruct the
      // original chain-of-thought, but it prevents hard request failure.
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        missingToolCalls++;
      }

      msg.reasoning_content = null;
      injected++;
      patched = true;
    }

    if (patched || missingToolCalls || existing) {
      console.log(`🔧 proxy fix: MiMo reasoning_content existing=${existing} injectedNull=${injected} missingToolCallAssistants=${missingToolCalls}`);
    }
    if (patched) return { fixedBody: JSON.stringify(parsed), patched: true };
    return { fixedBody: body, patched: false };
  } catch {
    return { fixedBody: body, patched: false };
  }
}

export function getMimoTunnelTimeoutMs(body, model) {
  if (!model?.startsWith('mimo-')) return 120_000;
  try {
    const parsed = JSON.parse(body || '{}');
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const messageCount = messages.length;
    const toolResultCount = messages.filter((m) => m?.role === 'tool').length;
    const toolCallAssistantCount = messages.filter((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length;
    const bodyBytes = Buffer.byteLength(body || '', 'utf8');
    console.log(`📊 MiMo request summary: bytes=${bodyBytes} messages=${messageCount} toolResults=${toolResultCount} toolCallAssistants=${toolCallAssistantCount} stream=${!!parsed.stream}`);
  } catch {}
  return 600_000;
}

/**
 * 读取请求体
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * 创建代理处理器
 * @param {import('./registry.mjs').Registry} registry
 * @param {Function} [sendTunnelRequest] - tunnel 发送函数（来自 tunnel.mjs）
 * @returns {Function}
 */
export function createProxyHandler(registry, sendTunnelRequest) {
  return async function handleProxy(req, res, body) {
    const startTime = Date.now();
    const requestId = req.keypoolRequestId || req.headers['x-request-id'] || req.headers['x-keypool-request-id'] || null;

    // 解析 model 并 strip provider 前缀
    let model = null;
    let strippedBody = body;
    if (body) {
      // 🔴 RAW: log original body to file for debugging
      try {
        const rawDir = join(process.cwd(), '_raw_bodies');
        if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(join(rawDir, `raw_${ts}.json`), body, 'utf8');
        console.log(`📥 proxy RAW body saved to _raw_bodies/raw_${ts}.json (${body.length} bytes)`);
      } catch (e) { console.error('Failed to save raw body:', e.message); }
      try {
        const parsed = JSON.parse(body);
        model = parsed.model || null;
        // Strip provider prefix: "xiaomi/mimo-v2.5-pro" → "mimo-v2.5-pro"
        const strippedModel = stripModelPrefix(model);
        if (strippedModel !== model) {
          parsed.model = strippedModel;
          strippedBody = JSON.stringify(parsed);
          console.log(`🔧 proxy strip model prefix: "${model}" → "${strippedModel}"`);
        }
        model = strippedModel;

        // Strip unsupported params (n, logprobs, etc.) for MiMo upstream
        const paramResult = stripUnsupportedParams(strippedBody, model);
        if (paramResult) {
          strippedBody = paramResult.strippedBody;
          console.log(`🔧 proxy strip unsupported params: ${paramResult.removedParams.join(', ')}`);
        }

        // Fix MiMo reasoning_content requirement
        const fixResult = fixMimoReasoningContent(strippedBody, model);
        if (fixResult.patched) {
          strippedBody = fixResult.fixedBody;
        }
        // Debug: log the final forwarded body keys AND full body for upstream debugging
        try {
          const finalParsed = JSON.parse(strippedBody);
          console.log(`📤 proxy forwarding keys: [${Object.keys(finalParsed).join(', ')}] model=${finalParsed.model}`);
          console.log(`📋 proxy full body: ${strippedBody.substring(0, 2000)}`);
        } catch {}
      } catch (err) { console.warn(`⚠️ proxy body parse error: ${err.message}`); }
    }

    // 选择 verified upstream
    const upstream = registry.chooseVerifiedUpstream(model);
    if (!upstream) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'No healthy upstream available',
          type: 'service_unavailable',
        },
      }));
      return;
    }

    // ─── 优先 Tunnel（WS 反连） ───────────────────────────
    if (upstream.tunnel && sendTunnelRequest) {
      try {
        const tunnelResp = await sendTunnelRequest(upstream.tunnel, {
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: undefined, ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
          body: strippedBody || null,
        }, { res, timeoutMs: getMimoTunnelTimeoutMs(strippedBody, model) });

        // 当 opts.res 被传入时，tunnel.mjs 会在收到 chunk 时直接写入 HTTP 响应（流式透传）。
        // 此时 res.headersSent 已为 true，不应再二次写入。
        if (!res.headersSent) {
          const outHeaders = {};
          if (tunnelResp.headers) {
            for (const [key, value] of Object.entries(tunnelResp.headers)) {
              if (['transfer-encoding', 'connection', 'content-encoding'].includes(key)) continue;
              outHeaders[key] = value;
            }
          }
          if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/json';
          if (!outHeaders['cache-control']) outHeaders['cache-control'] = 'no-cache';
          res.writeHead(tunnelResp.status || 200, outHeaders);
          res.end(tunnelResp.body || '');
        }

        const latencyMs = Date.now() - startTime;
        const status = tunnelResp.status || 200;
        if (status >= 400) {
          console.error(`❌ upstream error [${upstream.accountId}] status=${status} requestId=${requestId || '-'} body=${(tunnelResp.body || '').substring(0, 500)}`);
          registry.markProxyUpstreamError(upstream.accountId, status, tunnelResp.body);
        } else {
          registry.markProxySuccess(upstream.accountId, latencyMs);
        }
        return;
      } catch (err) {
        registry.markProxyFailure(upstream.accountId, err.message);
        console.error(`❌ tunnel proxy failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);
        // 流式响应已开始写入时，无法再切换为错误 JSON 或 HTTP 回退
        if (res.headersSent) {
          if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }
        // 回退到 HTTP 直连（如果有）
        if (!upstream.proxyUrl && !upstream.baseUrl && !upstream.localUrl) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: err.message || 'Tunnel proxy failed', type: 'proxy_error' },
          }));
          return;
        }
        // 有 HTTP fallback，继续往下
      }
    }

    // ─── HTTP 直连回退 ────────────────────────────────────
    const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;
    if (!baseUrl) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'No upstream connection available', type: 'service_unavailable' },
      }));
      return;
    }

    const targetUrl = new URL(req.url, baseUrl).toString();

    // 转发 headers
    const headers = { ...req.headers };
    if (requestId) headers['x-keypool-request-id'] = requestId;
    delete headers.host;
    delete headers['content-length'];

    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: strippedBody || undefined,
      });

      // 检查是否流式
      const contentType = response.headers.get('content-type') || '';
      const isStream = contentType.includes('text/event-stream');

      let text = null;

      if (isStream) {
        // 流式透传
        const outHeaders = {};
        response.headers.forEach((value, key) => {
          if (['transfer-encoding', 'connection', 'content-encoding'].includes(key)) return;
          outHeaders[key] = value;
        });
        res.writeHead(response.status, outHeaders);
        if (response.body) {
          for await (const chunk of response.body) {
            res.write(chunk);
          }
        }
        res.end();
      } else {
        // 非流式
        text = await response.text();
        const outHeaders = {};
        response.headers.forEach((value, key) => {
          if (['transfer-encoding', 'connection', 'content-encoding'].includes(key)) return;
          outHeaders[key] = value;
        });
        res.writeHead(response.status, outHeaders);
        res.end(text);
      }

      const latencyMs = Date.now() - startTime;
      if (response.status >= 400) {
        const errBody = isStream ? '(streaming)' : text;
        registry.markProxyUpstreamError(upstream.accountId, response.status, errBody);
      } else {
        registry.markProxySuccess(upstream.accountId, latencyMs);
      }
    } catch (err) {
      registry.markProxyFailure(upstream.accountId, err.message);
      console.error(`❌ proxy failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);

      // 返回 502
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({
        error: {
          message: err.message || 'Upstream request failed',
          type: 'proxy_error',
        },
      }));
    }
  };
}

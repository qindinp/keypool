
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
 * 过滤不应直接转发给客户端的 hop-by-hop headers
 */
const HOP_BY_HOP = new Set(['transfer-encoding', 'connection', 'content-encoding']);
function buildOutHeaders(headers) {
  const out = {};
  if (headers) {
    if (headers[Symbol.iterator]) {
      for (const [key, value] of headers) {
        if (!HOP_BY_HOP.has(key)) out[key] = value;
      }
    } else {
      for (const [key, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(key)) out[key] = value;
      }
    }
  }
  return out;
}

const PROXY_MAX_RETRIES = 2;

/**
 * 创建代理处理器（支持 tunnel → HTTP 回退 + 多 upstream 重试）
 * @param {import('./registry.mjs').Registry} registry
 * @param {Function} [sendTunnelRequest] - tunnel 发送函数（来自 tunnel.mjs）
 * @returns {Function}
 */
export function createProxyHandler(registry, sendTunnelRequest) {
  return async function handleProxy(req, res, body) {
    const startTime = Date.now();
    const requestId = req.keypoolRequestId || req.headers['x-request-id'] || req.headers['x-keypool-request-id'] || null;

    // ─── Body 预处理（只做一次） ─────────────────────────
    let model = null;
    let strippedBody = body;
    if (body) {
      try {
        const parsed = JSON.parse(body);
        model = parsed.model || null;

        let finalParsed = parsed;

        const strippedModel = stripModelPrefix(model);
        if (strippedModel !== model) {
          finalParsed = { ...finalParsed, model: strippedModel };
          console.log(`🔧 proxy strip model prefix: "${model}" → "${strippedModel}"`);
        }
        model = strippedModel;

        const paramResult = stripUnsupportedParams(JSON.stringify(finalParsed), model);
        if (paramResult) {
          finalParsed = JSON.parse(paramResult.strippedBody);
          console.log(`🔧 proxy strip unsupported params: ${paramResult.removedParams.join(', ')}`);
        }

        const fixResult = fixMimoReasoningContent(JSON.stringify(finalParsed), model);
        if (fixResult.patched) {
          finalParsed = JSON.parse(fixResult.fixedBody);
        }

        strippedBody = JSON.stringify(finalParsed);
        console.log(`📤 proxy forwarding keys: [${Object.keys(finalParsed).join(', ')}] model=${finalParsed.model}`);
      } catch (err) { console.warn(`⚠️ proxy body parse error: ${err.message}`); }
    }

    // ─── 重试循环 ───────────────────────────────────────
    const excludeAccountIds = new Set();
    let lastError = null;

    for (let attempt = 0; attempt <= PROXY_MAX_RETRIES; attempt++) {
      const isLastAttempt = attempt >= PROXY_MAX_RETRIES;
      const upstream = registry.chooseVerifiedUpstream(model, { excludeAccountIds });

      if (!upstream) {
        if (res.headersSent) {
          if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }
        const status = lastError ? 502 : 503;
        const message = lastError
          ? `All upstreams failed: ${lastError}`
          : 'No healthy upstream available';
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: lastError ? 'proxy_error' : 'service_unavailable' } }));
        return;
      }

      if (attempt > 0) {
        console.log(`🔄 proxy retry attempt ${attempt}/${PROXY_MAX_RETRIES} [${upstream.accountId}] excluded=[${[...excludeAccountIds].join(',')}]`);
      }

      const attemptStart = Date.now();

      // ─── Tunnel 路径 ───────────────────────────
      if (upstream.tunnel && sendTunnelRequest) {
        try {
          const tunnelResp = await sendTunnelRequest(upstream.tunnel, {
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: undefined, ...(requestId ? { 'x-keypool-request-id': requestId } : {}) },
            body: strippedBody || null,
          }, { res, timeoutMs: getMimoTunnelTimeoutMs(strippedBody, model) });

          // tunnel.mjs 传入 opts.res 后会直接写入 HTTP 响应（流式透传）
          // 此时 res.headersSent 已为 true，不能再重试
          if (res.headersSent) {
            const status = tunnelResp?.status || 200;
            if (status >= 400) {
              registry.markProxyUpstreamError(upstream.accountId, status, tunnelResp?.body);
            } else {
              registry.markProxySuccess(upstream.accountId, Date.now() - attemptStart);
            }
            return;
          }

          // 非流式：tunnel 返回完整响应
          const status = tunnelResp.status || 200;

          if (status >= 500) {
            registry.markProxyUpstreamError(upstream.accountId, status, tunnelResp.body);
            excludeAccountIds.add(upstream.accountId);
            lastError = `[${upstream.accountId}] HTTP ${status}`;
            console.warn(`⚠️ tunnel 5xx [${upstream.accountId}] status=${status}, ${isLastAttempt ? 'giving up' : 'retrying...'}`);
            continue;
          }

          // 4xx 或成功：直接返回
          const outHeaders = buildOutHeaders(tunnelResp.headers);
          if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/json';
          if (!outHeaders['cache-control']) outHeaders['cache-control'] = 'no-cache';
          res.writeHead(status, outHeaders);
          res.end(tunnelResp.body || '');

          if (status >= 400) {
            registry.markProxyUpstreamError(upstream.accountId, status, tunnelResp.body);
          } else {
            registry.markProxySuccess(upstream.accountId, Date.now() - attemptStart);
          }
          return;

        } catch (err) {
          registry.markProxyFailure(upstream.accountId, err.message);
          console.error(`❌ tunnel failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);

          if (res.headersSent) {
            if (!res.writableEnded) { try { res.end(); } catch {} }
            return;
          }

          // 无 HTTP 回退 → 重试下一个 upstream
          if (!upstream.proxyUrl && !upstream.baseUrl && !upstream.localUrl) {
            excludeAccountIds.add(upstream.accountId);
            lastError = `[${upstream.accountId}] ${err.message}`;
            if (!isLastAttempt) continue;
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message || 'Tunnel proxy failed', type: 'proxy_error' } }));
            return;
          }
          // 有 HTTP 回退，继续往下
        }
      }

      // ─── HTTP 直连回退 ────────────────────────────
      const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;
      if (!baseUrl) {
        excludeAccountIds.add(upstream.accountId);
        lastError = `[${upstream.accountId}] no connection`;
        if (!isLastAttempt) continue;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No upstream connection available', type: 'service_unavailable' } }));
        return;
      }

      const targetUrl = new URL(req.url, baseUrl).toString();
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

        const contentType = response.headers.get('content-type') || '';
        const isStream = contentType.includes('text/event-stream');

        // 5xx：可重试（headers 还没发给客户端）
        if (response.status >= 500) {
          if (res.headersSent) {
            console.warn(`⚠️ HTTP 5xx after headers sent [${upstream.accountId}], cannot retry`);
            const errBody = isStream ? '(streaming)' : await response.text();
            registry.markProxyUpstreamError(upstream.accountId, response.status, errBody);
            if (!res.writableEnded) { try { res.end(); } catch {} }
            return;
          }

          const errBody = isStream ? '(streaming)' : await response.text();
          registry.markProxyUpstreamError(upstream.accountId, response.status, errBody);
          excludeAccountIds.add(upstream.accountId);
          lastError = `[${upstream.accountId}] HTTP ${response.status}`;
          console.warn(`⚠️ HTTP 5xx [${upstream.accountId}] status=${response.status}, ${isLastAttempt ? 'giving up' : 'retrying...'}`);
          continue;
        }

        // 4xx 或成功：写回客户端
        const outHeaders = buildOutHeaders(response.headers);
        res.writeHead(response.status, outHeaders);

        if (isStream && response.body) {
          for await (const chunk of response.body) {
            res.write(chunk);
          }
          res.end();
        } else {
          const text = await response.text();
          res.end(text);
        }

        const latencyMs = Date.now() - attemptStart;
        if (response.status >= 400) {
          registry.markProxyUpstreamError(upstream.accountId, response.status, '(forwarded)');
        } else {
          registry.markProxySuccess(upstream.accountId, latencyMs);
        }
        return;

      } catch (err) {
        registry.markProxyFailure(upstream.accountId, err.message);
        console.error(`❌ HTTP proxy failed [${upstream.accountId}] requestId=${requestId || '-'}: ${err.message}`);

        if (res.headersSent) {
          if (!res.writableEnded) { try { res.end(); } catch {} }
          return;
        }

        excludeAccountIds.add(upstream.accountId);
        lastError = `[${upstream.accountId}] ${err.message}`;
        if (!isLastAttempt) continue;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message || 'Upstream request failed', type: 'proxy_error' } }));
        return;
      }
    }
  };
}

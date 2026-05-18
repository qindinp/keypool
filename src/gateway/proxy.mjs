
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
 * Accepts a parsed object, returns { result, removedParams } or null if nothing changed.
 */
export function stripUnsupportedParams(parsed, model = null) {
  if (!parsed || typeof parsed !== 'object') return null;
  const effectiveModel = stripModelPrefix(model || parsed.model || '');
  if (effectiveModel && !effectiveModel.startsWith('mimo-')) return null;

  const removed = [];
  const result = { ...parsed };

  // OpenAI newer clients send max_completion_tokens, while MiMo's
  // OpenAI-compatible endpoint accepts the older max_tokens name.
  // Preserve the user's limit instead of dropping it when possible.
  if ('max_completion_tokens' in result) {
    if (!('max_tokens' in result)) {
      result.max_tokens = result.max_completion_tokens;
      removed.push(`max_completion_tokens=${JSON.stringify(result.max_completion_tokens)}->max_tokens`);
    } else {
      removed.push(`max_completion_tokens=${JSON.stringify(result.max_completion_tokens)}`);
    }
    delete result.max_completion_tokens;
  }

  for (const key of MIMO_REJECTED_PARAMS) {
    if (key in result) {
      removed.push(`${key}=${JSON.stringify(result[key])}`);
      delete result[key];
    }
  }

  if (removed.length === 0) return null;
  return { result, removedParams: removed };
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
 * Accepts a parsed object, returns { result, patched } or null if nothing changed.
 */
export function fixMimoReasoningContent(parsed, model) {
  if (!parsed || !model) return null;
  // Only apply to MiMo models
  if (!model.startsWith('mimo-')) return null;

  const messages = parsed.messages;
  if (!Array.isArray(messages)) return null;

  let patched = false;
  let injected = 0;
  let existing = 0;
  let missingToolCalls = 0;
  const newMessages = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      console.warn(`⚠️ proxy fix: skip non-object message in MiMo reasoning_content shim type=${Array.isArray(msg) ? 'array' : typeof msg}`);
      newMessages.push(msg);
      continue;
    }
    if (msg.role !== 'assistant') {
      newMessages.push(msg);
      continue;
    }
    if ('reasoning_content' in msg) {
      existing++;
      newMessages.push(msg);
      continue;
    }

    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      newMessages.push(msg);
      continue;
    }

    missingToolCalls++;
    newMessages.push({ ...msg, reasoning_content: null });
    injected++;
    patched = true;
  }

  if (patched || missingToolCalls || existing) {
    console.log(`🔧 proxy fix: MiMo reasoning_content existing=${existing} injectedNull=${injected} toolCallAssistantsMissing=${missingToolCalls}`);
  }
  if (patched) return { result: { ...parsed, messages: newMessages }, patched: true };
  return null;
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

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB — proxy 路径需转发完整对话历史

/**
 * 读取请求体（带大小限制）
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES / (1024 * 1024)}MB limit`));
        return;
      }
      body += c;
    });
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
 * 消费流式响应 body 以确保连接正确归还到连接池
 * @param {ReadableStream|null} body
 * @returns {Promise<string>}
 */
async function drainStreamBody(body) {
  if (!body) return '';
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, 500);
}

/**
 * 带 backpressure 的流式管道：当 res.write 返回 false 时等待 drain
 * @param {ReadableStream} readable
 * @param {import('node:http').ServerResponse} res
 */
function pipeWithBackpressure(readable, res) {
  return new Promise((resolve, reject) => {
    const reader = readable[Symbol.asyncIterator]?.() || readable.getReader?.();
    if (!reader) {
      resolve();
      return;
    }

    // Node.js async iterable path
    const iterable = readable[Symbol.asyncIterator] ? readable : readable;
    let finished = false;

    function onDrain() {
      pump();
    }

    async function pump() {
      if (finished) return;
      try {
        for await (const chunk of iterable) {
          if (res.writableEnded) { finished = true; resolve(); return; }
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const ok = res.write(buf);
          if (!ok) {
            // 内核缓冲区满，等 drain 事件
            await new Promise((r) => res.once('drain', r));
          }
        }
        finished = true;
        resolve();
      } catch (err) {
        if (!finished) {
          finished = true;
          reject(err);
        }
      }
    }

    pump();
  });
}

function createToolCallDiagnostics(body, model, requestId) {
  if (!body || !model?.startsWith('mimo-')) return null;
  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const hasToolChoice = parsed.tool_choice && parsed.tool_choice !== 'none';
    const toolResults = messages.filter((m) => m?.role === 'tool').length;
    const assistantToolCalls = messages.filter((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length;

    if (tools.length === 0 && !hasToolChoice && toolResults === 0 && assistantToolCalls === 0) return null;

    return {
      requestId: requestId || '-',
      model,
      stream: !!parsed.stream,
      tools: tools.length,
      messages: messages.length,
      toolResults,
      assistantToolCalls,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      startMs: Date.now(),
      firstChunkMs: null,
      chunks: 0,
      bytes: 0,
      sawToolCalls: false,
      sawFinishToolCalls: false,
      sawDone: false,
      loggedEnd: false,
    };
  } catch {
    return null;
  }
}

function installToolCallDiagnostics(res, diag) {
  if (!diag || res.__keypoolToolDiagInstalled) return;
  res.__keypoolToolDiagInstalled = true;

  const originalWrite = res.write.bind(res);
  res.write = (chunk, ...args) => {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      diag.chunks += 1;
      diag.bytes += buf.length;
      if (diag.firstChunkMs === null) diag.firstChunkMs = Date.now();

      const text = buf.toString('utf8');
      if (text.includes('tool_calls')) diag.sawToolCalls = true;
      if (text.includes('finish_reason') && text.includes('tool_calls')) diag.sawFinishToolCalls = true;
      if (text.includes('[DONE]')) diag.sawDone = true;
    } catch {}
    return originalWrite(chunk, ...args);
  };

  const originalEnd = res.end.bind(res);
  res.end = (chunk, ...args) => {
    if (chunk) {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        diag.bytes += buf.length;
        const text = buf.toString('utf8');
        if (text.includes('tool_calls')) diag.sawToolCalls = true;
        if (text.includes('finish_reason') && text.includes('tool_calls')) diag.sawFinishToolCalls = true;
        if (text.includes('[DONE]')) diag.sawDone = true;
      } catch {}
    }

    if (!diag.loggedEnd) {
      diag.loggedEnd = true;
      console.log(`🧰 MiMo tool diag end requestId=${diag.requestId} model=${diag.model} stream=${diag.stream} chunks=${diag.chunks} bytes=${diag.bytes} durationMs=${Date.now() - diag.startMs} firstChunkMs=${diag.firstChunkMs ? diag.firstChunkMs - diag.startMs : 'none'} sawToolCalls=${diag.sawToolCalls} sawFinishToolCalls=${diag.sawFinishToolCalls} sawDone=${diag.sawDone}`);
    }
    return originalEnd(chunk, ...args);
  };
}

function logToolCallFailure(diag, accountId, err) {
  if (!diag) return;
  console.error(`🧰 MiMo tool diag failure requestId=${diag.requestId} accountId=${accountId || '-'} model=${diag.model} stream=${diag.stream} chunks=${diag.chunks} bytes=${diag.bytes} durationMs=${Date.now() - diag.startMs} firstChunkMs=${diag.firstChunkMs ? diag.firstChunkMs - diag.startMs : 'none'} sawToolCalls=${diag.sawToolCalls} sawFinishToolCalls=${diag.sawFinishToolCalls} sawDone=${diag.sawDone} error=${err?.message || err}`);
}

/**
 * Merge OpenAI streaming usage into finish_reason chunks.
 *
 * MiMo sends usage in a separate final chunk with empty choices,
 * instead of including it in the finish_reason chunk.
 * Proxies like CC Switch only look at the finish_reason chunk for usage,
 * so we need to merge the usage into the finish_reason chunk.
 *
 * This function wraps res.write to intercept streaming data and merge
 * usage from the final chunk into the finish_reason chunk.
 */
const LINEBUF_MAX_BYTES = 1024 * 1024; // 1MB — 防止单行过长导致 OOM

function installStreamingUsageMerger(res) {
  if (res.__keypoolUsageMergerInstalled) return;
  res.__keypoolUsageMergerInstalled = true;

  let lineBuf = '';
  let pendingFinishParsed = null;  // parsed JSON of the buffered finish_reason chunk
  let pendingFinishLines = [];     // raw lines of the finish_reason event (event:, id:, data:)
  let inPendingEvent = false;
  let mergeCount = 0;

  const originalWrite = res.write.bind(res);
  res.write = (chunk, ...args) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : typeof chunk === 'string' ? chunk : String(chunk);
    lineBuf += text;

    // 防止 lineBuf 无界增长（如 upstream 发了超长行或无换行数据）
    if (lineBuf.length > LINEBUF_MAX_BYTES) {
      // 超限：flush 缓冲区，放弃 usage merge 保证安全
      if (pendingFinishParsed) {
        for (const l of pendingFinishLines) originalWrite(l);
        originalWrite('\n');
        pendingFinishParsed = null;
        pendingFinishLines = [];
        inPendingEvent = false;
      }
      originalWrite(lineBuf);
      lineBuf = '';
      return true;
    }

    let nlIdx;
    while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nlIdx + 1);
      lineBuf = lineBuf.slice(nlIdx + 1);
      const trimmed = line.trim();

      // Empty line = end of SSE event
      if (trimmed === '') {
        if (inPendingEvent && pendingFinishParsed) {
          // We have a buffered finish_reason event. Don't forward yet -
          // wait for the next event to see if it's a usage event.
          // Keep the empty line in the buffer.
          pendingFinishLines.push(line);
        } else {
          originalWrite(line);
        }
        continue;
      }

      // Data line
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6).trim();

        if (payload === '[DONE]') {
          // Flush any pending finish_reason event before [DONE]
          if (pendingFinishParsed) {
            for (const l of pendingFinishLines) originalWrite(l);
            originalWrite('\n');
            pendingFinishParsed = null;
            pendingFinishLines = [];
          }
          originalWrite(line);
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // Parse error - flush pending and forward as-is
          if (pendingFinishParsed) {
            for (const l of pendingFinishLines) originalWrite(l);
            originalWrite('\n');
            pendingFinishParsed = null;
            pendingFinishLines = [];
            inPendingEvent = false;
          }
          originalWrite(line);
          continue;
        }

        // Usage-only chunk (choices: [] with usage) + we have a buffered finish_reason
        if (Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage && pendingFinishParsed) {
          // Merge usage into the buffered finish_reason chunk
          pendingFinishParsed.usage = parsed.usage;
          const mergedLine = `data: ${JSON.stringify(pendingFinishParsed)}\n`;
          // Replace the data line in pendingFinishLines
          for (let i = 0; i < pendingFinishLines.length; i++) {
            if (pendingFinishLines[i].trim().startsWith('data: ')) {
              pendingFinishLines[i] = mergedLine;
              break;
            }
          }
          for (const l of pendingFinishLines) originalWrite(l);
          originalWrite('\n');
          mergeCount++;
          console.log(`🔗 streaming usage merged into finish_reason chunk (count=${mergeCount})`);
          pendingFinishParsed = null;
          pendingFinishLines = [];
          inPendingEvent = false;
          continue; // skip this usage chunk
        }

        // Finish_reason chunk with null usage - buffer it
        const hasFinishReason = parsed.choices?.[0]?.finish_reason;
        const hasNullUsage = !parsed.usage || parsed.usage === null;
        if (hasFinishReason && hasNullUsage) {
          pendingFinishParsed = parsed;
          pendingFinishLines = [line];
          inPendingEvent = true;
          continue;
        }

        // Regular chunk - flush pending first
        if (pendingFinishParsed) {
          for (const l of pendingFinishLines) originalWrite(l);
          originalWrite('\n');
          pendingFinishParsed = null;
          pendingFinishLines = [];
          inPendingEvent = false;
        }

        originalWrite(line);
      } else {
        // Non-data line (event:, id:, etc.)
        if (inPendingEvent) {
          pendingFinishLines.push(line);
        } else {
          originalWrite(line);
        }
      }
    }

    return true;
  };

  const originalEnd = res.end.bind(res);
  res.end = (chunk, ...args) => {
    if (chunk) {
      res.write(chunk);
    }
    // Flush any remaining buffered data — 通过 res.write 走完整调用链
    if (pendingFinishParsed) {
      for (const l of pendingFinishLines) originalWrite(l);
      originalWrite('\n');
      pendingFinishParsed = null;
      pendingFinishLines = [];
    }
    if (lineBuf.trim()) {
      originalWrite(lineBuf);
      lineBuf = '';
    }
    return originalEnd(...args);
  };
}

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
    let isRequestStream = false;
    if (body) {
      try {
        let finalParsed = JSON.parse(body);
        model = finalParsed.model || null;
        isRequestStream = !!finalParsed.stream;
        let bodyModified = false;

        const strippedModel = stripModelPrefix(model);
        if (strippedModel !== model) {
          finalParsed = { ...finalParsed, model: strippedModel };
          bodyModified = true;
          console.log(`🔧 proxy strip model prefix: "${model}" → "${strippedModel}"`);
        }
        model = strippedModel;

        const paramResult = stripUnsupportedParams(finalParsed, model);
        if (paramResult) {
          finalParsed = paramResult.result;
          bodyModified = true;
          console.log(`🔧 proxy strip unsupported params: ${paramResult.removedParams.join(', ')}`);
        }

        const fixResult = fixMimoReasoningContent(finalParsed, model);
        if (fixResult) {
          finalParsed = fixResult.result;
          bodyModified = true;
        }

        // 只在 body 实际被修改时才重新序列化
        if (bodyModified) {
          strippedBody = JSON.stringify(finalParsed);
        }
        console.log(`📤 proxy forwarding keys: [${Object.keys(finalParsed).join(', ')}] model=${finalParsed.model}`);
      } catch (err) { console.warn(`⚠️ proxy body parse error: ${err.message}`); }
    }

    const toolDiag = createToolCallDiagnostics(strippedBody, model, requestId);
    if (toolDiag) {
      console.log(`🧰 MiMo tool diag start requestId=${toolDiag.requestId} model=${toolDiag.model} stream=${toolDiag.stream} tools=${toolDiag.tools} messages=${toolDiag.messages} toolResults=${toolDiag.toolResults} assistantToolCalls=${toolDiag.assistantToolCalls} bodyBytes=${toolDiag.bodyBytes}`);
      installToolCallDiagnostics(res, toolDiag);
    }

    // Install streaming usage merger for streaming requests
    // MiMo sends usage in a separate final chunk; this merges it into the finish_reason chunk
    // so proxies like CC Switch can properly convert to Anthropic format
    if (isRequestStream) {
      installStreamingUsageMerger(res);
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
          logToolCallFailure(toolDiag, upstream.accountId, err);
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
          // 消费完响应 body 以确保连接正确归还到池中
          let errBody;
          try {
            errBody = isStream ? await drainStreamBody(response.body) : await response.text();
          } catch { errBody = '(drain failed)'; }

          if (res.headersSent) {
            console.warn(`⚠️ HTTP 5xx after headers sent [${upstream.accountId}], cannot retry`);
            registry.markProxyUpstreamError(upstream.accountId, response.status, errBody);
            if (!res.writableEnded) { try { res.end(); } catch {} }
            return;
          }

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
          await pipeWithBackpressure(response.body, res);
          if (!res.writableEnded) res.end();
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
        logToolCallFailure(toolDiag, upstream.accountId, err);
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

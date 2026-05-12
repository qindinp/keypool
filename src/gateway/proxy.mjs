/**
 * Gateway 请求代理 — 支持 Tunnel（WS 反连）和 HTTP 直连
 *
 * 职责：
 * 1. 解析请求中的 model 字段
 * 2. 从 Registry 选择 verified upstream
 * 3. 优先通过 Tunnel（WS）转发，回退到 HTTP fetch
 * 4. 无可用 upstream 时返回 503
 */

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

    // 解析 model
    let model = null;
    if (body) {
      try { model = JSON.parse(body).model || null; } catch (err) { console.warn(`⚠️ proxy body parse error: ${err.message}`); }
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
          body: body || null,
        }, { res });

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
        body: body || undefined,
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

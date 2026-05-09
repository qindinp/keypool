/**
 * Gateway 请求代理 — 纯 HTTP 转发到 skill-proxy upstream
 *
 * 职责：
 * 1. 解析请求中的 model 字段
 * 2. 从 Registry 选择 verified upstream
 * 3. HTTP fetch 转发请求（支持流式 SSE 透传）
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
 * @returns {Function}
 */
export function createProxyHandler(registry) {
  return async function handleProxy(req, res, body) {
    const startTime = Date.now();

    // 解析 model
    let model = null;
    if (body) {
      try { model = JSON.parse(body).model || null; } catch {}
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

    const baseUrl = upstream.proxyUrl || upstream.baseUrl || upstream.localUrl;
    const targetUrl = new URL(req.url, baseUrl).toString();

    // 转发 headers
    const headers = { ...req.headers };
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
        const text = await response.text();
        const outHeaders = {};
        response.headers.forEach((value, key) => {
          if (['transfer-encoding', 'connection', 'content-encoding'].includes(key)) return;
          outHeaders[key] = value;
        });
        res.writeHead(response.status, outHeaders);
        res.end(text);
      }

      const latencyMs = Date.now() - startTime;
      registry.markProxySuccess(upstream.accountId, latencyMs);
    } catch (err) {
      registry.markProxyFailure(upstream.accountId, err.message);
      console.error(`❌ proxy failed [${upstream.accountId}]: ${err.message}`);

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

/**
 * KeyPool — HTTP 代理核心
 *
 * 特性：
 *   - 有限重试（不再无限递归）
 *   - 请求超时
 *   - 请求体大小限制
 *   - SSE 流式透传
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const PROXY_TIMEOUT_MS = 120_000;         // 2 分钟

/**
 * 安全地读取请求体，带大小限制
 * @returns {Promise<string>}
 */
export function readBody(req, maxSize = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let destroyed = false;

    req.on('data', (chunk) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > maxSize) {
        destroyed = true;
        req.destroy(new Error(`Request body exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!destroyed) resolve(body);
    });

    req.on('error', reject);
  });
}

/**
 * 代理请求（带有限重试 + 超时）
 *
 * @param {object} opts
 * @param {object} opts.keyEntry - 当前 key
 * @param {object} opts.pool - KeyPool 实例
 * @param {object} opts.req - 原始请求
 * @param {object} opts.res - 原始响应
 * @param {string} opts.body - 已读取的请求体
 * @param {number} opts.retryCount - 当前重试次数
 * @param {number} opts.maxRetries - 最大重试次数
 * @param {Function} opts.log - 日志函数
 */
export function proxyRequest(opts) {
  const {
    keyEntry, pool, req, res, body,
    retryCount = 0,
    maxRetries,
    log,
  } = opts;

  const targetPath = req.url;
  const headers = { ...req.headers };
  const target = pool.getTargetFor(keyEntry);

  delete headers['host'];
  headers['authorization'] = `Bearer ${keyEntry.key}`;

  const requester = target.isHttps ? httpsRequest : httpRequest;

  const proxyReq = requester({
    hostname: target.hostname,
    port: target.port,
    path: targetPath,
    method: req.method,
    headers,
  }, (proxyRes) => {
    const statusCode = proxyRes.statusCode;

    if (statusCode >= 400) {
      let errBody = '';
      proxyRes.on('data', (c) => (errBody += c));
      proxyRes.on('end', () => {
        pool.markError(keyEntry, statusCode, errBody);

        // 有限重试：429/401/403 自动切换到下一个 key
        if ([401, 403, 429].includes(statusCode) && retryCount < maxRetries) {
          const retryKey = pool.pick();
          if (retryKey && retryKey.id !== keyEntry.id) {
            log('info', `Retrying with key ${retryKey.id} after ${statusCode} (attempt ${retryCount + 1}/${maxRetries})`);
            return proxyRequest({ ...opts, keyEntry: retryKey, retryCount: retryCount + 1 });
          }
        }

        if (retryCount >= maxRetries) {
          log('warn', `All retry attempts exhausted (${retryCount}/${maxRetries})`);
        }

        res.writeHead(statusCode, proxyRes.headers);
        res.end(errBody);
      });
      return;
    }

    // 成功 — 流式/非流式透传
    const isStream = proxyRes.headers['content-type']?.includes('text/event-stream');

    res.writeHead(statusCode, proxyRes.headers);

    if (isStream) {
      let buffer = '';
      let usage = null;

      proxyRes.on('data', (chunk) => {
        res.write(chunk);
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.usage) usage = data.usage;
            } catch {}
          }
        }
      });

      proxyRes.on('end', () => {
        res.end();
        const tokens = usage?.total_tokens || 0;
        pool.markSuccess(keyEntry, tokens);
        log('info', `✓ ${targetPath} [${keyEntry.id}] ${tokens} tokens (stream)`);
      });
    } else {
      let respBody = '';
      proxyRes.on('data', (c) => (respBody += c));
      proxyRes.on('end', () => {
        res.end(respBody);
        let tokens = 0;
        try {
          const parsed = JSON.parse(respBody);
          tokens = parsed.usage?.total_tokens || 0;
        } catch {}
        pool.markSuccess(keyEntry, tokens);
        log('info', `✓ ${targetPath} [${keyEntry.id}] ${tokens} tokens`);
      });
    }
  });

  // 超时
  proxyReq.setTimeout(PROXY_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error(`Upstream request timeout (${PROXY_TIMEOUT_MS / 1000}s)`));
  });

  proxyReq.on('error', (err) => {
    pool.markError(keyEntry, 0, err.message);
    log('error', `Proxy error [${keyEntry.id}]:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: 'Proxy error', type: 'proxy_error' } }));
  });

  // 透传请求体
  if (body) {
    proxyReq.write(body);
  }
  proxyReq.end();
}

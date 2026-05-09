/**
 * API Handler — MiMo API 代理
 *
 * 支持：
 *   POST /v1/chat/completions  （流式 + 非流式）
 *   GET  /v1/models
 *
 * 流式模式：逐 chunk 通过回调返回，避免大响应 OOM
 */

import { request as httpsRequest } from 'node:https';

const MAX_CHUNKS = 10_000;
const MAX_CHUNK_SIZE = 1_048_576; // 1MB
const UPSTREAM_TIMEOUT = 120_000;

export class ApiHandler {
  constructor({ apiKey, baseUrl }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 处理代理请求
   *
   * @param {object} req - { method, path, headers, body }
   * @param {object} opts - { onChunk(chunkId, status, headers, buf), onEnd(totalChunks) }
   * @returns {Promise<{ status, headers, body }>} 非流式返回完整结果；流式通过回调返回
   */
  async handleRequest(req, opts = {}) {
    const { method, path, headers: reqHeaders, body } = req;

    // 路径验证
    const supportedPaths = ['/v1/chat/completions', '/v1/models'];
    const matchedPath = supportedPaths.find(p => path === p || path?.startsWith(p + '?'));
    if (!matchedPath) {
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: 'Not supported by tunnel proxy', type: 'not_found' } }),
      };
    }

    // 构造目标 URL
    const target = new URL(path, this.baseUrl);

    // 构造请求头
    const headers = {};
    if (reqHeaders) {
      for (const [k, v] of Object.entries(reqHeaders)) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'content-length') continue;
        headers[lk] = v;
      }
    }
    headers['authorization'] = `Bearer ${this.apiKey}`;
    headers['accept-encoding'] = 'identity';

    return new Promise((resolve) => {
      const proxyReq = httpsRequest({
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: method || 'POST',
        headers,
      }, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const isStream = contentType.includes('text/event-stream');

        if (isStream && opts.onChunk) {
          // ── 流式逐 chunk 模式 ──
          this._handleStreamResponse(proxyRes, opts, resolve, proxyReq);
        } else {
          // ── 非流式完整收集模式 ──
          this._handleFullResponse(proxyRes, resolve);
        }
      });

      proxyReq.on('error', (err) => {
        resolve({
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }),
        });
      });

      proxyReq.setTimeout(UPSTREAM_TIMEOUT, () => {
        proxyReq.destroy(new Error('upstream timeout'));
      });

      if (body) proxyReq.write(body);
      proxyReq.end();
    });
  }

  /**
   * 流式响应处理 — 逐 chunk 通过回调返回
   */
  _handleStreamResponse(proxyRes, { onChunk, onEnd }, resolve, upstreamReq) {
    let chunkId = 0;
    let firstChunk = true;
    const respHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) respHeaders[key] = value.join(', ');
      else if (value) respHeaders[key] = value;
    }

    proxyRes.on('data', (buf) => {
      if (chunkId >= MAX_CHUNKS) {
        upstreamReq?.destroy(new Error('max chunks exceeded'));
        return;
      }
      if (buf.length > MAX_CHUNK_SIZE) {
        buf = buf.subarray(0, MAX_CHUNK_SIZE);
        console.warn(`[api-handler] chunk ${chunkId} truncated to ${MAX_CHUNK_SIZE} bytes`);
      }

      if (firstChunk) {
        onChunk(chunkId, proxyRes.statusCode, respHeaders, buf);
        firstChunk = false;
      } else {
        onChunk(chunkId, null, null, buf);
      }
      chunkId++;
    });

    proxyRes.on('end', () => {
      onEnd(chunkId);
      // 流式模式不通过 resolve 返回 body，已通过回调发出
      resolve(null);
    });

    proxyRes.on('error', (err) => {
      console.error('[api-handler] stream error:', err.message);
      resolve({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }),
      });
    });
  }

  /**
   * 非流式完整收集
   */
  _handleFullResponse(proxyRes, resolve) {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const headers = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (Array.isArray(value)) headers[key] = value.join(', ');
        else if (value) headers[key] = value;
      }
      resolve({
        status: proxyRes.statusCode,
        headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
    });
    proxyRes.on('error', (err) => {
      resolve({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }),
      });
    });
  }
}

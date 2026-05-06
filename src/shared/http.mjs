/**
 * 共享 HTTP 请求与健康检查模块
 *
 * 消除以下文件中的重复定义：
 *   - relay/proxy.mjs   (probeHealth, proxyJson, proxyStream 及内部工具函数)
 *   - manager.mjs        (probeHealth — 从 relay/proxy.mjs 导入)
 *   - controller/account-worker.mjs (probeHealth — 从 relay/proxy.mjs 导入)
 *
 * 注意: server/tunnel.mjs 中的 probePublicHealth 使用 fetch API，
 * 属于远程侧独立实现，不在此模块中。
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

// ─── 内部工具 ────────────────────────────────────────────────────

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

function pickImpl(protocol) {
  return protocol === 'https:' ? httpsRequest : httpRequest;
}

function collectResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    res.on('end', () => {
      resolve({
        statusCode: res.statusCode || 502,
        headers: res.headers,
        body: Buffer.concat(chunks),
      });
    });
    res.on('error', reject);
  });
}

function copyProxyHeaders(headers = {}) {
  const copied = { ...headers };
  delete copied['content-length'];
  return copied;
}

function decodeResponseBuffer(headers, bodyBuffer) {
  const encoding = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (encoding.includes('gzip')) {
      return { buffer: gunzipSync(bodyBuffer), decoded: true, encoding: 'gzip' };
    }
    if (encoding.includes('deflate')) {
      return { buffer: inflateSync(bodyBuffer), decoded: true, encoding: 'deflate' };
    }
    if (encoding.includes('br')) {
      return { buffer: brotliDecompressSync(bodyBuffer), decoded: true, encoding: 'br' };
    }
  } catch {}
  return { buffer: bodyBuffer, decoded: false, encoding: '' };
}

function buildRequestOptions(target, method, headers = {}) {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method,
    headers,
  };
}

function attachAbort(req, onAbort) {
  if (typeof onAbort !== 'function') return;
  let active = true;
  onAbort(() => {
    if (!active || req.destroyed) return;
    req.destroy(new Error('客户端已断开'));
  });
  req.on('close', () => {
    active = false;
  });
}

// ─── 导出函数 ────────────────────────────────────────────────────

/**
 * JSON 代理请求（非流式）
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - 上游基础 URL
 * @param {string} opts.method - HTTP 方法
 * @param {string} opts.path - 请求路径
 * @param {object} [opts.headers] - 额外请求头
 * @param {string} [opts.body] - 请求体
 * @param {number} [opts.timeoutMs] - 超时 (默认 60s)
 * @param {Function} [opts.onAbort] - 客户端断开回调
 * @returns {Promise<{statusCode: number, headers: object, body: Buffer}>}
 */
export function proxyJson({ baseUrl, method, path, headers = {}, body, timeoutMs = 60_000, onAbort }) {
  const target = new URL(path, normalizeBase(baseUrl));
  const reqImpl = pickImpl(target.protocol);

  return new Promise((resolve, reject) => {
    const req = reqImpl(buildRequestOptions(target, method, {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'identity',
      ...headers,
    }), async (res) => {
      const result = await collectResponse(res);
      const decoded = decodeResponseBuffer(result.headers, result.body);
      const responseHeaders = copyProxyHeaders(result.headers);
      if (decoded.decoded) {
        delete responseHeaders['content-encoding'];
      }
      resolve({
        statusCode: result.statusCode,
        headers: responseHeaders,
        body: decoded.buffer,
      });
    });

    attachAbort(req, onAbort);
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('上游请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 流式代理请求（SSE）
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - 上游基础 URL
 * @param {string} opts.method - HTTP 方法
 * @param {string} opts.path - 请求路径
 * @param {object} [opts.headers] - 额外请求头
 * @param {string} [opts.body] - 请求体
 * @param {number} [opts.timeoutMs] - 超时 (默认 60s)
 * @param {Function} opts.onResponse - 上游响应回调 (upstreamRes, upstreamReq)
 * @param {Function} [opts.onAbort] - 客户端断开回调
 */
export function proxyStream({ baseUrl, method, path, headers = {}, body, timeoutMs = 60_000, onResponse, onAbort }) {
  const target = new URL(path, normalizeBase(baseUrl));
  const reqImpl = pickImpl(target.protocol);

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = reqImpl(buildRequestOptions(target, method, {
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
      connection: 'keep-alive',
      'cache-control': 'no-cache',
      ...headers,
    }), (upstreamRes) => {
      settled = true;
      resolve(onResponse(upstreamRes, req));
    });

    attachAbort(req, onAbort);
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('上游流式请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 健康检查探测
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - 目标基础 URL
 * @param {number} [opts.timeoutMs] - 超时 (默认 15s)
 * @returns {Promise<{ok: boolean, statusCode: number, body: string, error?: string}>}
 */
export function probeHealth({ baseUrl, timeoutMs = 15_000 }) {
  const target = new URL('/health', normalizeBase(baseUrl));
  const reqImpl = pickImpl(target.protocol);

  return new Promise((resolve) => {
    const req = reqImpl(buildRequestOptions(target, 'GET', {
      accept: 'application/json',
      'accept-encoding': 'identity',
    }), async (res) => {
      const result = await collectResponse(res);
      const decoded = decodeResponseBuffer(result.headers, result.body);
      resolve({
        ok: result.statusCode >= 200 && result.statusCode < 300,
        statusCode: result.statusCode,
        body: decoded.buffer.toString('utf-8'),
      });
    });

    req.on('error', (error) => resolve({ ok: false, statusCode: 0, body: '', error: error.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('健康检查超时')));
    req.end();
  });
}

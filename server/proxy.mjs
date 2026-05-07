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
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const PROXY_TIMEOUT_MS = 120_000;         // 2 分钟

function copySuccessHeaders(proxyRes) {
  const headers = { ...proxyRes.headers };
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  return headers;
}

function decodeResponseStream(proxyRes) {
  const encoding = String(proxyRes.headers['content-encoding'] || '').toLowerCase();
  if (encoding.includes('gzip')) {
    const stream = createGunzip();
    proxyRes.pipe(stream);
    return { stream, decoded: true, encoding: 'gzip' };
  }
  if (encoding.includes('deflate')) {
    const stream = createInflate();
    proxyRes.pipe(stream);
    return { stream, decoded: true, encoding: 'deflate' };
  }
  if (encoding.includes('br')) {
    const stream = createBrotliDecompress();
    proxyRes.pipe(stream);
    return { stream, decoded: true, encoding: 'br' };
  }
  return { stream: proxyRes, decoded: false, encoding: '' };
}

/** 从 SSE chunk 中解析 usage 信息 */
function parseStreamChunk(text, onData) {
  let buf = text;
  while (buf.length > 0) {
    const newlineIdx = buf.indexOf('\n');
    const line = newlineIdx === -1 ? buf : buf.slice(0, newlineIdx);
    buf = newlineIdx === -1 ? '' : buf.slice(newlineIdx + 1);
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        onData(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
}

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
  delete headers['content-encoding'];
  headers['accept-encoding'] = 'identity';
  headers['authorization'] = `Bearer ${keyEntry.key}`;

  // 流式请求注入 stream_options 以获取 usage 统计
  let proxyBody = body;
  if (body && targetPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.stream && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
        proxyBody = JSON.stringify(parsed);
      }
    } catch {}
  }

  // body 被修改时必须更新 content-length，否则上游会截断请求体
  if (proxyBody !== body) {
    headers['content-length'] = Buffer.byteLength(proxyBody);
  }

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
          const retryKey = pool.pickOther(keyEntry.id);
          if (retryKey) {
            log('info', `Retrying with key ${retryKey.id} after ${statusCode} (attempt ${retryCount + 1}/${maxRetries})`);
            return proxyRequest({ ...opts, keyEntry: retryKey, retryCount: retryCount + 1 });
          }
        }

        if (retryCount >= maxRetries) {
          log('warn', `All retry attempts exhausted (${retryCount}/${maxRetries})`);
        }

        // 只透传安全的 headers，过滤上游内部信息
        const safeHeaders = {};
        const allowHeaders = ['content-type', 'retry-after', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
        for (const h of allowHeaders) {
          if (proxyRes.headers[h]) safeHeaders[h] = proxyRes.headers[h];
        }
        res.writeHead(statusCode, safeHeaders);
        res.end(errBody);
      });
      return;
    }

    // 成功 — 流式/非流式透传
    const isStream = proxyRes.headers['content-type']?.includes('text/event-stream');

    if (isStream) {
      // 流式：先缓冲第一个 chunk，确认上游真的返回了 200 再发送 header
      let headersSent = false;
      let usage = null;
      let lineBuf = Buffer.alloc(0); // 用 Buffer 处理 UTF-8 边界
      const upstream = proxyRes;

      upstream.on('data', (chunk) => {
        if (!headersSent) {
          // 检查第一个 chunk 中是否包含错误 SSE 事件
          lineBuf = Buffer.concat([lineBuf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
          const nlIdx = lineBuf.indexOf(0x0A); // '\n'
          if (nlIdx === -1) {
            // 还没有完整行，继续缓冲
            return;
          }
          // 取第一行（用 UTF-8 安全转换）
          const firstLine = lineBuf.slice(0, nlIdx).toString('utf-8').trim();
          const restBuf = lineBuf.slice(nlIdx + 1);
          lineBuf = Buffer.alloc(0);

          if (firstLine.startsWith('event: error')) {
            let errBody = firstLine + '\n';
            upstream.on('data', (c) => { errBody += c.toString(); });
            upstream.on('end', () => {
              pool.markError(keyEntry, statusCode, errBody);
              if ([401, 403, 429].includes(statusCode) && retryCount < maxRetries) {
                const retryKey = pool.pickOther(keyEntry.id);
                if (retryKey) {
                  log('info', `Stream retry with key ${retryKey.id} after error event (attempt ${retryCount + 1}/${maxRetries})`);
                  return proxyRequest({ ...opts, keyEntry: retryKey, retryCount: retryCount + 1 });
                }
              }
              if (!res.headersSent) {
                res.writeHead(statusCode, copySuccessHeaders(proxyRes));
              }
              res.end(errBody);
            });
            return;
          }

          // 正常流式数据，发送 header
          headersSent = true;
          res.writeHead(statusCode, copySuccessHeaders(proxyRes));
          // 处理已缓冲的数据（restBuf 是第一行之后的剩余数据）
          if (restBuf.length > 0) {
            res.write(restBuf);
            processStreamData(restBuf, false);
          }
        } else {
          res.write(chunk);
          processStreamData(chunk, true);
        }
      });

      /** 处理流式数据，用 Buffer 拼接避免 UTF-8 边界截断 */
      function processStreamData(chunk, emit) {
        lineBuf = Buffer.concat([lineBuf, chunk]);
        // 按行分割，最后一行可能不完整，保留在 buffer 中
        const nlIdx = lineBuf.lastIndexOf(0x0A); // '\n'
        if (nlIdx === -1) return;
        const complete = lineBuf.slice(0, nlIdx + 1);
        lineBuf = lineBuf.slice(nlIdx + 1);
        const text = complete.toString('utf-8');
        parseStreamChunk(text, (data) => { if (data.usage) usage = data.usage; });
      }

      upstream.on('end', () => {
        if (!headersSent) {
          headersSent = true;
          res.writeHead(statusCode, copySuccessHeaders(proxyRes));
        }
        // 处理 buffer 中剩余数据
        if (lineBuf.length > 0) {
          parseStreamChunk(lineBuf.toString('utf-8'), (data) => { if (data.usage) usage = data.usage; });
        }
        res.end();
        const tokens = usage?.total_tokens || 0;
        pool.markSuccess(keyEntry, tokens);
        log('info', `✓ ${targetPath} [${keyEntry.id}] ${tokens} tokens (stream)`);
      });
    } else {
      const { stream: responseStream, decoded, encoding } = decodeResponseStream(proxyRes);
      const chunks = [];
      responseStream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      responseStream.on('end', () => {
        const respBuffer = Buffer.concat(chunks);
        const respBody = respBuffer.toString('utf-8');
        const successHeaders = copySuccessHeaders(proxyRes);
        if (decoded) {
          delete successHeaders['content-encoding'];
        }
        res.writeHead(statusCode, successHeaders);
        res.end(respBuffer);
        let tokens = 0;
        try {
          const parsed = JSON.parse(respBody);
          tokens = parsed.usage?.total_tokens || 0;
        } catch {}
        pool.markSuccess(keyEntry, tokens);
        log('info', `✓ ${targetPath} [${keyEntry.id}] ${tokens} tokens${decoded ? ` (decoded ${encoding})` : ''}`);
      });
      responseStream.on('error', (err) => {
        pool.markError(keyEntry, 0, err.message);
        log('error', `Response decode error [${keyEntry.id}]:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { message: 'Upstream decode error', type: 'proxy_error' } }));
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

  // 透传请求体（使用可能注入了 stream_options 的版本）
  if (proxyBody) {
    proxyReq.write(proxyBody);
  }
  proxyReq.end();
}

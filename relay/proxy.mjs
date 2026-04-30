import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

function pickImpl(protocol) {
  return protocol === 'https:' ? httpsRequest : httpRequest;
}

function collectResponse(res) {
  return new Promise((resolve) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      resolve({
        statusCode: res.statusCode || 502,
        headers: res.headers,
        body: data,
      });
    });
  });
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

export function proxyJson({ baseUrl, method, path, headers = {}, body, timeoutMs = 60_000 }) {
  const target = new URL(path, normalizeBase(baseUrl));
  const reqImpl = pickImpl(target.protocol);

  return new Promise((resolve, reject) => {
    const req = reqImpl(buildRequestOptions(target, method, {
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    }), async (res) => resolve(await collectResponse(res)));

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('上游请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

export function proxyStream({ baseUrl, method, path, headers = {}, body, timeoutMs = 60_000, onResponse }) {
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
      resolve(onResponse(upstreamRes));
    });

    req.on('error', (error) => {
      if (!settled) reject(error);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('上游流式请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

export function probeHealth({ baseUrl, timeoutMs = 15_000 }) {
  const target = new URL('/health', normalizeBase(baseUrl));
  const reqImpl = pickImpl(target.protocol);

  return new Promise((resolve) => {
    const req = reqImpl(buildRequestOptions(target, 'GET', {
      accept: 'application/json',
    }), async (res) => {
      const result = await collectResponse(res);
      resolve({
        ok: result.statusCode >= 200 && result.statusCode < 300,
        statusCode: result.statusCode,
        body: result.body,
      });
    });

    req.on('error', (error) => resolve({ ok: false, statusCode: 0, body: '', error: error.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('健康检查超时')));
    req.end();
  });
}

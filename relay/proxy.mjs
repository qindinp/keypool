import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

export function proxyJson({ baseUrl, method, path, headers = {}, body }) {
  const target = new URL(path, normalizeBase(baseUrl));
  const isHttps = target.protocol === 'https:';
  const reqImpl = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = reqImpl({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
    }, (res) => {
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

    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('上游请求超时')));

    if (body) req.write(body);
    req.end();
  });
}

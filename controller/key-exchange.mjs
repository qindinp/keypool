import http from 'node:http';
import https from 'node:https';

export async function pushKeyExchange(key, keyExchangeUrl, log) {
  if (!keyExchangeUrl) return;

  try {
    const url = new URL(keyExchangeUrl);
    const body = JSON.stringify({
      key,
      source: 'controller',
      timestamp: new Date().toISOString(),
    });

    const requester = url.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = requester.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    log('ok', `Key 已推送到 ${keyExchangeUrl}`);
  } catch (e) {
    log('warn', `Key 推送失败: ${e.message}`);
  }
}

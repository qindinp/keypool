import https from 'node:https';
import { BASE, PH, getCookie, extractPhFromCookie, resolvePh } from '../shared/cookie.mjs';

export { getCookie };

function apiRaw(path, cookie, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = {
      cookie,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      accept: 'application/json',
    };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }

    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ raw: d, statusCode: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('HTTP 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

export function createMimoApi({ sleep }) {
  async function api(path, cookie, method = 'GET', body = null) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        return await apiRaw(path, cookie, method, body);
      } catch (e) {
        lastErr = e;
        if (i < 2) await sleep(2000 * (i + 1));
      }
    }
    throw lastErr;
  }

  async function getStatus(cookie) {
    const resp = await api(`/open-apis/user/mimo-claw/status?${resolvePh(cookie)}`, cookie);
    if (resp.code !== 0) throw new Error(`获取状态失败: ${JSON.stringify(resp)}`);
    return resp.data;
  }

  async function createInstance(cookie) {
    const resp = await api(`/open-apis/user/mimo-claw/create?${resolvePh(cookie)}`, cookie, 'POST', '{}');
    if (resp.code !== 0) throw new Error(`创建实例失败: ${JSON.stringify(resp)}`);
    return resp.data;
  }

  async function destroyInstance(cookie) {
    const resp = await api(`/open-apis/user/mimo-claw/destroy?${resolvePh(cookie)}`, cookie, 'POST', '');
    if (resp.code !== 0) throw new Error(`销毁实例失败: ${JSON.stringify(resp)}`);
    return resp.data;
  }

  async function getTicket(cookie) {
    const resp = await api(`/open-apis/user/ws/ticket?${resolvePh(cookie)}`, cookie);
    if (resp.code !== 0) throw new Error(`获取 ticket 失败: ${JSON.stringify(resp)}`);
    return resp.data.ticket;
  }

  async function validateCookie(cookie) {
    try {
      const resp = await api(`/open-apis/user/mi/get?${resolvePh(cookie)}`, cookie);
      if (resp.code === 0 && resp.data?.userId) {
        return { valid: true, userId: resp.data.userId, userName: resp.data.userName };
      }
      return { valid: false, reason: resp.msg || 'unknown' };
    } catch (e) {
      return { valid: false, reason: e.message };
    }
  }

  return { api, getStatus, createInstance, destroyInstance, getTicket, validateCookie, extractPhFromCookie, resolvePh };
}

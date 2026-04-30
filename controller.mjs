#!/usr/bin/env node
/**
 * KeyPool Controller (Part 2 — 外部持久服务器)
 *
 * 运行在持久化的外部服务器上，自动管理 AI Studio 限时实例：
 *   1. 监控实例状态，到期前自动续期
 *   2. 通过 WebSocket 向新实例下发 KeyPool 部署指令
 *   3. 验证部署成功，获取新 API Key
 *   4. 通过 key-exchange 推送新 Key 给消费者
 *
 * 用法:
 *   node controller.mjs                     # 持续运行
 *   node controller.mjs --once              # 单次检查
 *   node controller.mjs --status            # 查看状态
 *   node controller.mjs --deploy            # 强制重新部署
 *
 * 环境变量:
 *   MIMO_COOKIE      — 小米 AI Studio 登录 cookie (必需)
 *   DEPLOY_REPO      — 部署仓库地址
 *   RENEW_BEFORE     — 到期前多少秒续期 (默认: 300)
 *   CHECK_INTERVAL   — 检查间隔秒数 (默认: 60)
 *   KEY_EXCHANGE_URL — Key 交换服务地址 (可选, 如 http://host:9201/key)
 */

import https from 'node:https';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://aistudio.xiaomimimo.com';
const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';

// ─── 配置 ──────────────────────────────────────────────────────────
const CONFIG = {
  renewBefore: (parseInt(process.env.RENEW_BEFORE) || 300) * 1000,
  checkInterval: (parseInt(process.env.CHECK_INTERVAL) || 60) * 1000,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
  deployRepo: process.env.DEPLOY_REPO || 'https://github.com/qindinp/keypool.git',
  keyExchangeUrl: process.env.KEY_EXCHANGE_URL || null,
  readyTimeout: 180_000,
  wsConnectTimeout: 30_000,
  deployTimeout: 300_000,     // 部署可能需要 clone + 启动，给 5min
  chatTimeout: 120_000,
  retryBaseDelay: 5_000,      // 重试基础延迟
  retryMaxDelay: 60_000,      // 重试最大延迟
};

const STATE_PATH = resolve(__dirname, '.controller-state.json');
const LOG_PATH = resolve(__dirname, '.controller.log');

// ─── 日志 ──────────────────────────────────────────────────────────
const LOG_ICONS = {
  info: 'ℹ️ ', warn: '⚠️ ', error: '❌', ok: '✅',
  rocket: '🚀', clock: '⏰', link: '🔗', key: '🔑',
  skip: '⏭️ ', retry: '🔄', ping: '💓', deploy: '📦',
};

function log(level, ...args) {
  const ts = new Date().toLocaleString('zh-CN', {
    hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const icon = LOG_ICONS[level] || '  ';
  const line = `[${ts}] ${icon} ${args.join(' ')}`;
  console.log(line);
  // 追加到日志文件
  try { writeFileSync(LOG_PATH, line + '\n', { flag: 'a' }); } catch {}
}

// ─── Cookie ────────────────────────────────────────────────────────
function getCookie() {
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE;
  const f = resolve(__dirname, '.cookie');
  if (existsSync(f)) return readFileSync(f, 'utf-8').trim();
  console.error('❌ 请设置 MIMO_COOKIE 环境变量或创建 .cookie 文件');
  process.exit(1);
}

// ─── 状态持久化 ────────────────────────────────────────────────────
function loadState() {
  try {
    return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf-8')) : {};
  } catch { return {}; }
}

function saveState(state) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (e) {
    log('error', `状态保存失败: ${e.message}`);
  }
}

// ─── HTTP API (带重试) ────────────────────────────────────────────
function apiRaw(path, cookie, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = {
      'cookie': cookie,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'accept': 'application/json',
    };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }

    const req = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method, headers,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ raw: d, statusCode: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('HTTP 请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

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

// ─── 实例 API ──────────────────────────────────────────────────────
async function getStatus(cookie) {
  const resp = await api(`/open-apis/user/mimo-claw/status?${PH}`, cookie);
  if (resp.code !== 0) throw new Error(`获取状态失败: ${JSON.stringify(resp)}`);
  return resp.data;
}

async function createInstance(cookie) {
  const resp = await api(`/open-apis/user/mimo-claw/create?${PH}`, cookie, 'POST', '{}');
  if (resp.code !== 0) throw new Error(`创建实例失败: ${JSON.stringify(resp)}`);
  return resp.data;
}

async function getTicket(cookie) {
  const resp = await api(`/open-apis/user/ws/ticket?${PH}`, cookie);
  if (resp.code !== 0) throw new Error(`获取 ticket 失败: ${JSON.stringify(resp)}`);
  return resp.data.ticket;
}

async function validateCookie(cookie) {
  try {
    const resp = await api(`/open-apis/user/mi/get?${PH}`, cookie);
    if (resp.code === 0 && resp.data?.userId) {
      return { valid: true, userId: resp.data.userId, userName: resp.data.userName };
    }
    return { valid: false, reason: resp.msg || 'unknown' };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

// ─── WebSocket 帧 ──────────────────────────────────────────────────
function wsFrame(data, opcode = 0x01) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode; header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2); mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2); mask.copy(header, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, masked]);
}

function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const byte1 = buf[off], byte2 = buf[off + 1];
    const opcode = byte1 & 0x0f;
    let payloadLen = byte2 & 0x7f, hdrLen = 2;
    if (payloadLen === 126) {
      if (off + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(off + 2); hdrLen = 4;
    } else if (payloadLen === 127) {
      if (off + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(off + 2)); hdrLen = 10;
    }
    if (off + hdrLen + payloadLen > buf.length) break;
    frames.push({ opcode, payload: buf.slice(off + hdrLen, off + hdrLen + payloadLen) });
    off += hdrLen + payloadLen;
  }
  return { frames, remaining: buf.slice(off) };
}

// ─── DeployClient (带重连的 WebSocket 客户端) ──────────────────────
class DeployClient {
  constructor(cookie) {
    this.cookie = cookie;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.pending = new Map();
    this._chatResolve = null;
    this._chatReject = null;
  }

  async connect() {
    const ticket = await getTicket(this.cookie);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket 握手超时'));
      }, CONFIG.wsConnectTimeout);

      const wsKey = randomBytes(16).toString('base64');
      const req = https.request({
        hostname: 'aistudio.xiaomimimo.com', port: 443,
        path: '/ws/proxy?ticket=' + ticket, method: 'GET',
        headers: {
          'Upgrade': 'websocket', 'Connection': 'Upgrade',
          'Sec-WebSocket-Key': wsKey, 'Sec-WebSocket-Version': '13',
          'Cookie': this.cookie, 'Origin': BASE,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      req.on('upgrade', (res, socket, head) => {
        clearTimeout(timeout);
        this.socket = socket;
        this.buf = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
        this._setupHandlers(resolve, reject);
      });

      req.on('error', (e) => { clearTimeout(timeout); reject(e); });
      req.end();
    });
  }

  _setupHandlers(resolve, reject) {
    const onFrame = (msg) => {
      if (msg.event === 'connect.challenge') return;

      if (msg.type === 'res') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          clearTimeout(p.timeout);
          msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.error?.message || 'request failed'));
        }
        return;
      }

      if (msg.type === 'event' && msg.event === 'chat') {
        const p = msg.payload;
        if (!p) return;

        if (p.state === 'final' && this._chatResolve) {
          const resolve = this._chatResolve;
          this._chatResolve = null;
          this._chatReject = null;
          const sk = p.sessionKey || 'main';
          this.request('chat.history', { sessionKey: sk, limit: 1 }, 15000)
            .then(hist => {
              const msgs = hist?.messages || [];
              if (msgs.length > 0) {
                const last = msgs[msgs.length - 1];
                const text = typeof last.content === 'string' ? last.content :
                  Array.isArray(last.content) ? last.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
                resolve(text);
              } else { resolve(''); }
            })
            .catch(() => resolve(''));
          return;
        }

        if ((p.state === 'aborted' || p.state === 'error') && this._chatReject) {
          const reject = this._chatReject;
          this._chatResolve = null;
          this._chatReject = null;
          reject(new Error(`chat ${p.state}: ${p.errorMessage || ''}`));
          return;
        }
      }
    };

    this.socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this._processFrames(onFrame);
    });

    this.socket.on('error', (e) => {
      log('error', 'Socket 错误:', e.message);
      this.connected = false;
      this._rejectPending(new Error('socket disconnected'));
    });

    this.socket.on('close', () => {
      this.connected = false;
      this._rejectPending(new Error('socket closed'));
    });

    // connect 认证
    const connectId = randomUUID();
    this.pending.set(connectId, {
      resolve: (payload) => {
        this.connected = true;
        log('link', `Gateway 已连接 (v${payload?.server?.version || '?'})`);
        resolve(payload);
      },
      reject,
      timeout: setTimeout(() => reject(new Error('connect 认证超时')), 15000),
    });

    this._send({
      type: 'req', id: connectId, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'controller', version: 'keypool-controller', platform: 'Linux', mode: 'cli' },
        role: 'operator',
        scopes: ['operator.admin', 'operator.read', 'operator.write'],
        caps: ['tool-events'],
        userAgent: 'Mozilla/5.0', locale: 'zh-CN',
      },
    });

    if (this.buf.length > 0) this._processFrames(onFrame);
  }

  _processFrames(onFrame) {
    const { frames, remaining } = parseFrames(this.buf);
    this.buf = remaining;
    for (const f of frames) {
      if (f.opcode === 0x01) {
        try { onFrame(JSON.parse(f.payload.toString())); } catch {}
      } else if (f.opcode === 0x08) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 0;
        if (code !== 1000) log('info', `WS 关闭码: ${code}`);
        this.socket.end();
        this.connected = false;
      } else if (f.opcode === 0x09) {
        this.socket.write(Buffer.from([0x8a, 0x00]));
      }
    }
  }

  _rejectPending(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
    if (this._chatReject) {
      this._chatReject(err);
      this._chatResolve = null;
      this._chatReject = null;
    }
  }

  _send(msg) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(wsFrame(msg));
    }
  }

  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected'));
      const id = randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this._send({ type: 'req', id, method, params });
    });
  }

  async chat(message, timeoutMs = CONFIG.chatTimeout) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._chatResolve = null;
        this._chatReject = null;
        reject(new Error('chat 超时'));
      }, timeoutMs);

      this._chatResolve = (text) => { clearTimeout(timeout); resolve(text); };
      this._chatReject = (err) => { clearTimeout(timeout); reject(err); };

      this.request('chat.send', {
        sessionKey: 'main',
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      }, timeoutMs).catch(e => {
        clearTimeout(timeout);
        this._chatResolve = null;
        this._chatReject = null;
        reject(e);
      });
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.end(); } catch {}
    }
    this.connected = false;
  }
}

// ─── 带重试的操作 ──────────────────────────────────────────────────
async function withRetry(name, fn, maxRetries = CONFIG.maxRetries) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries) throw e;
      const delay = Math.min(CONFIG.retryBaseDelay * Math.pow(2, i), CONFIG.retryMaxDelay);
      log('retry', `${name} 失败 (${i + 1}/${maxRetries}): ${e.message}, ${delay / 1000}s 后重试`);
      await sleep(delay);
    }
  }
}

// ─── 等待实例就绪 ──────────────────────────────────────────────────
async function waitForReady(cookie) {
  const start = Date.now();
  log('clock', '等待实例就绪...');

  // 阶段1: 等待 status === AVAILABLE
  while (Date.now() - start < CONFIG.readyTimeout) {
    try {
      const status = await getStatus(cookie);
      if (status.status === 'AVAILABLE') break;
      log('info', `实例状态: ${status.status}，继续等待...`);
    } catch {}
    await sleep(5000);
  }

  if (Date.now() - start >= CONFIG.readyTimeout) {
    log('error', '等待实例 AVAILABLE 超时');
    return false;
  }

  // 阶段2: 等待 ticket 可用 (Gateway 已连接平台)
  const ticketStart = Date.now();
  while (Date.now() - ticketStart < 60_000) {
    try {
      await getTicket(cookie);
      const elapsed = Math.round((Date.now() - start) / 1000);
      log('ok', `实例就绪 (${elapsed}s)`);
      return true;
    } catch {}
    await sleep(3000);
  }

  log('error', '等待 ticket 超时 (Gateway 可能未启动)');
  return false;
}

// ─── 部署 KeyPool ──────────────────────────────────────────────────
async function deployKeyPool(cookie) {
  const client = new DeployClient(cookie);

  try {
    log('link', '连接实例 WebSocket...');
    await withRetry('WS连接', () => client.connect());

    // 部署指令 — 设计原则：
    // 1. 清理旧代码，重新 clone
    // 2. 覆盖 SOUL.md 为项目版本
    // 3. 后台启动 KeyPool
    // 4. 输出唯一标记确认成功
    const marker = `DEPLOY_${Date.now().toString(36)}`;
    const deployCmd = [
      `cd /root/.openclaw/workspace`,
      `rm -rf keypool`,
      `git clone ${CONFIG.deployRepo}`,
      `cp keypool/SOUL.md SOUL.md`,
      `cd keypool`,
      `nohup node server.mjs > /tmp/keypool.log 2>&1 &`,
      `sleep 2`,
      `if curl -sf http://127.0.0.1:9200/health > /dev/null 2>&1; then echo "${marker}_OK"; else echo "${marker}_FAIL"; fi`,
    ].join(' && ');

    log('deploy', '下发部署指令...');
    const reply = await client.chat(deployCmd, CONFIG.deployTimeout);

    // 验证结果
    if (reply?.includes(`${marker}_OK`)) {
      log('ok', 'KeyPool 部署成功，健康检查通过');
      return true;
    } else if (reply?.includes(`${marker}_FAIL`)) {
      log('error', 'KeyPool 启动后健康检查失败');
      log('info', '回复:', reply?.slice(0, 300));
      return false;
    } else if (reply && /部署|deploy|clone|running|success/i.test(reply)) {
      log('warn', '部署可能成功，但未检测到标记');
      log('info', '回复:', reply?.slice(0, 300));
      return true;  // 乐观判断
    } else {
      log('error', '部署结果异常');
      log('info', '回复:', reply?.slice(0, 500));
      return false;
    }
  } catch (e) {
    log('error', '部署失败:', e.message);
    return false;
  } finally {
    client.close();
  }
}

// ─── 获取新 API Key ────────────────────────────────────────────────
async function fetchNewApiKey(cookie) {
  const client = new DeployClient(cookie);
  try {
    await client.connect();
    const reply = await client.chat(
      '执行命令 echo $MIMO_API_KEY 并将结果原样输出，不要添加任何额外文字或格式',
      30000
    );
    const match = reply?.match(/(oc_[a-zA-Z0-9_]+)/);
    if (match) {
      log('key', `新 Key: ${match[1].slice(0, 20)}...`);
      return match[1];
    }
    log('warn', '未能提取 Key');
    log('info', '回复:', reply?.slice(0, 200));
    return null;
  } catch (e) {
    log('error', '获取 Key 失败:', e.message);
    return null;
  } finally {
    client.close();
  }
}

// ─── Key Exchange 推送 ─────────────────────────────────────────────
async function pushKeyExchange(key) {
  if (!CONFIG.keyExchangeUrl) return;

  try {
    const url = new URL(CONFIG.keyExchangeUrl);
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
        path: url.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    log('ok', `Key 已推送到 ${CONFIG.keyExchangeUrl}`);
  } catch (e) {
    log('warn', `Key 推送失败: ${e.message}`);
  }
}

// ─── 完整续期流程 ──────────────────────────────────────────────────
async function renewFlow(cookie, reason) {
  log('rocket', `开始续期流程 (${reason})`);

  // 1. 创建新实例
  let newStatus;
  try {
    newStatus = await withRetry('创建实例', () => createInstance(cookie));
  } catch (e) {
    log('error', '创建实例失败:', e.message);
    return false;
  }

  if (!newStatus.expireTime) {
    log('error', '创建返回异常:', JSON.stringify(newStatus));
    return false;
  }

  log('ok', `新实例到期: ${new Date(newStatus.expireTime).toLocaleString()}`);

  // 2. 等待就绪
  const ready = await waitForReady(cookie);
  if (!ready) {
    log('error', '实例未就绪，续期流程中止');
    return false;
  }

  // 3. 部署 KeyPool
  const deployed = await deployKeyPool(cookie);
  if (!deployed) {
    log('error', 'KeyPool 部署失败');
    return false;
  }

  // 4. 获取新 Key
  const newKey = await fetchNewApiKey(cookie);

  // 5. 推送 Key
  if (newKey) {
    await pushKeyExchange(newKey);
  }

  // 6. 更新状态
  const state = loadState();
  state.lastExpireTime = newStatus.expireTime;
  state.lastDeployAt = Date.now();
  state.deployCount = (state.deployCount || 0) + 1;
  if (newKey) state.currentKey = newKey;
  state.history = state.history || [];
  state.history.push({
    at: new Date().toISOString(),
    reason,
    expireTime: newStatus.expireTime,
    key: newKey ? newKey.slice(0, 20) + '...' : null,
    success: true,
  });
  // 只保留最近 50 条记录
  if (state.history.length > 50) state.history = state.history.slice(-50);
  saveState(state);

  log('ok', `✨ 第 ${state.deployCount} 次续期完成`);
  return true;
}

// ─── 命令处理 ──────────────────────────────────────────────────────
async function cmdStatus(cookie) {
  const state = loadState();
  console.log('\n📊 Controller 状态:');
  console.log('─'.repeat(40));
  console.log(`  部署次数: ${state.deployCount || 0}`);
  console.log(`  当前 Key: ${state.currentKey ? state.currentKey.slice(0, 20) + '...' : '未知'}`);
  console.log(`  上次部署: ${state.lastDeployAt ? new Date(state.lastDeployAt).toLocaleString() : '无'}`);

  try {
    const status = await getStatus(cookie);
    const remaining = status.expireTime - Date.now();
    console.log(`\n  实例状态: ${status.status}`);
    console.log(`  剩余时间: ${Math.round(remaining / 60_000)}min`);
    console.log(`  到期时间: ${new Date(status.expireTime).toLocaleString()}`);
  } catch (e) {
    console.log(`\n  ❌ 获取实例状态失败: ${e.message}`);
  }

  if (state.history?.length > 0) {
    console.log(`\n  最近续期记录:`);
    for (const h of state.history.slice(-5)) {
      console.log(`    ${h.at} | ${h.reason} | ${h.success ? '✅' : '❌'}`);
    }
  }
  console.log();
}

async function cmdDeploy(cookie) {
  log('deploy', '强制重新部署...');
  await renewFlow(cookie, 'manual-deploy');
}

// ─── 主循环 ────────────────────────────────────────────────────────
async function main() {
  const cookie = getCookie();
  const args = process.argv.slice(2);

  // Cookie 验证
  const auth = await validateCookie(cookie);
  if (!auth.valid) {
    log('error', `Cookie 无效: ${auth.reason}`);
    log('info', '请更新 .cookie 文件或 MIMO_COOKIE 环境变量');
    process.exit(1);
  }
  log('ok', `Cookie 有效 — 用户: ${auth.userName} (${auth.userId})`);

  // 命令分发
  if (args.includes('--status')) return cmdStatus(cookie);
  if (args.includes('--deploy')) return cmdDeploy(cookie);

  const once = args.includes('--once');
  const state = loadState();

  log('info', '═'.repeat(50));
  log('info', 'KeyPool Controller (Part 2) 启动');
  log('info', `检查间隔: ${CONFIG.checkInterval / 1000}s | 续期阈值: 到期前 ${CONFIG.renewBefore / 1000}s`);
  log('info', `仓库: ${CONFIG.deployRepo}`);
  if (CONFIG.keyExchangeUrl) log('info', `Key 交换: ${CONFIG.keyExchangeUrl}`);
  log('info', `模式: ${once ? '单次检查' : '持续运行'}`);
  log('info', '═'.repeat(50));

  // 显示历史
  if (state.deployCount > 0) {
    log('info', `历史: 已续期 ${state.deployCount} 次, 上次: ${state.lastDeployAt ? new Date(state.lastDeployAt).toLocaleString() : '未知'}`);
  }

  const loop = async () => {
    while (true) {
      try {
        const status = await getStatus(cookie);
        const now = Date.now();
        const remaining = status.expireTime - now;
        const remainMin = Math.round(remaining / 60_000);

        // 状态变化日志
        if (state.lastExpireTime !== status.expireTime) {
          log('info', `实例 ${status.status} | 剩余 ${remainMin}min | 到期 ${new Date(status.expireTime).toLocaleString()}`);
          state.lastExpireTime = status.expireTime;
          saveState(state);
        }

        // 到期前续期
        if (remaining > 0 && remaining < CONFIG.renewBefore) {
          log('clock', `⏰ 即将到期 (剩余 ${remainMin}min)`);
          await renewFlow(cookie, 'expiring');
        }

        // 已过期
        if (remaining <= 0) {
          log('error', '❌ 实例已过期!');
          await renewFlow(cookie, 'expired');
        }

      } catch (e) {
        log('error', '主循环异常:', e.message);
      }

      if (once) break;
      await sleep(CONFIG.checkInterval);
    }
  };

  // 优雅关闭
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `收到 ${sig}，正在关闭...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await loop();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(e => {
  log('error', '致命错误:', e.message);
  process.exit(1);
});

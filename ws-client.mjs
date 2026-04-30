#!/usr/bin/env node
/**
 * MiMo WebSocket 客户端
 * 通过 WebSocket 和沙箱里的 OpenClaw 对话
 * 
 * 用法:
 *   node ws-client.mjs                       # 交互模式
 *   node ws-client.mjs "你好"                 # 发送单条消息
 *   node ws-client.mjs --sessions             # 列出会话
 *   node ws-client.mjs --history main 10      # 查看历史
 */

import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://aistudio.xiaomimimo.com';
const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';

// ─── Cookie ──────────────────────────────────────────────────────
function getCookie() {
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE;
  const f = resolve(__dirname, '.cookie');
  if (existsSync(f)) return readFileSync(f, 'utf-8').trim();
  console.error('❌ 请设置 MIMO_COOKIE 环境变量或创建 .cookie 文件');
  process.exit(1);
}

// ─── HTTP ────────────────────────────────────────────────────────
function api(path, cookie) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'aistudio.xiaomimimo.com', path, headers: { 'cookie': cookie, 'accept': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    }).on('error', reject);
  });
}

// ─── WebSocket 帧 ───────────────────────────────────────────────
function wsFrame(data, opcode = 0x01) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6); header[0] = 0x80 | opcode; header[1] = 0x80 | payload.length; mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); mask.copy(header, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, masked]);
}

function parseFrames(buf) {
  const frames = []; let off = 0;
  while (off + 2 <= buf.length) {
    const byte1 = buf[off], byte2 = buf[off + 1];
    const opcode = byte1 & 0x0f;
    let payloadLen = byte2 & 0x7f, hdrLen = 2;
    if (payloadLen === 126) { if (off + 4 > buf.length) break; payloadLen = buf.readUInt16BE(off + 2); hdrLen = 4; }
    else if (payloadLen === 127) { if (off + 10 > buf.length) break; payloadLen = Number(buf.readBigUInt64BE(off + 2)); hdrLen = 10; }
    if (off + hdrLen + payloadLen > buf.length) break;
    frames.push({ opcode, payload: buf.slice(off + hdrLen, off + hdrLen + payloadLen) });
    off += hdrLen + payloadLen;
  }
  return { frames, remaining: buf.slice(off) };
}

// ─── WebSocket Client ────────────────────────────────────────────
class MiMoGateway {
  constructor(cookie) {
    this.cookie = cookie;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.pending = new Map();
    this.eventHandlers = [];
    this.streamHandler = null;
  }

  async connect() {
    const ticketResp = await api(`/open-apis/user/ws/ticket?${PH}`, this.cookie);
    if (ticketResp.code !== 0) throw new Error('获取 ticket 失败: ' + JSON.stringify(ticketResp));
    const ticket = ticketResp.data.ticket;

    return new Promise((resolve, reject) => {
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
        this.socket = socket;
        this.buf = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
        const onFrame = (msg) => {
          // Ignore challenge (connect already sent above)
          if (msg.event === 'connect.challenge') return;

          // Response
          if (msg.type === 'res') {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              clearTimeout(p.timeout);
              msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.error?.message || 'request failed'));
            }
            return;
          }

          // Agent event (might contain response content)
          if (msg.type === 'event' && msg.event === 'agent') {
            if (this.streamHandler && msg.payload) {
              const p = msg.payload;
              // Extract text from various possible locations
              const extractText = (obj) => {
                if (!obj) return '';
                if (typeof obj === 'string') return obj;
                if (typeof obj.text === 'string') return obj.text;
                if (typeof obj.content === 'string') return obj.content;
                if (Array.isArray(obj.content)) {
                  return obj.content.filter(b => b.type === 'text').map(b => b.text).join('');
                }
                if (obj.message) return extractText(obj.message);
                if (obj.delta) return extractText(obj.delta);
                return '';
              };
              const text = extractText(p);
              if (text) this.streamHandler({ text, content: text });
            }
            return;
          }

          // Chat event (streaming delta or final)
          if (msg.type === 'event' && msg.event === 'chat') {
            const p = msg.payload;
            if (!p) return;

            if (p.state === 'final' && this._pendingChatResolve) {
              const resolve = this._pendingChatResolve;
              this._pendingChatResolve = null;
              this.streamHandler = null;
              // Fetch latest message from history
              const sk = p.sessionKey || 'main';
              this.request('chat.history', { sessionKey: sk, limit: 1 }, 15000).then((hist) => {
                const msgs = hist?.messages || [];
                if (msgs.length > 0) {
                  const last = msgs[msgs.length - 1];
                  const content = last.content;
                  let text = '';
                  if (typeof content === 'string') text = content;
                  else if (Array.isArray(content)) {
                    text = content.filter(b => b.type === 'text').map(b => b.text).join('');
                  }
                  if (text) process.stdout.write(text);
                  resolve(text);
                } else {
                  resolve('');
                }
              }).catch(() => resolve(''));
              return;
            }

            if ((p.state === 'aborted' || p.state === 'error') && this._pendingChatResolve) {
              if (p.errorMessage) console.error('\n❌', p.errorMessage);
              this._pendingChatResolve('');
              this._pendingChatResolve = null;
              this.streamHandler = null;
              return;
            }
          }

          // Other events
          for (const h of this.eventHandlers) { try { h(msg); } catch {} }
        };

        this._setupDataHandler(onFrame);

        // Wait for connect response — intercept the pending entry
        const connectId = randomUUID();
        const origResolve = resolve;
        const origReject = reject;
        this.pending.set(connectId, {
          resolve: (payload) => {
            this.connected = true;
            console.log('✅ Gateway 已连接 (v' + (payload?.server?.version || '?') + ')');
            origResolve(payload);
          },
          reject: origReject,
          timeout: setTimeout(() => origReject(new Error('connect timeout')), 10000),
        });

        // Send connect with matching id
        this._send({
          type: 'req', id: connectId, method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'cli', version: 'mimo-claw-ui', platform: 'Win32', mode: 'cli' },
            role: 'operator',
            scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
            caps: ['tool-events'],
            userAgent: 'Mozilla/5.0', locale: 'zh-CN',
          }
        });

        // Process head buffer
        this._processFrames(onFrame);
      });

      req.on('error', reject);
      req.end();
    });
  }

  _setupDataHandler(onFrame) {
    this.socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this._processFrames(onFrame);
    });
    this.socket.on('error', (e) => console.error('❌ Socket:', e.message));
    this.socket.on('close', () => { this.connected = false; });
  }

  _processFrames(onFrame) {
    const { frames, remaining } = parseFrames(this.buf);
    this.buf = remaining;
    for (const f of frames) {
      if (f.opcode === 0x01) {
        try { onFrame(JSON.parse(f.payload.toString())); } catch {}
      } else if (f.opcode === 0x08) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 0;
        if (code !== 1000) console.log('🔌 关闭:', code);
        this.socket.end();
      } else if (f.opcode === 0x09) {
        this.socket.write(Buffer.from([0x8a, 0x00]));
      }
    }
  }

  _send(msg) {
    this.socket.write(wsFrame(msg));
  }

  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.connected && method !== 'connect') return reject(new Error('not connected'));
      const id = randomUUID();
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this._send({ type: 'req', id, method, params });
    });
  }

  onEvent(handler) { this.eventHandlers.push(handler); }

  async chat(sessionKey, message) {
    this.streamHandler = () => {}; // active marker
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => { this.streamHandler = null; reject(new Error('chat timeout')); }, 120000);

      // Wait for chat final event
      this._pendingChatResolve = async (payload) => {
        clearTimeout(timeout);
        this.streamHandler = null;
        // Fetch the latest message from history
        try {
          const hist = await this.request('chat.history', { sessionKey, limit: 1 }, 15000);
          const msgs = hist?.messages || hist?.data?.messages || [];
          if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            const text = typeof last.content === 'string' ? last.content :
                         Array.isArray(last.content) ? last.content.filter(b => b.type === 'text').map(b => b.text).join('') :
                         last.text || JSON.stringify(last.content || '');
            process.stdout.write(text);
            resolve(text);
          } else {
            resolve('');
          }
        } catch (e) {
          resolve('');
        }
      };

      try {
        await this.request('chat.send', {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        }, 120000);
      } catch (e) {
        clearTimeout(timeout);
        this.streamHandler = null;
        this._pendingChatResolve = null;
        reject(e);
      }
    });
  }

  close() { if (this.socket) this.socket.end(); this.connected = false; }
}

// ─── 命令 ────────────────────────────────────────────────────────
async function cmdSessions(gw) {
  const resp = await gw.request('sessions.list', { includeGlobal: true, limit: 20 });
  const sessions = resp?.sessions || resp?.data?.sessions || [];
  console.log(`\n📋 ${sessions.length} 个会话:\n`);
  for (const s of sessions) {
    console.log(`  • ${s.key}${s.updatedAt ? ' — ' + new Date(s.updatedAt).toLocaleString() : ''}`);
  }
  return sessions;
}

async function cmdHistory(gw, sessionKey = 'main', limit = 20) {
  const resp = await gw.request('chat.history', { sessionKey, limit });
  const messages = resp?.messages || resp?.data?.messages || [];
  console.log(`\n📜 ${sessionKey} 最近 ${messages.length} 条:\n`);
  for (const m of messages) {
    const icon = m.role === 'user' ? '👤' : m.role === 'assistant' ? '🤖' : '⚙️';
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    console.log(`${icon} [${m.role}] ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}`);
  }
  return messages;
}

async function cmdInteractive(gw) {
  console.log('\n🎤 交互模式 (输入消息发送, /sessions /history /quit)\n');
  await cmdSessions(gw);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n💬 你: ' });
  rl.prompt();

  rl.on('line', async (line) => {
    const msg = line.trim();
    if (!msg) { rl.prompt(); return; }
    if (msg === '/quit') { gw.close(); process.exit(0); }
    if (msg === '/sessions') { await cmdSessions(gw); rl.prompt(); return; }
    if (msg.startsWith('/history')) {
      const parts = msg.split(/\s+/);
      await cmdHistory(gw, parts[1] || 'main', parseInt(parts[2]) || 20);
      rl.prompt(); return;
    }

    try {
      console.log('\n🤖 ');
      await gw.chat('main', msg);
      console.log('');
    } catch (e) {
      console.error('❌', e.message);
    }
    rl.prompt();
  });

  rl.on('close', () => { gw.close(); process.exit(0); });
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  const cookie = getCookie();
  const args = process.argv.slice(2);

  console.log('🔗 MiMo Gateway 客户端\n');

  const gw = new MiMoGateway(cookie);
  await gw.connect();

  // 监听非关键事件
  gw.onEvent((evt) => {
    if (['connect.challenge', 'chat', 'health', 'tick', 'presence'].includes(evt.event)) return;
    console.log(`[event] ${evt.event}`, JSON.stringify(evt.payload || {}).slice(0, 200));
  });

  if (args[0] === '--sessions') {
    await cmdSessions(gw);
    gw.close();
  } else if (args[0] === '--history') {
    await cmdHistory(gw, args[1] || 'main', parseInt(args[2]) || 20);
    gw.close();
  } else if (args.length > 0 && !args[0].startsWith('--')) {
    console.log('\n🤖 ');
    await gw.chat('main', args.join(' '));
    console.log('');
    gw.close();
  } else {
    await cmdInteractive(gw);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

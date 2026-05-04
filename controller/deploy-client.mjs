import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { BASE } from './config.mjs';

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

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
  }
  return '';
}

export class DeployClient {
  constructor({ cookie, getTicket, config, log }) {
    this.cookie = cookie;
    this.getTicket = getTicket;
    this.config = config;
    this.log = log;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.pending = new Map();
    this._chatResolve = null;
    this._chatReject = null;
    this._chatMatcher = null;
  }

  async connect() {
    const ticket = await this.getTicket(this.cookie);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket 握手超时'));
      }, this.config.wsConnectTimeout);

      const wsKey = randomBytes(16).toString('base64');
      const req = https.request({
        hostname: 'aistudio.xiaomimimo.com', port: 443,
        path: '/ws/proxy?ticket=' + ticket, method: 'GET',
        headers: {
          Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': wsKey, 'Sec-WebSocket-Version': '13',
          Cookie: this.cookie, Origin: BASE,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      req.on('upgrade', (_res, socket, head) => {
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
          const resolveChat = this._chatResolve;
          const matcher = this._chatMatcher;
          this._chatResolve = null;
          this._chatReject = null;
          this._chatMatcher = null;
          const sk = p.sessionKey || 'main';
          this.request('chat.history', { sessionKey: sk, limit: 20 }, 15000)
            .then(hist => {
              const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
              const texts = msgs.map(msg => ({
                role: String(msg?.role || '').toLowerCase(),
                text: extractTextContent(msg?.content).trim(),
              })).filter(item => item.text);

              const assistantTexts = texts.filter(item => item.role === 'assistant');
              const matching = matcher
                ? assistantTexts.filter(item => item.text.includes(matcher)).map(item => item.text)
                : [];
              const fallbackAssistant = assistantTexts.map(item => item.text);
              const fallbackAny = texts.map(item => item.text);
              resolveChat(matching.at(-1) || fallbackAssistant.at(-1) || fallbackAny.at(-1) || '');
            })
            .catch(() => resolveChat(''));
          return;
        }

        if ((p.state === 'aborted' || p.state === 'error') && this._chatReject) {
          const rejectChat = this._chatReject;
          this._chatResolve = null;
          this._chatReject = null;
          this._chatMatcher = null;
          rejectChat(new Error(`chat ${p.state}: ${p.errorMessage || ''}`));
        }
      }
    };

    this.socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this._processFrames(onFrame);
    });

    this.socket.on('error', (e) => {
      this.log('error', 'Socket 错误:', e.message);
      this.connected = false;
      this._rejectPending(new Error('socket disconnected'));
    });

    this.socket.on('close', () => {
      this.connected = false;
      this._rejectPending(new Error('socket closed'));
    });

    const connectId = randomUUID();
    this.pending.set(connectId, {
      resolve: (payload) => {
        this.connected = true;
        this.log('link', `Gateway 已连接 (v${payload?.server?.version || '?'})`);
        resolve(payload);
      },
      reject,
      timeout: setTimeout(() => reject(new Error('connect 认证超时')), 15000),
    });

    this._send({
      type: 'req', id: connectId, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'cli', version: 'mimo-claw-ui', platform: 'Win32', mode: 'cli' },
        role: 'operator',
        scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
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
        if (code !== 1000) this.log('info', `WS 关闭码: ${code}`);
        this.socket.end();
        this.connected = false;
      } else if (f.opcode === 0x09) {
        this.socket.write(Buffer.from([0x8a, 0x00]));
      }
    }
  }

  _rejectPending(err) {
    for (const [_id, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.pending.clear();
    if (this._chatReject) {
      this._chatReject(err);
      this._chatResolve = null;
      this._chatReject = null;
      this._chatMatcher = null;
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

  async chat(message, options = this.config.chatTimeout) {
    const normalized = typeof options === 'number'
      ? { timeoutMs: options, matchText: null }
      : { timeoutMs: options?.timeoutMs ?? this.config.chatTimeout, matchText: options?.matchText ?? null };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._chatResolve = null;
        this._chatReject = null;
        this._chatMatcher = null;
        reject(new Error('chat 超时'));
      }, normalized.timeoutMs);

      this._chatMatcher = normalized.matchText;
      this._chatResolve = (text) => { clearTimeout(timeout); resolve(text); };
      this._chatReject = (err) => { clearTimeout(timeout); reject(err); };

      this.request('chat.send', {
        sessionKey: 'main',
        message,
        deliver: false,
        idempotencyKey: randomUUID(),
      }, normalized.timeoutMs).catch(e => {
        clearTimeout(timeout);
        this._chatResolve = null;
        this._chatReject = null;
        this._chatMatcher = null;
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

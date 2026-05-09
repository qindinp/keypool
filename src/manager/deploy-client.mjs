import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { BASE } from '../shared/cookie.mjs';
import { extractTextContent, collectTextCandidates } from '../shared/ws.mjs';

const DEFAULT_REJECT_PATTERNS = [
  /拒绝执行此任务/i,
  /无法执行此操作/i,
  /违反安全策略.*拒绝/i,
  /高风险操作.*不允许/i,
  /我不能.*帮你.*执行/i,
  /unknown code/i,
  /policy.*denied/i,
  /not allowed.*execute/i,
  /permission denied/i,
];

export class DeployClient {
  constructor({ cookie, getTicket, config, log }) {
    this.cookie = cookie;
    this.getTicket = getTicket;
    this.config = config;
    this.log = log;
    this.socket = null;
    this.connected = false;
    this.pending = new Map();
    this._chatResolve = null;
    this._chatReject = null;
    this._chatMatcher = null;
    this._chatEventTexts = [];
    this._chatMatchedText = null;
    this._pingInterval = null;
    this._reconnecting = false;
    this._closed = false;
    this._onDisconnect = null;
  }

  async connect() {
    this._closed = false;
    const ticket = await this.getTicket(this.cookie);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://aistudio.xiaomimimo.com/ws/proxy?ticket=${encodeURIComponent(ticket)}`, {
        handshakeTimeout: this.config.wsConnectTimeout,
        headers: {
          Cookie: this.cookie,
          Origin: BASE,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(err);
      };

      ws.once('error', (err) => {
        if (!settled) fail(err);
      });

      ws.once('open', () => {
        this.socket = ws;
        this._setupHandlers(resolve, reject);
      });
    });
  }

  /**
   * 自动重连（指数退避）
   * @param {number} [maxRetries] - 最大重试次数
   * @returns {Promise<boolean>} 是否重连成功
   */
  async reconnect(maxRetries = 3) {
    if (this._closed || this._reconnecting) return false;
    this._reconnecting = true;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      this.log('info', `WebSocket 重连 (${attempt}/${maxRetries})，${delay}ms 后尝试...`);
      await new Promise(r => setTimeout(r, delay));

      if (this._closed) { this._reconnecting = false; return false; }

      try {
        // 清理旧连接状态
        this._clearPing();
        this._rejectPending(new Error('reconnecting'));
        this.connected = false;

        await this.connect();
        this._reconnecting = false;
        this.log('ok', 'WebSocket 重连成功');
        return true;
      } catch (e) {
        this.log('warn', `重连失败: ${e.message}`);
      }
    }

    this._reconnecting = false;
    this.log('error', 'WebSocket 重连耗尽所有重试');
    return false;
  }

  /**
   * 注册断开回调（供外部在连接丢失时触发恢复逻辑）
   */
  onDisconnect(fn) {
    this._onDisconnect = fn;
  }

  _startPing() {
    this._clearPing();
    this._pingInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.ping();
        } catch {}
      }
    }, 30_000);
  }

  _clearPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  _captureChatEventText(value) {
    if (!this._chatResolve) return;
    const eventTexts = collectTextCandidates(value);
    for (const text of eventTexts) {
      if (!this._chatEventTexts.includes(text)) this._chatEventTexts.push(text);
      if (this._chatMatcher && text.includes(this._chatMatcher)) {
        this._chatMatchedText = text;
      }
    }
  }

  _assertChatAccepted(text, rejectPatterns = DEFAULT_REJECT_PATTERNS) {
    const normalized = String(text || '').trim();
    if (!normalized) return normalized;
    // 如果包含成功标记，直接通过（成功优先于拒绝检测）
    if (this._chatMatcher && normalized.includes(this._chatMatcher)) {
      return normalized;
    }
    const matched = rejectPatterns.find((pattern) => pattern.test(normalized));
    if (matched) {
      throw new Error(`远端拒绝执行部署步骤: ${normalized.slice(0, 300)}`);
    }
    return normalized;
  }

  _setupHandlers(resolve, reject) {
    const onFrame = (msg) => {
      if (msg.event === 'connect.challenge') return;

      if (msg.type === 'event' && this._chatResolve) {
        this._captureChatEventText(msg.payload);
      }

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
          const matchedFromEvents = this._chatMatchedText;
          const eventTextFallback = this._chatEventTexts.filter(Boolean).join('\n').trim();
          this._chatResolve = null;
          this._chatReject = null;
          this._chatMatcher = null;
          this._chatEventTexts = [];
          this._chatMatchedText = null;

          if (matchedFromEvents) {
            resolveChat(matchedFromEvents);
            return;
          }

          const sk = p.sessionKey || 'main';
          this.requestWithReconnect('chat.history', { sessionKey: sk, limit: 10 }, 30000)
            .then(hist => {
              try {
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
                resolveChat(matching.at(-1) || eventTextFallback || fallbackAssistant.at(-1) || fallbackAny.at(-1) || '');
              } catch (parseErr) {
                this.log?.('warn', `chat.history 解析失败: ${parseErr.message}`);
                resolveChat(eventTextFallback || '');
              }
            })
            .catch(() => resolveChat(eventTextFallback || ''));
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

    this.socket.on('message', (data) => {
      try {
        const text = typeof data === 'string' ? data : data.toString();
        onFrame(JSON.parse(text));
      } catch {}
    });

    this.socket.on('error', (e) => {
      this.log('error', 'Socket 错误:', e.message);
      this.connected = false;
      this._clearPing();
      this._rejectPending(new Error('socket disconnected'));
    });

    this.socket.on('close', (_code, _reason) => {
      const code = typeof _code === 'number' ? _code : 0;
      if (code && code !== 1000) this.log('info', `WS 关闭码: ${code}`);
      this.connected = false;
      this._clearPing();
      this._rejectPending(new Error('socket closed'));
      if (!this._closed && this._onDisconnect) {
        this._onDisconnect();
      }
    });

    this.socket.on('ping', () => {
      try { this.socket.pong(); } catch {}
    });

    const connectId = randomUUID();
    this.pending.set(connectId, {
      resolve: (payload) => {
        this.connected = true;
        this._startPing();
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
      this._chatEventTexts = [];
      this._chatMatchedText = null;
    }
  }

  _send(msg) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
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

  /**
   * 带自动重连的 request
   */
  async requestWithReconnect(method, params, timeoutMs = 30000) {
    try {
      return await this.request(method, params, timeoutMs);
    } catch (e) {
      if ((e.message.includes('socket') || e.message.includes('not connected')) && !this._closed) {
        const reconnected = await this.reconnect();
        if (reconnected) {
          return this.request(method, params, timeoutMs);
        }
      }
      throw e;
    }
  }

  async readChatHistory(sessionKey, { limit = 10, timeoutMs = 30000, matchText = null } = {}) {
    const hist = await this.requestWithReconnect('chat.history', { sessionKey, limit }, timeoutMs);
    const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
    const texts = msgs.map(msg => ({
      role: String(msg?.role || '').toLowerCase(),
      text: extractTextContent(msg?.content).trim(),
    })).filter(item => item.text);

    const assistantTexts = texts.filter(item => item.role === 'assistant').map(item => item.text);
    const allTexts = texts.map(item => item.text);
    const matchedText = matchText
      ? assistantTexts.findLast?.((text) => text.includes(matchText)) || [...assistantTexts].reverse().find((text) => text.includes(matchText)) || null
      : assistantTexts.at(-1) || allTexts.at(-1) || null;

    return {
      sessionKey,
      messages: msgs,
      texts,
      assistantTexts,
      matchedText,
      lastAssistantText: assistantTexts.at(-1) || '',
      lastText: allTexts.at(-1) || '',
    };
  }

  async _chatWithSession(sessionKey, message, options) {
    const timeoutMs = typeof options === 'number' ? options : options?.timeoutMs;
    const matchText = typeof options === 'object' ? options?.matchText ?? null : null;
    const requireMatch = typeof options === 'object' ? options?.requireMatch !== false : false;
    const rejectPatterns = typeof options === 'object' ? options?.rejectPatterns ?? DEFAULT_REJECT_PATTERNS : DEFAULT_REJECT_PATTERNS;
    const retryOnReconnect = typeof options === 'object' ? options?.retryOnReconnect !== false : true;
    const effectiveSessionKey = typeof options === 'object' && options?.sessionKey ? options.sessionKey : sessionKey;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._chatResolve = null;
        this._chatReject = null;
        this._chatMatcher = null;
        this._chatEventTexts = [];
        this._chatMatchedText = null;
        reject(new Error('chat 超时'));
      }, timeoutMs);

      this._chatResolve = (text) => {
        clearTimeout(timeout);
        try {
          const accepted = this._assertChatAccepted(text, rejectPatterns);
          if (requireMatch && matchText && !accepted.includes(matchText)) {
            const printable = accepted ? accepted.slice(0, 1000) : '<empty-response>';
            reject(new Error(`部署步骤未命中成功标记 ${matchText}: ${printable}`));
            return;
          }
          resolve(accepted);
        } catch (err) {
          reject(err);
        }
      };
      this._chatReject = (err) => { clearTimeout(timeout); reject(err); };

      this.requestWithReconnect('chat.send', {
        sessionKey: effectiveSessionKey,
        message,
        deliver: true,
        idempotencyKey: randomUUID(),
      }, timeoutMs).catch(e => {
        clearTimeout(timeout);
        this._chatResolve = null;
        this._chatReject = null;
        this._chatMatcher = null;
        this._chatEventTexts = [];
        this._chatMatchedText = null;
        reject(e);
      });
    });
  }

  async chat(message, options = this.config.chatTimeout) {
    const normalized = typeof options === 'number'
      ? { timeoutMs: options, matchText: null, requireMatch: false, rejectPatterns: DEFAULT_REJECT_PATTERNS, sessionKey: null, retryOnReconnect: true, useHistoryFallback: true, historyLimit: 10 }
      : {
          timeoutMs: options?.timeoutMs ?? this.config.chatTimeout,
          matchText: options?.matchText ?? null,
          requireMatch: options?.requireMatch ?? false,
          rejectPatterns: options?.rejectPatterns ?? DEFAULT_REJECT_PATTERNS,
          sessionKey: options?.sessionKey ?? null,
          retryOnReconnect: options?.retryOnReconnect ?? true,
          useHistoryFallback: options?.useHistoryFallback ?? true,
          historyLimit: options?.historyLimit ?? 10,
        };

    let lastSessionKey = normalized.sessionKey || 'main';

    const runChat = async () => {
      this._chatMatcher = normalized.matchText;
      this._chatEventTexts = [];
      this._chatMatchedText = null;

      try {
        if (normalized.sessionKey) {
          lastSessionKey = normalized.sessionKey;
          return {
            text: await this._chatWithSession(normalized.sessionKey, message, normalized),
            confirmationSource: 'live',
            sessionKey: lastSessionKey,
          };
        }
        lastSessionKey = 'main';
        return {
          text: await this._chatWithSession('main', message, normalized),
          confirmationSource: 'live',
          sessionKey: lastSessionKey,
        };
      } catch (e) {
        const msg = e.message || '';
        if (!normalized.sessionKey && (msg.includes('必要信息') || msg.includes('missing'))) {
          this.log('warn', `主会话 'main' 不可用 (${msg.slice(0, 80)})，回退到独立 deploy 会话`);
          lastSessionKey = `deploy-${Date.now().toString(36)}`;
          return {
            text: await this._chatWithSession(lastSessionKey, message, normalized),
            confirmationSource: 'live',
            sessionKey: lastSessionKey,
          };
        }
        throw e;
      }
    };

    const tryHistoryFallback = async (reason) => {
      if (!normalized.useHistoryFallback || !lastSessionKey) return null;
      this.log('warn', `chat 实时确认失败，尝试读取会话历史兜底: ${reason}`);
      const history = await this.readChatHistory(lastSessionKey, {
        limit: normalized.historyLimit,
        timeoutMs: Math.min(normalized.timeoutMs, 30_000),
        matchText: normalized.matchText,
      });
      const text = history.matchedText || history.lastAssistantText || history.lastText || '';
      if (!text) return null;
      const accepted = this._assertChatAccepted(text, normalized.rejectPatterns);
      if (normalized.requireMatch && normalized.matchText && !accepted.includes(normalized.matchText)) {
        return null;
      }
      return {
        text: accepted,
        confirmationSource: 'history',
        sessionKey: lastSessionKey,
      };
    };

    try {
      return await runChat();
    } catch (e) {
      const msg = e.message || '';
      const canRetryLive = normalized.retryOnReconnect && !this._closed && (msg.includes('socket closed') || msg.includes('socket disconnected') || msg.includes('not connected') || msg.includes('reconnecting'));
      if (canRetryLive) {
        this.log('warn', `chat 期间连接断开，尝试自动重连并重发当前消息: ${msg}`);
        const reconnected = await this.reconnect();
        if (reconnected) {
          try {
            return await runChat();
          } catch (retryErr) {
            const fallback = await tryHistoryFallback(retryErr.message || msg).catch(() => null);
            if (fallback) return fallback;
            throw retryErr;
          }
        }
      }

      const shouldTryHistory = normalized.useHistoryFallback && (
        msg.includes('chat 超时') ||
        msg.includes('socket closed') ||
        msg.includes('socket disconnected') ||
        msg.includes('not connected') ||
        msg.includes('reconnecting') ||
        msg.includes('部署步骤未命中成功标记')
      );
      if (shouldTryHistory) {
        const fallback = await tryHistoryFallback(msg).catch(() => null);
        if (fallback) return fallback;
      }
      throw e;
    }
  }


  close() {
    this._closed = true;
    this._clearPing();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try { this.socket.close(); } catch {}
    }
    this.connected = false;
  }
}

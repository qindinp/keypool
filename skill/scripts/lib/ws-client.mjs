/**
 * WebSocket Client — 连接管理 + 重连 + chunk 消息处理
 *
 * 反连到 Gateway，接收 proxy_request，转发到 ApiHandler，
 * 流式响应通过 proxy_response_chunk / proxy_response_end 逐 chunk 返回。
 */

const INITIAL_DELAY = 1_000;
const MAX_DELAY = 30_000;
const BACKOFF_FACTOR = 2;
const JITTER = 0.2;
const MAX_ATTEMPTS = 50;
const PING_INTERVAL = 25_000;
const PONG_TIMEOUT = 35_000;
const REQUEST_TIMEOUT = 120_000;
const MAX_PENDING = 100;

export class WsClient {
  constructor({ WebSocket, gatewayWsUrl, accountId, runId, apiHandler, stats }) {
    this.WebSocket = WebSocket;
    this.gatewayWsUrl = gatewayWsUrl;
    this.accountId = accountId;
    this.runId = runId;
    this.apiHandler = apiHandler;
    this.stats = stats;

    this._ws = null;
    this._status = 'connecting';  // connecting | connected | disconnected | exhausted
    this._attempt = 0;
    this._lastPongAt = Date.now();
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._closed = false;

    // Map<string, { resolve, reject, timeout, chunks?, status?, headers? }>
    this._pending = new Map();
  }

  get status() { return this._status; }
  get reconnectAttempt() { return this._attempt; }

  connect() {
    if (this._closed) return;

    const url = `${this.gatewayWsUrl}?accountId=${encodeURIComponent(this.accountId)}&runId=${encodeURIComponent(this.runId)}`;
    this._status = 'connecting';

    try {
      this._ws = new this.WebSocket(url, {
        headers: { 'User-Agent': 'KeyPool-Tunnel-Proxy/0.3.0' },
      });
    } catch (err) {
      console.error('[ws-client] connect error:', err.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      console.log('[ws-client] 已连接到 Gateway');
      this._status = 'connected';
      this._attempt = 0;
      this._lastPongAt = Date.now();

      // 注册
      this._send({
        type: 'register',
        accountId: this.accountId,
        runId: this.runId,
      });

      // 启动心跳
      this._startPing();
    });

    this._ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this._handleMessage(msg);
    });

    this._ws.on('close', (code, reason) => {
      const reasonText = reason?.toString?.() || '';
      console.log('[ws-client] 连接关闭:', code, reasonText);
      if (reasonText.includes('replaced by newer tunnel') || reasonText.includes('superseded tunnel run')) {
        console.warn('[ws-client] 当前 run 已被新 tunnel 替换，停止自动重连');
        this._closed = true;
        this._stopPing();
        this._status = 'disconnected';
        this._rejectAllPending(reasonText || 'tunnel run superseded');
        return;
      }
      this._onDisconnect();
    });

    this._ws.on('error', (err) => {
      console.error('[ws-client] WS 错误:', err.message);
    });
  }

  close() {
    this._closed = true;
    this._stopPing();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._rejectAllPending('connection closed');
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }
    this._status = 'disconnected';
  }

  // ─── 消息处理 ──────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'ping':
        this._send({ type: 'pong' });
        break;

      case 'pong':
        this._lastPongAt = Date.now();
        break;

      case 'registered':
        console.log('[ws-client] 注册成功, accountId:', msg.accountId);
        break;

      case 'proxy_request':
        this._handleRequest(msg);
        break;

      default:
        break;
    }
  }

  async _handleRequest(msg) {
    const { id, method, path, headers, body } = msg;

    // 更新 stats
    if (this.stats) {
      this.stats.requestCount++;
      this.stats.lastRequestAt = new Date().toISOString();
    }

    // 背压检查
    if (this._pending.size >= MAX_PENDING) {
      this._send({
        type: 'proxy_error',
        id,
        error: 'tunnel proxy busy, pending queue full',
      });
      return;
    }

    // 初始化 pending entry
    let timedOut = false;
    const entry = {
      resolve: null,
      reject: null,
      timeout: null,
      chunks: [],
      status: null,
      headers: null,
    };

    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timeout = setTimeout(() => {
        timedOut = true;
        this._pending.delete(id);
        reject(new Error('request timeout'));
      }, REQUEST_TIMEOUT);
    });

    this._pending.set(id, entry);

    try {
      // 调用 API handler，传入流式回调
      const result = await this.apiHandler.handleRequest(
        { method, path, headers, body },
        {
          onChunk: (chunkId, status, respHeaders, buf) => {
            if (timedOut || !this._pending.has(id)) return; // 超时后不再发送
            const chunkMsg = {
              type: 'proxy_response_chunk',
              id,
              chunkId,
              chunk: buf.toString('base64'),
            };
            if (chunkId === 0) {
              chunkMsg.status = status;
              chunkMsg.headers = respHeaders;
            }
            this._send(chunkMsg);
          },
          onEnd: (totalChunks) => {
            if (timedOut || !this._pending.has(id)) return;
            this._send({
              type: 'proxy_response_end',
              id,
              totalChunks,
            });
          },
        },
      );

      // 非流式返回（result 不为 null）
      if (result !== null && !timedOut) {
        this._send({
          type: 'proxy_response',
          id,
          status: result.status,
          headers: result.headers,
          body: result.body,
        });
      }
    } catch (err) {
      // 更新 stats 错误信息
      if (this.stats) {
        this.stats.lastError = err.message;
        this.stats.lastErrorAt = new Date().toISOString();
        this.stats.consecutiveErrors++;
      }
      if (!timedOut) {
        this._send({
          type: 'proxy_error',
          id,
          error: err.message,
        });
      }
    } finally {
      // 清理 pending
      const e = this._pending.get(id);
      if (e) {
        clearTimeout(e.timeout);
        this._pending.delete(id);
      }
      // 成功时重置连续错误计数
      if (!timedOut && this.stats && this.stats.consecutiveErrors > 0) {
        this.stats.consecutiveErrors = 0;
      }
    }
  }

  // ─── 发送 ──────────────────────────────────────────────

  _send(obj) {
    if (this._ws?.readyState === this.WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(obj));
      } catch (err) {
        console.error('[ws-client] send error:', err.message);
      }
    }
  }

  // ─── 心跳 ──────────────────────────────────────────────

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._status !== 'connected') return;

      // pong 超时检测
      if (Date.now() - this._lastPongAt > PONG_TIMEOUT) {
        console.warn('[ws-client] pong 超时，触发重连');
        this._ws?.terminate?.();
        this._onDisconnect();
        return;
      }

      this._send({ type: 'ping' });
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ─── 断连处理 ──────────────────────────────────────────

  _onDisconnect() {
    this._stopPing();
    this._status = 'disconnected';
    this._rejectAllPending('connection lost');
    if (!this._closed) {
      this._scheduleReconnect();
    }
  }

  _rejectAllPending(reason) {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(reason));
    }
    this._pending.clear();
  }

  // ─── 重连 ──────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._closed || this._attempt >= MAX_ATTEMPTS) {
      if (this._attempt >= MAX_ATTEMPTS) {
        this._status = 'exhausted';
        console.error(`[ws-client] 重连 ${MAX_ATTEMPTS} 次耗尽，停止重试`);
      }
      return;
    }

    const delay = Math.min(INITIAL_DELAY * Math.pow(BACKOFF_FACTOR, this._attempt), MAX_DELAY);
    const jitter = delay * (1 + (Math.random() * 2 - 1) * JITTER);
    const actual = Math.max(jitter, 500);

    this._attempt++;
    console.log(`[ws-client] ${Math.round(actual)}ms 后重连 (attempt ${this._attempt}/${MAX_ATTEMPTS})...`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, actual);
  }
}

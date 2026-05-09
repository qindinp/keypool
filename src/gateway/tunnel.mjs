/**
 * Tunnel Server — 接收远端 Proxy 的 WebSocket 反连
 *
 * 远端沙箱实例通过 WS 连回本地 Gateway，建立双向通道。
 * Gateway 通过同一条 WS 推送 API 请求，远端执行后返回结果。
 *
 * 协议：
 *   远端 → Gateway:  { type: 'register', accountId: '...' }
 *   Gateway → 远端:  { type: 'proxy_request', id, method, path, headers, body }
 *   远端 → Gateway:  { type: 'proxy_response', id, status, headers, body }
 *   远端 → Gateway:  { type: 'proxy_error', id, error }
 *   双向:            { type: 'ping' } / { type: 'pong' }
 */

import { WebSocketServer } from 'ws';

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;

/**
 * 创建 Tunnel WebSocket 服务
 * @param {import('./registry.mjs').Registry} registry
 * @returns {{ wss: WebSocketServer, handleUpgrade: Function }}
 */
export function createTunnelServer(registry) {
  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const accountId = url.searchParams.get('accountId') || 'unknown';
    const runId = url.searchParams.get('runId') || '';

    console.log(`🔗 [tunnel] 远端连接 accountId=${accountId} runId=${runId}`);

    let authenticated = false;
    let lastPong = Date.now();

    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
        console.warn(`⚠️ [tunnel:${accountId}] 心跳超时，断开`);
        ws.terminate();
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }, HEARTBEAT_INTERVAL);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // 注册
      if (msg.type === 'register' && msg.accountId) {
        authenticated = true;
        registry.updateInstanceState(msg.accountId, {
          tunnel: ws,
          tunnelAccountId: msg.accountId,
          tunnelRunId: runId,
          tunnelConnectedAt: new Date().toISOString(),
          verified: true,
          healthOk: true,
          status: 'ACTIVE',
          lastVerifiedAt: new Date().toISOString(),
        });
        console.log(`✅ [tunnel:${msg.accountId}] 已注册，实例状态 → ACTIVE`);
        ws.send(JSON.stringify({ type: 'registered', accountId: msg.accountId }));
        return;
      }

      // 响应
      if (msg.type === 'proxy_response' || msg.type === 'proxy_error') {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          pendingRequests.delete(msg.id);
          clearTimeout(pending.timeout);
          if (msg.type === 'proxy_response') {
            pending.resolve(msg);
          } else {
            pending.reject(new Error(msg.error || 'proxy error'));
          }
        }
        return;
      }

      // pong
      if (msg.type === 'pong') {
        lastPong = Date.now();
        return;
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      // 清理 registry 中的 tunnel 引用
      const state = registry.getInstanceState(accountId);
      if (state?.tunnel === ws) {
        registry.updateInstanceState(accountId, {
          tunnel: null,
          healthOk: false,
        });
        console.log(`🔌 [tunnel:${accountId}] 连接断开`);
      }
    });

    ws.on('error', (err) => {
      console.error(`❌ [tunnel:${accountId}] 错误: ${err.message}`);
    });

    // 未认证超时
    setTimeout(() => {
      if (!authenticated && ws.readyState === ws.OPEN) {
        console.warn(`⚠️ [tunnel:${accountId}] 认证超时，断开`);
        ws.close();
      }
    }, 15_000);
  });

  // ─── 请求推送 ────────────────────────────────────────────

  /** @type {Map<string, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }>} */
  const pendingRequests = new Map();

  /**
   * 通过 tunnel 发送代理请求
   * @param {WebSocket} ws - tunnel 连接
   * @param {object} req - { method, path, headers, body }
   * @param {number} timeoutMs
   * @returns {Promise<{ status: number, headers: object, body: string }>}
   */
  function sendProxyRequest(ws, req, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('tunnel proxy timeout'));
      }, timeoutMs);

      pendingRequests.set(id, { resolve, reject, timeout });

      ws.send(JSON.stringify({
        type: 'proxy_request',
        id,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body || null,
      }));
    });
  }

  return { wss, handleUpgrade, sendProxyRequest };
}

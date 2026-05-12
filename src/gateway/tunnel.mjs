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
 *   远端 → Gateway:  { type: 'proxy_response_chunk', id, chunkId, status?, headers?, chunk }
 *   远端 → Gateway:  { type: 'proxy_response_end', id, totalChunks }
 *   远端 → Gateway:  { type: 'proxy_error', id, error }
 *   双向:            { type: 'ping' } / { type: 'pong' }
 */

import { WebSocketServer } from 'ws';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..', '..', 'skill');

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;

/**
 * 递归读取 skill 目录中的所有文件
 * @returns {Array<{path: string, content: string}>}
 */
function readSkillFiles() {
  const files = [];
  function walk(dir, base) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
        files.push({
          path: relative(base, full),
          content: readFileSync(full, 'utf-8'),
        });
      }
    }
  }
  walk(SKILL_ROOT, SKILL_ROOT);
  return files;
}

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
    const isBootstrap = url.searchParams.get('bootstrap') === '1';
    const accountId = url.searchParams.get('accountId') || 'unknown';
    const runId = url.searchParams.get('runId') || '';

    // ─── Bootstrap 模式：推送 skill 文件 ──────────────────
    if (isBootstrap) {
      console.log(`🚀 [bootstrap] 远端请求 bootstrap accountId=${accountId}`);
      try {
        const files = readSkillFiles();
        for (const f of files) {
          ws.send(JSON.stringify({ type: 'file', path: f.path, content: f.content }));
        }
        ws.send(JSON.stringify({ type: 'done', totalFiles: files.length }));
        console.log(`✅ [bootstrap] 推送 ${files.length} 个文件完成`);
      } catch (err) {
        console.error(`❌ [bootstrap] 推送失败: ${err.message}`);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      ws.close();
      return;
    }

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
      // 任何有效消息都证明连接仍然活着，避免长请求期间只因 pong 抖动误杀 tunnel。
      lastPong = Date.now();

      // 注册
      if (msg.type === 'register' && msg.accountId) {
        authenticated = true;
        const previousState = registry.getInstanceState(msg.accountId);
        const previousTunnel = previousState?.tunnel;
        if (previousTunnel && previousTunnel !== ws) {
          try { previousTunnel.close(1000, 'replaced by newer tunnel'); } catch {}
        }
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

      // 响应（非流式完整响应 + 错误）
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

      // 流式 chunk 响应
      if (msg.type === 'proxy_response_chunk') {
        const entry = pendingRequests.get(msg.id);
        if (!entry) return; // 已超时或重连清理

        if (msg.chunkId === 0) {
          // 首 chunk：含 status + headers，开始 HTTP 响应
          entry.status = msg.status;
          entry.headers = msg.headers;
          entry.chunks = [];
          if (entry.res && !entry.res.headersSent) {
            entry.res.writeHead(msg.status, {
              'content-type': msg.headers?.['content-type'] || 'text/event-stream',
              'cache-control': 'no-cache',
              'transfer-encoding': 'chunked',
            });
          }
        }
        // 解码 base64 chunk 并写入 HTTP response
        const buf = Buffer.from(msg.chunk, 'base64');
        if (entry.chunks) entry.chunks.push(buf);
        if (entry.res && !entry.res.writableEnded) {
          try { entry.res.write(buf); } catch {}
        }
        return;
      }

      // 流式响应结束
      if (msg.type === 'proxy_response_end') {
        const entry = pendingRequests.get(msg.id);
        if (!entry) return;
        pendingRequests.delete(msg.id);
        clearTimeout(entry.timeout);
        if (entry.res && !entry.res.writableEnded) {
          entry.res.end();
        }
        // 拼接 body 供非 chunk 场景使用
        const body = entry.chunks ? Buffer.concat(entry.chunks).toString('utf-8') : '';
        entry.resolve({
          status: entry.status || 200,
          headers: entry.headers || {},
          body,
        });
        // 标记代理成功
        registry.markProxySuccess(accountId, 0);
        return;
      }

      // ping（远端客户端也会主动保活；必须回复 pong，否则复杂请求耗时较长时客户端会误判超时并断开）
      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
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
      // 清理当前连接上的 pending requests（含 chunk 流）。
      // 注意：pendingRequests 是整个 tunnel server 共享的；同一账号重连或旧连接关闭时，
      // 不能清掉其他仍然存活连接上的请求，否则复杂请求会被无关 close 打断为
      // `tunnel connection closed`。
      for (const [id, entry] of pendingRequests) {
        if (entry.ws !== ws) continue;
        clearTimeout(entry.timeout);
        if (entry.res && !entry.res.writableEnded) {
          try { entry.res.end(); } catch {}
        }
        entry.reject(new Error('tunnel connection closed'));
        pendingRequests.delete(id);
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

  /** @type {Map<string, { ws: WebSocket, resolve: Function, reject: Function, timeout: NodeJS.Timeout, res?: object, chunks?: Buffer[], status?: number, headers?: object }>} */
  const pendingRequests = new Map();

  /**
   * 通过 tunnel 发送代理请求
   * @param {WebSocket} ws - tunnel 连接
   * @param {object} req - { method, path, headers, body }
   * @param {object} opts - { timeoutMs, res } res 为 HTTP response 对象时启用流式透传
   * @returns {Promise<{ status: number, headers: object, body: string }>}
   */
  function sendProxyRequest(ws, req, opts = {}) {
    const timeoutMs = opts.timeoutMs || 120_000;
    const res = opts.res || null;

    return new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        if (res && !res.writableEnded) {
          try { res.end(); } catch {}
        }
        reject(new Error('tunnel proxy timeout'));
      }, timeoutMs);

      const entry = { ws, resolve, reject, timeout, res, chunks: [], status: null, headers: null };
      pendingRequests.set(id, entry);

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

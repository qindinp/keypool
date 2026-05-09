#!/usr/bin/env node
/**
 * KeyPool Bootstrap — 极简部署入口
 *
 * 通过内置 WebSocket 从 Gateway 拉取完整 skill 代码并启动。
 * 总大小 < 1KB，永远不触发 WS 帧限制。
 *
 * 由 deployer 通过 chat.send 发送（模板变量在运行时替换）
 */

const { writeFileSync, mkdirSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { execSync } = await import('node:child_process');

const SKILL_DIR = '/root/.openclaw/skills/keypool-tunnel';
const GATEWAY_WS = '__KEYPOOL_GATEWAY_URL__';  // e.g. ws://1.2.3.4:9300/tunnel
const ACCOUNT_ID = '__KEYPOOL_ACCOUNT_ID__';
const RUN_ID = '__KEYPOOL_RUN_ID__';

console.log(`[bootstrap] connecting to ${GATEWAY_WS}...`);

const ws = new globalThis.WebSocket(
  `${GATEWAY_WS}?bootstrap=1&accountId=${encodeURIComponent(ACCOUNT_ID)}&runId=${encodeURIComponent(RUN_ID)}`
);

const files = [];
let done = false;

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'file') {
    files.push(msg);
    console.log(`[bootstrap] received ${msg.path} (${msg.content.length} bytes)`);
    return;
  }

  if (msg.type === 'done') {
    done = true;
    console.log(`[bootstrap] all ${files.length} files received, writing to disk...`);

    // 写入文件
    for (const f of files) {
      const target = join(SKILL_DIR, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf-8');
    }

    // 验证
    try {
      execSync(`node --check "${join(SKILL_DIR, 'scripts', 'tunnel-proxy.mjs')}"`, { encoding: 'utf-8' });
      console.log('[bootstrap] syntax check passed');
    } catch (e) {
      console.error('[bootstrap] syntax check failed:', e.stderr || e.message);
      ws.close();
      process.exit(1);
    }

    // 杀旧进程，启动新进程
    try { execSync('pkill -f "tunnel-proxy.mjs" 2>/dev/null', { encoding: 'utf-8' }); } catch {}
    execSync(`nohup node "${join(SKILL_DIR, 'scripts', 'tunnel-proxy.mjs')}" > /tmp/tunnel-proxy.log 2>&1 &`, {
      encoding: 'utf-8',
      shell: '/bin/bash',
    });

    console.log('[bootstrap] tunnel-proxy started');
    ws.close();
    process.exit(0);
  }

  if (msg.type === 'error') {
    console.error('[bootstrap] gateway error:', msg.message);
    ws.close();
    process.exit(1);
  }
};

ws.onerror = (e) => {
  console.error('[bootstrap] ws error:', e.message || e.type);
  process.exit(1);
};

ws.onclose = () => {
  if (!done) {
    console.error('[bootstrap] connection closed before completion');
    process.exit(1);
  }
};

// 超时保护
setTimeout(() => {
  if (!done) {
    console.error('[bootstrap] timeout (30s)');
    ws.close();
    process.exit(1);
  }
}, 30_000);

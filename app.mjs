#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const relayPort = process.env.RELAY_PORT || '9300';
const relayHost = process.env.RELAY_HOST || '127.0.0.1';
const adminUrl = `http://${relayHost}:${relayPort}/admin`;

function startChild(name, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    process.stdout.write(`\n[${name}] 已退出 (${reason})\n`);
  });

  return child;
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
    }
    await sleep(300);
  }
  return false;
}

async function main() {
  console.log('🚀 正在启动 KeyPool 用户入口...');
  console.log('   - 后台服务 1/2: manager');
  const manager = startChild('manager', ['manager.mjs']);

  await sleep(800);

  console.log('   - 后台服务 2/2: relay');
  const relay = startChild('relay', ['relay/server.mjs'], {
    RELAY_PORT: String(relayPort),
    RELAY_HOST: relayHost,
  });

  const children = [manager, relay];
  let shuttingDown = false;

  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 收到 ${sig}，正在停止 KeyPool...`);
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 800);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const ready = await waitForHealth(`http://${relayHost}:${relayPort}/health`);
  if (ready) {
    console.log('\n✅ KeyPool 已启动');
    console.log(`🌐 管理界面: ${adminUrl}`);
    console.log(`🔌 接入地址: http://${relayHost}:${relayPort}/v1`);
    console.log('ℹ️  关闭窗口或按 Ctrl+C 可停止全部服务');
  } else {
    console.log('\n⚠️ relay 启动超时，但进程可能仍在初始化');
    console.log(`🌐 你仍可稍后手动打开: ${adminUrl}`);
  }

  await Promise.race(children.map(child => new Promise(resolve => child.on('exit', resolve))));
  shutdown('child-exit');
}

main().catch((error) => {
  console.error('❌ app 启动失败:', error.message);
  process.exit(1);
});

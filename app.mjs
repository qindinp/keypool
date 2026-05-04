#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const relayPort = process.env.RELAY_PORT || '9300';
const relayHost = process.env.RELAY_HOST || '127.0.0.1';
const adminUrl = `http://${relayHost}:${relayPort}/admin`;
const RESTART_DELAY_MS = 1500;
const relayHealthUrl = `http://${relayHost}:${relayPort}/health`;

function startChild(name, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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

function createManagedChild(name, args, extraEnv = {}) {
  return {
    name,
    args,
    extraEnv,
    child: null,
    restartCount: 0,
  };
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
  const managerChild = createManagedChild('manager', ['manager.mjs']);
  const relayChild = createManagedChild('relay', ['relay/server.mjs'], {
    RELAY_PORT: String(relayPort),
    RELAY_HOST: relayHost,
  });
  const managedChildren = [managerChild];
  let shuttingDown = false;

  const launchChild = (managed) => {
    if (shuttingDown) return;
    const child = startChild(managed.name, managed.args, managed.extraEnv);
    managed.child = child;

    child.once('exit', async () => {
      managed.child = null;
      if (shuttingDown) return;
      managed.restartCount += 1;
      process.stdout.write(`[${managed.name}] 将在 ${RESTART_DELAY_MS}ms 后自动重启（第 ${managed.restartCount} 次）\n`);
      await sleep(RESTART_DELAY_MS);
      if (!shuttingDown) launchChild(managed);
    });
  };

  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 收到 ${sig}，正在停止 KeyPool...`);
    for (const managed of managedChildren) {
      const child = managed.child;
      if (child && !child.killed) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }
    setTimeout(() => process.exit(0), 800);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('🚀 正在启动 KeyPool 用户入口...');
  console.log('   - 后台服务 1/2: manager');
  launchChild(managerChild);

  await sleep(800);

  const reuseExistingRelay = await waitForHealth(relayHealthUrl, 1200);
  if (reuseExistingRelay) {
    console.log('   - 后台服务 2/2: relay（复用当前 9300 服务）');
  } else {
    console.log('   - 后台服务 2/2: relay');
    managedChildren.push(relayChild);
    launchChild(relayChild);
  }

  const ready = await waitForHealth(relayHealthUrl);
  if (ready) {
    console.log('\n✅ KeyPool 已启动');
    console.log(`🌐 管理界面: ${adminUrl}`);
    console.log(`🔌 接入地址: http://${relayHost}:${relayPort}/v1`);
    console.log(reuseExistingRelay
      ? 'ℹ️  已复用现有 relay；关闭当前 admin 所在 relay 会影响访问。'
      : 'ℹ️  关闭窗口或按 Ctrl+C 可停止全部服务');
  } else {
    console.log('\n⚠️ relay 启动超时，但进程可能仍在初始化');
    console.log(`🌐 你仍可稍后手动打开: ${adminUrl}`);
  }

  await new Promise(() => {});
}

main().catch((error) => {
  console.error('❌ app 启动失败:', error.message);
  process.exit(1);
});

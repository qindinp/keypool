#!/usr/bin/env node
/**
 * KeyPool Manager (Phase 2 skeleton)
 *
 * 多账号入口：
 * - 从 accounts.json 读取多个小米账号
 * - 每个账号独立 logger / stateStore / worker
 * - 支持 --status / --deploy / --once / 持续运行
 *
 * 说明：
 * - 本阶段只完成控制平面骨架
 * - 仍未包含 relay / registry / 路由转发
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './controller/config.mjs';
import { createStateStore } from './controller/state-store.mjs';
import { createMimoApi } from './controller/mimo-api.mjs';
import { createLogger } from './controller/logger.mjs';
import { createAccountWorker } from './controller/account-worker.mjs';
import { sleep } from './controller/utils.mjs';
import { loadAccounts, getAccountsPath } from './controller/accounts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, '.manager');

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function buildAccountRuntime(account, config) {
  const accountId = safeId(account.id);
  const logPath = resolve(LOG_DIR, `${accountId}.log`);
  const statePath = resolve(LOG_DIR, `${accountId}.state.json`);
  const baseLogger = createLogger(logPath);
  const prefixedLog = (level, ...args) => baseLogger.log(level, `[${account.name}]`, ...args);
  const stateStore = createStateStore(statePath);
  const api = createMimoApi({ sleep });
  const worker = createAccountWorker({
    cookie: account.cookie,
    config,
    api,
    stateStore,
    log: prefixedLog,
  });

  return {
    account,
    log: prefixedLog,
    stateStore,
    api,
    worker,
    statePath,
    logPath,
    auth: null,
  };
}

async function validateRuntime(rt) {
  const auth = await rt.api.validateCookie(rt.account.cookie);
  rt.auth = auth;
  if (!auth.valid) {
    rt.log('error', `Cookie 无效: ${auth.reason}`);
    return false;
  }
  rt.log('ok', `Cookie 有效 — 用户: ${auth.userName} (${auth.userId})`);
  return true;
}

async function cmdStatus(runtimes) {
  for (const rt of runtimes) {
    console.log(`\n================ ${rt.account.name} ================`);
    await rt.worker.cmdStatus();
  }
}

async function cmdDeploy(runtimes) {
  for (const rt of runtimes) {
    rt.log('deploy', '强制重新部署...');
    await rt.worker.renewFlow('manual-deploy');
  }
}

async function runOnceOrLoop(runtimes, once) {
  await Promise.all(runtimes.map(rt => rt.worker.runLoop({ once })));
}

async function main() {
  const config = createConfig();
  const args = process.argv.slice(2);
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    console.error(`❌ 未找到可用账号。请检查 ${getAccountsPath()}`);
    process.exit(1);
  }

  const runtimes = accounts
    .sort((a, b) => a.priority - b.priority)
    .map(account => buildAccountRuntime(account, config));

  const validated = [];
  for (const rt of runtimes) {
    const ok = await validateRuntime(rt);
    validated.push({ rt, ok });
  }

  const healthyRuntimes = validated.filter(item => item.ok).map(item => item.rt);
  const validCount = healthyRuntimes.length;

  if (validCount === 0) {
    console.error('❌ 所有账号 Cookie 校验失败，退出');
    process.exit(1);
  }

  if (args.includes('--status')) return cmdStatus(healthyRuntimes);
  if (args.includes('--deploy')) return cmdDeploy(healthyRuntimes);

  const once = args.includes('--once');

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const rt of healthyRuntimes) {
      rt.log('info', `收到 ${sig}，正在关闭...`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`✅ 已加载 ${accounts.length} 个账号，Cookie 有效 ${validCount} 个`);
  console.log(`📁 账号配置: ${getAccountsPath()}`);
  console.log(`📁 运行目录: ${LOG_DIR}`);

  await runOnceOrLoop(healthyRuntimes, once);
}

main().catch(e => {
  console.error('❌ manager 致命错误:', e.message);
  process.exit(1);
});

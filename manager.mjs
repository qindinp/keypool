#!/usr/bin/env node
/**
 * KeyPool Manager (Phase 3.5 health-aware registry sync)
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './controller/config.mjs';
import { createStateStore } from './controller/state-store.mjs';
import { createMimoApi } from './controller/mimo-api.mjs';
import { createLogger } from './controller/logger.mjs';
import { createAccountWorker } from './controller/account-worker.mjs';
import { createRegistry } from './controller/registry.mjs';
import { sleep } from './controller/utils.mjs';
import { loadAccounts, getAccountsPath } from './controller/accounts.mjs';
import { probeHealth } from './relay/proxy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, '.manager');
const REGISTRY_PATH = resolve(LOG_DIR, 'registry.json');

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

async function computeEndpointHealth(baseUrl) {
  if (!baseUrl) return { healthy: false, healthStatusCode: 0, healthError: 'missing baseUrl' };
  const result = await probeHealth({ baseUrl, timeoutMs: 15_000 });
  return {
    healthy: result.ok,
    healthStatusCode: result.statusCode,
    healthError: result.ok ? null : (result.error || `health ${result.statusCode}`),
  };
}

async function syncRegistryForRuntime(rt, registry) {
  const state = rt.stateStore.loadState();
  let instanceStatus = 'UNKNOWN';
  let expireTime = null;
  let lastError = null;

  try {
    const status = await rt.api.getStatus(rt.account.cookie);
    instanceStatus = status.status || 'UNKNOWN';
    expireTime = status.expireTime || null;
  } catch (e) {
    lastError = e.message;
  }

  const shareUrl = state.currentShareUrl || null;
  const localUrl = state.currentLocalUrl || 'http://127.0.0.1:9200';
  const baseUrl = shareUrl;
  const endpointHealth = await computeEndpointHealth(baseUrl);
  const healthy = instanceStatus === 'AVAILABLE' && endpointHealth.healthy;

  registry.upsert({
    accountId: rt.account.id,
    accountName: rt.account.name,
    userId: rt.auth?.userId || null,
    userName: rt.auth?.userName || null,
    baseUrl,
    shareUrl,
    localUrl,
    healthy,
    priority: rt.account.priority,
    tags: rt.account.tags || [],
    instanceStatus,
    expireTime,
    deployed: Boolean(state.lastDeployAt),
    deployCount: state.deployCount || 0,
    lastDeployAt: state.lastDeployAt || null,
    lastError: lastError || endpointHealth.healthError,
    lastStatusCode: endpointHealth.healthStatusCode,
  });
}

async function syncRegistry(runtimes, registry) {
  for (const rt of runtimes) {
    await syncRegistryForRuntime(rt, registry);
  }
}

async function cmdStatus(runtimes, registry) {
  await syncRegistry(runtimes, registry);
  for (const rt of runtimes) {
    console.log(`\n================ ${rt.account.name} ================`);
    await rt.worker.cmdStatus();
  }
  console.log('\n================ registry ================');
  console.log(JSON.stringify(registry.load(), null, 2));
}

async function cmdDeploy(runtimes, registry) {
  for (const rt of runtimes) {
    rt.log('deploy', '强制重新部署...');
    await rt.worker.renewFlow('manual-deploy');
    await syncRegistryForRuntime(rt, registry);
  }
}

async function runOnceOrLoop(runtimes, once, registry, config) {
  if (once) {
    await Promise.all(runtimes.map(rt => rt.worker.runLoop({ once: true })));
    await syncRegistry(runtimes, registry);
    return;
  }

  await syncRegistry(runtimes, registry);
  const loops = runtimes.map(rt => rt.worker.runLoop({ once: false }));
  const registryLoop = (async () => {
    while (true) {
      await sleep(Math.max(15_000, Math.min(config.checkInterval, 60_000)));
      await syncRegistry(runtimes, registry);
    }
  })();

  await Promise.all([...loops, registryLoop]);
}

async function main() {
  const config = createConfig();
  const args = process.argv.slice(2);
  const accounts = loadAccounts();
  const registry = createRegistry(REGISTRY_PATH);

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

  if (args.includes('--status')) return cmdStatus(healthyRuntimes, registry);
  if (args.includes('--deploy')) return cmdDeploy(healthyRuntimes, registry);

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
  console.log(`📁 registry: ${REGISTRY_PATH}`);

  await runOnceOrLoop(healthyRuntimes, once, registry, config);
}

main().catch(e => {
  console.error('❌ manager 致命错误:', e.message);
  process.exit(1);
});

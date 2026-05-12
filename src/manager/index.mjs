/**
 * Manager 主入口
 *
 * 加载账号 → 创建 Worker → 启动调度器
 * 部署方式：skill-proxy（DeployClient 通过小米平台 WS + AI 对话部署）
 */

import { loadAccounts } from './accounts.mjs';
import { createConfig } from './config.mjs';
import { createMimoApi } from './instance.mjs';
import { AccountWorker } from './account-worker.mjs';
import { Scheduler } from './scheduler.mjs';
import { createDeployer } from './deployer.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEFAULT_PUBLIC_WS_URL = 'wss://pc-20250301fuan.tail59e491.ts.net/tunnel';

export function createManager(registry, opts = {}) {
  const config = createConfig();
  const api = createMimoApi({ sleep });

  let accounts;
  try {
    accounts = loadAccounts(opts.accountsPath);
  } catch (err) {
    console.warn(`⚠️ Manager 无法启动: ${err.message}`);
    console.warn('   Gateway 仍将运行，但无实例管理');
    return null;
  }

  if (accounts.length === 0) {
    console.warn('⚠️ 无可用账号，Manager 不启动');
    return null;
  }

  console.log(`👥 加载 ${accounts.length} 个账号`);

  const deployer = createDeployer({
    gatewayUrl: opts.gatewayUrl || process.env.KEYPOOL_GATEWAY_URL || config.publicWsUrl || DEFAULT_PUBLIC_WS_URL,
    gatewayHttpBase: opts.gatewayHttpBase || process.env.KEYPOOL_GATEWAY_HTTP_BASE || config.publicHttpBase || 'https://pc-20250301fuan.tail59e491.ts.net',
    localSrcDir: opts.localSrcDir || config.localSrcDir,
    deployRepo: config.deployRepo,
    chatTimeout: config.chatTimeout,
    wsConnectTimeout: config.wsConnectTimeout,
    readyTimeout: config.readyTimeout,
    mimoApiUrl: config.mimoApiUrl,
    giteeToken: config.giteeToken,
    registry,
  });

  const workers = accounts.map(account =>
    new AccountWorker(account, {
      registry,
      api,
      deployer,
      config: {
        retryBaseDelay: config.retryBaseDelay,
        retryMaxDelay: config.retryMaxDelay,
      },
    })
  );

  const scheduler = new Scheduler(workers, registry, {
    checkInterval: config.checkInterval,
    renewBefore: config.renewBefore,
  });

  function start() {
    console.log(`🚀 Manager 启动 (${workers.length} 账号)`);
    scheduler.start().catch(err => {
      console.error('❌ 调度器异常退出:', err);
    });
  }

  function stop() {
    scheduler.stop();
  }

  return { start, stop, workers, config };
}

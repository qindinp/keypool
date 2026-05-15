/**
 * Manager 主入口
 *
 * 加载账号 → 创建 Worker → 启动调度器
 * 部署方式：skill-proxy（DeployClient 通过小米平台 WS + AI 对话部署）
 */

import { loadAccounts, getAccountsPath } from './accounts.mjs';
import { watch } from 'node:fs';
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

  /**
   * 热重载账号配置
   * - 新增账号 → 创建 Worker 并加入调度
   * - 移除/禁用账号 → 从调度中移除
   * - 变更账号（cookie 等）→ 更新 Worker
   * @returns {{ added: string[], removed: string[], updated: string[], error?: string }}
   */
  function reloadAccounts() {
    let newAccounts;
    try {
      newAccounts = loadAccounts(opts.accountsPath);
    } catch (err) {
      console.warn(`⚠️ 热重载失败: ${err.message}`);
      return { added: [], removed: [], updated: [], error: err.message };
    }

    const currentIds = new Set(workers.map(w => w.account.id));
    const newIds = new Set(newAccounts.map(a => a.id));

    const added = [];
    const removed = [];
    const updated = [];

    // 新增：在 newAccounts 中但不在当前 workers 中
    for (const account of newAccounts) {
      if (!currentIds.has(account.id)) {
        const worker = new AccountWorker(account, {
          registry,
          api,
          deployer,
          config: {
            retryBaseDelay: config.retryBaseDelay,
            retryMaxDelay: config.retryMaxDelay,
          },
        });
        workers.push(worker);
        added.push(account.id);
        console.log(`➕ [${account.id}] 新增账号，已加入调度`);
      }
    }

    // 移除：在当前 workers 中但不在 newAccounts 中（或被禁用）
    for (let i = workers.length - 1; i >= 0; i--) {
      const w = workers[i];
      if (!newIds.has(w.account.id)) {
        workers.splice(i, 1);
        removed.push(w.account.id);
        console.log(`➖ [${w.account.id}] 账号已移除，从调度中删除`);
      }
    }

    // 更新：两边都有的账号，检查 cookie 等字段是否变化
    for (const account of newAccounts) {
      const worker = workers.find(w => w.account.id === account.id);
      if (!worker) continue;

      const oldCookie = worker.account.cookie;
      const newCookie = account.cookie;
      if (oldCookie !== newCookie) {
        worker.account = account;
        updated.push(account.id);
        console.log(`🔄 [${account.id}] 账号配置已更新`);
      }
    }

    const total = workers.length;
    if (added.length || removed.length || updated.length) {
      console.log(`🔁 Manager 热重载完成: +${added.length} -${removed.length} ~${updated.length} (共 ${total} 个)`);
    } else {
      console.log(`🔁 Manager 热重载: 无变化 (共 ${total} 个)`);
    }

    return { added, removed, updated };
  }

  let watcher = null;

  function start() {
    console.log(`🚀 Manager 启动 (${workers.length} 账号)`);
    scheduler.start().catch(err => {
      console.error('❌ 调度器异常退出:', err);
    });

    // 监听 accounts.json 变更，自动热重载
    try {
      const accountsPath = opts.accountsPath || getAccountsPath();
      let debounce = null;
      watcher = watch(accountsPath, { persistent: false }, (eventType) => {
        if (eventType !== 'change') return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log('📁 accounts.json 变更检测，自动热重载...');
          reloadAccounts();
        }, 500);
      });
      watcher.on('error', (err) => {
        console.warn('⚠️ accounts.json 监听失败:', err.message);
      });
      console.log(`📂 已监听 accounts.json 变更`);
    } catch (err) {
      console.warn('⚠️ 无法监听 accounts.json:', err.message);
    }
  }

  function stop() {
    scheduler.stop();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  return { start, stop, workers, config, reloadAccounts };
}

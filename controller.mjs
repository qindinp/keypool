#!/usr/bin/env node
/**
 * KeyPool Controller (Part 2 — 外部持久服务器)
 *
 * 入口文件：
 * - 解析配置与 cookie
 * - 初始化单账号 worker
 * - 分发 --status / --deploy / --once / 持续运行
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './controller/config.mjs';
import { createStateStore } from './controller/state-store.mjs';
import { createMimoApi, getCookie } from './controller/mimo-api.mjs';
import { createLogger } from './controller/logger.mjs';
import { createAccountWorker } from './controller/account-worker.mjs';
import { sleep } from './controller/utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, '.controller.log');

async function main() {
  const config = createConfig();
  const { log } = createLogger(LOG_PATH);
  const cookie = getCookie();
  const stateStore = createStateStore();
  const api = createMimoApi({ sleep });
  const worker = createAccountWorker({ cookie, config, api, stateStore, log });
  const args = process.argv.slice(2);

  const auth = await api.validateCookie(cookie);
  if (!auth.valid) {
    log('error', `Cookie 无效: ${auth.reason}`);
    log('info', '请更新 .cookie 文件或 MIMO_COOKIE 环境变量');
    process.exit(1);
  }
  log('ok', `Cookie 有效 — 用户: ${auth.userName} (${auth.userId})`);

  if (args.includes('--status')) return worker.cmdStatus();
  if (args.includes('--deploy')) return worker.cmdDeploy();

  const once = args.includes('--once');

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `收到 ${sig}，正在关闭...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await worker.runLoop({ once });
}

main().catch(e => {
  const { log } = createLogger(LOG_PATH);
  log('error', '致命错误:', e.message);
  process.exit(1);
});

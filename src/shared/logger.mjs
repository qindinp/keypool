/**
 * 共享日志模块
 *
 * 来源: controller/logger.mjs
 * 变更: 无逻辑变化，仅迁移路径
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_ICONS = {
  info: 'ℹ️ ', warn: '⚠️ ', error: '❌', ok: '✅',
  rocket: '🚀', clock: '⏰', link: '🔗', key: '🔑',
  skip: '⏭️ ', retry: '🔄', ping: '💓', deploy: '📦',
};

/**
 * 创建文件日志器
 * @param {string} logPath - 日志文件的绝对路径
 * @returns {{ log: Function }}
 */
export function createLogger(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });

  function log(level, ...args) {
    const ts = new Date().toLocaleString('zh-CN', {
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const icon = LOG_ICONS[level] || '  ';
    const line = `[${ts}] ${icon} ${args.join(' ')}`;
    console.log(line);
    try { writeFileSync(logPath, line + '\n', { flag: 'a' }); } catch {}
  }

  return { log };
}

/**
 * 共享工具函数
 *
 * 消除以下文件中的重复定义：
 *   - controller/utils.mjs
 *   - server/tunnel.mjs (sleep)
 *   - renew.mjs (sleep)
 *   - scripts/test-relay.mjs (sleep)
 */

/**
 * 延迟指定毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带指数退避的重试
 *
 * @param {string} name - 操作名称（用于日志）
 * @param {Function} fn - 要执行的异步函数
 * @param {object} opts
 * @param {number} opts.maxRetries - 最大重试次数
 * @param {number} opts.retryBaseDelay - 基础延迟 (ms)
 * @param {number} opts.retryMaxDelay - 最大延迟上限 (ms)
 * @param {Function} opts.log - 日志函数 (level, ...args)
 * @param {Function} [opts.sleepFn] - 可替换的 sleep 实现
 */
export async function withRetry(name, fn, { maxRetries, retryBaseDelay, retryMaxDelay, log, sleepFn = sleep }) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries) throw e;
      const delay = Math.min(retryBaseDelay * Math.pow(2, i), retryMaxDelay);
      log('retry', `${name} 失败 (${i + 1}/${maxRetries}): ${e.message}, ${delay / 1000}s 后重试`);
      await sleepFn(delay);
    }
  }
}

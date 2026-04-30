export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

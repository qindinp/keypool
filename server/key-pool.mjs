/**
 * KeyPool — Key 池管理
 *
 * Round-robin 轮转 + 健康感知 + 自动恢复
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

export class KeyPool {
  /**
   * @param {Array} keyConfigs - [{ id, key, baseUrl? }]
   * @param {object} opts
   * @param {number} opts.keyRetryDelay - key 禁用后重试延迟 (ms)
   * @param {Function} opts.log - 日志函数 (level, ...args)
   */
  constructor(keyConfigs, opts = {}) {
    this.keyRetryDelay = opts.keyRetryDelay || 60_000;
    this._log = opts.log || (() => {});
    this.keys = keyConfigs.map((kc, i) => ({
      id: kc.id || `key-${i + 1}`,
      key: kc.key,
      baseUrl: kc.baseUrl || null,
      enabled: true,
      errorCount: 0,
      lastError: null,
      lastUsedAt: 0,
      stats: { requests: 0, tokens: 0, errors: 0 },
    }));
    this.index = 0;
    this._log('info', `Loaded ${this.keys.length} API key(s)`);
  }

  /** 选取下一个可用 key (round-robin)。全部禁用时返回 null。 */
  pick() {
    const enabled = this.keys.filter((k) => k.enabled);
    if (enabled.length === 0) return null;
    this.index = this.index % enabled.length;
    const key = enabled[this.index];
    this.index = (this.index + 1) % enabled.length;
    key.lastUsedAt = Date.now();
    return key;
  }

  /** 获取可用 key 数量 */
  get availableCount() {
    return this.keys.filter((k) => k.enabled).length;
  }

  /** 标记 key 出错，必要时禁用 */
  markError(keyEntry, statusCode, body) {
    keyEntry.stats.errors++;
    keyEntry.errorCount++;
    keyEntry.lastError = { status: statusCode, body: body?.slice(0, 200), at: Date.now() };

    if ([401, 403, 429].includes(statusCode)) {
      keyEntry.enabled = false;
      this._log('warn', `Key ${keyEntry.id} disabled (${statusCode}). Will retry later.`);
    } else if (statusCode >= 500 && keyEntry.errorCount >= 3) {
      keyEntry.enabled = false;
      this._log('warn', `Key ${keyEntry.id} disabled after ${keyEntry.errorCount} consecutive server errors.`);
    }
  }

  /** 标记成功 */
  markSuccess(keyEntry, tokens = 0) {
    keyEntry.stats.requests++;
    keyEntry.stats.tokens += tokens;
    keyEntry.errorCount = 0;
  }

  /** 定期恢复被禁用的 key */
  recoverKeys() {
    for (const k of this.keys) {
      if (!k.enabled && k.lastError) {
        const elapsed = Date.now() - k.lastError.at;
        if (elapsed > this.keyRetryDelay) {
          k.enabled = true;
          k.errorCount = 0;
          this._log('info', `Key ${k.id} re-enabled after ${Math.round(elapsed / 1000)}s`);
        }
      }
    }
  }

  /** 获取所有 key 统计 */
  getStats() {
    return this.keys.map((k) => ({
      id: k.id,
      enabled: k.enabled,
      lastUsed: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null,
      lastError: k.lastError,
      stats: { ...k.stats },
    }));
  }

  /** 获取 key 对应的上游目标 */
  getTargetFor(keyEntry) {
    const base = keyEntry.baseUrl || this._defaultBaseUrl;
    const parsed = new URL(base);
    return {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      isHttps: parsed.protocol === 'https:',
    };
  }

  /** 设置默认上游地址（由外部调用） */
  setDefaultBaseUrl(url) {
    this._defaultBaseUrl = url;
  }
}

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
      recoverFailures: 0,
      lastError: null,
      lastUsedAt: 0,
      stats: { requests: 0, tokens: 0, errors: 0 },
    }));
    this.index = 0;
    this._targetCache = new Map(); // 缓存 URL 解析结果
    this._log('info', `Loaded ${this.keys.length} API key(s)`);
  }

  /** 选取下一个可用 key (round-robin)。全部禁用时返回 null。 */
  pick() {
    const len = this.keys.length;
    if (len === 0) return null;
    // 在全量 key 数组中轮转，跳过禁用的 key
    for (let i = 0; i < len; i++) {
      const idx = (this.index + i) % len;
      const key = this.keys[idx];
      if (key.enabled) {
        this.index = (idx + 1) % len;
        key.lastUsedAt = Date.now();
        return key;
      }
    }
    return null;
  }

  /** 选取一个不同于 excludeId 的可用 key，用于重试场景 */
  pickOther(excludeId) {
    const enabled = this.keys.filter((k) => k.enabled && k.id !== excludeId);
    if (enabled.length === 0) return null;
    // 优先选最近最少使用的
    enabled.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const key = enabled[0];
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
      if (keyEntry.enabled) {
        keyEntry.recoverFailures = (keyEntry.recoverFailures || 0) + 1;
      }
      keyEntry.enabled = false;
      this._log('warn', `Key ${keyEntry.id} disabled (${statusCode}). Will retry later.`);
    } else if (statusCode >= 500 && keyEntry.errorCount >= 3) {
      if (keyEntry.enabled) {
        keyEntry.recoverFailures = (keyEntry.recoverFailures || 0) + 1;
      }
      keyEntry.enabled = false;
      this._log('warn', `Key ${keyEntry.id} disabled after ${keyEntry.errorCount} consecutive server errors.`);
    }
  }

  /** 标记成功 */
  markSuccess(keyEntry, tokens = 0) {
    keyEntry.stats.requests++;
    keyEntry.stats.tokens += tokens;
    keyEntry.errorCount = 0;
    keyEntry.recoverFailures = 0; // 成功后重置恢复失败计数
  }

  /** 定期恢复被禁用的 key（带指数退避，避免反复抖动） */
  recoverKeys() {
    for (const k of this.keys) {
      if (!k.enabled && k.lastError) {
        const elapsed = Date.now() - k.lastError.at;
        // 指数退避：每次恢复失败后延迟翻倍，上限 10 分钟
        const backoffMs = Math.min(this.keyRetryDelay * Math.pow(2, k.recoverFailures || 0), 600_000);
        if (elapsed > backoffMs) {
          k.enabled = true;
          k.errorCount = 0;
          // 不立即重置 recoverFailures，等 markSuccess 时再重置
          this._log('info', `Key ${k.id} re-enabled after ${Math.round(elapsed / 1000)}s (backoff: ${Math.round(backoffMs / 1000)}s)`);
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

  /** 获取 key 对应的上游目标（带缓存） */
  getTargetFor(keyEntry) {
    const base = keyEntry.baseUrl || this._defaultBaseUrl;
    if (this._targetCache.has(base)) {
      return this._targetCache.get(base);
    }
    const parsed = new URL(base);
    const target = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      isHttps: parsed.protocol === 'https:',
    };
    this._targetCache.set(base, target);
    return target;
  }

  /** 设置默认上游地址（由外部调用） */
  setDefaultBaseUrl(url) {
    this._defaultBaseUrl = url;
  }
}

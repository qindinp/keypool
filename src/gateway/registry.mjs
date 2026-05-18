/**
 * Gateway 注册表 — 实例状态管理
 *
 * 职责：
 * - 管理各账号的实例状态（NONE/CREATING/READY/DEPLOYING/ACTIVE/FAILED...）
 * - 提供 verified upstream 查询（Gateway 路由用）
 * - 不再管理 Agent WS 连接（已移除）
 */

export class Registry {
  constructor() {
    /** @type {Map<string, InstanceState>} accountId → state */
    this.instances = new Map();
  }

  // ─── 实例状态管理（Manager 调用） ────────────────────────────

  setInstanceStatus(accountId, status) {
    const state = this.instances.get(accountId) || {};
    state.status = status;
    this.instances.set(accountId, state);
  }

  updateInstanceState(accountId, patch = {}) {
    const state = this.instances.get(accountId) || {};
    this.instances.set(accountId, { ...state, ...patch });
  }

  getInstanceState(accountId) {
    return this.instances.get(accountId) || null;
  }

  getInstanceStatus(accountId) {
    return this.instances.get(accountId)?.status || 'NONE';
  }

  getAllInstances() {
    return this.instances;
  }

  // ─── 路由查询（Gateway 调用） ───────────────────────────────

  /**
   * 获取已验证且可路由的 skill-proxy 上游实例
   * @param {string} [model]
   * @param {object} [opts]
   * @param {Set<string>} [opts.excludeAccountIds] - 排除的 accountId（重试时用）
   * @param {boolean} [opts.includeUnhealthy=false] - 是否包含 healthOk=false 的实例
   * @returns {Array<object>}
   */
  getVerifiedUpstreams(model, opts = {}) {
    const { excludeAccountIds = new Set(), includeUnhealthy = false } = opts;
    const now = Date.now();
    const HEALTH_RECOVERY_MS = 60_000;

    const list = [...this.instances.values()]
      .filter(s => s && s.verified && (s.proxyUrl || s.baseUrl || s.localUrl || s.tunnel))
      .filter(s => !s.status || ['ACTIVE', 'DEPLOYED_UNVERIFIED'].includes(s.status))
      .filter(s => !excludeAccountIds.has(s.accountId))
      .filter(s => {
        if (s.healthOk !== false) return true;
        if (includeUnhealthy) return true;
        // allow recovery after 60s
        const failAt = s.lastHealthErrorAt ? Date.parse(s.lastHealthErrorAt) || 0 : 0;
        if (failAt && (now - failAt) > HEALTH_RECOVERY_MS) return true;
        return false;
      });

    // model filtering: instances don't carry model info, so pass all upstreams through
    return list.sort((a, b) => {
      const pa = Number.isFinite(a.priority) ? a.priority : 100;
      const pb = Number.isFinite(b.priority) ? b.priority : 100;
      if (pa !== pb) return pa - pb;
      const va = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) || 0 : 0;
      const vb = b.lastVerifiedAt ? Date.parse(b.lastVerifiedAt) || 0 : 0;
      return vb - va;
    });
  }

  /**
   * 选择一个已验证的 skill-proxy 上游（加权随机）
   * 参考 new-api: 同优先级层内 weight + 10，随机数逐个扣减选中
   * @param {string} [model]
   * @param {object} [opts]
   * @param {Set<string>} [opts.excludeAccountIds] - 排除的 accountId
   * @returns {object|null}
   */
  chooseVerifiedUpstream(model, opts = {}) {
    const { excludeAccountIds = new Set() } = opts;
    const upstreams = this.getVerifiedUpstreams(model, { excludeAccountIds });
    if (upstreams.length === 0) return null;

    // 按优先级分层，取最高优先级层
    const topPriority = Number.isFinite(upstreams[0].priority) ? upstreams[0].priority : 100;
    const tier = upstreams.filter(u => {
      const p = Number.isFinite(u.priority) ? u.priority : 100;
      return p === topPriority;
    });

    if (tier.length === 1) return tier[0];

    // 同层加权随机（参考 new-api: weight + 10，weight=0 也有基础概率）
    const BASE_WEIGHT = 10;
    let weightSum = 0;
    const weighted = tier.map(u => {
      const w = (Number.isFinite(u.weight) ? u.weight : 10) + BASE_WEIGHT;
      weightSum += w;
      return { upstream: u, weight: w };
    });

    let rand = Math.random() * weightSum;
    for (const { upstream, weight } of weighted) {
      rand -= weight;
      if (rand <= 0) return upstream;
    }
    return weighted[weighted.length - 1].upstream;
  }

  /**
   * 获取健康 upstream 数量
   * @param {string} [model]
   * @returns {number}
   */
  getHealthyUpstreamCount(model) {
    return this.getVerifiedUpstreams(model).length;
  }

  /**
   * 不可变更新实例状态
   * @param {string} accountId
   * @param {object} updates
   */
  _updateState(accountId, updates) {
    const old = this.instances.get(accountId);
    if (!old) return;
    this.instances.set(accountId, { ...old, ...updates });
  }

  /**
   * 标记代理请求成功
   */
  markProxySuccess(accountId, latencyMs) {
    this._updateState(accountId, {
      lastUsedAt: new Date().toISOString(),
      lastProxyLatencyMs: latencyMs,
      healthOk: true,
      consecutiveFailures: 0,
      consecutiveUpstreamErrors: 0,
    });
  }

  /**
   * 标记代理请求失败（传输层错误：连接断开、超时等）
   * 会将 healthOk 设为 false，影响路由选择
   */
  markProxyFailure(accountId, error) {
    const old = this.instances.get(accountId);
    if (!old) return;
    this._updateState(accountId, {
      lastHealthError: error,
      lastHealthErrorAt: new Date().toISOString(),
      lastProxyError: error,
      healthOk: false,
      consecutiveFailures: (old.consecutiveFailures || 0) + 1,
    });
  }

  /**
   * 标记上游业务错误（upstream 返回 4xx/5xx）
   * 连续错误达到阈值后标记 healthOk=false，让路由临时排除该实例
   */
  markProxyUpstreamError(accountId, status, body) {
    const old = this.instances.get(accountId);
    if (!old) return;
    const consecutive = (old.consecutiveUpstreamErrors || 0) + 1;
    const shouldExclude = consecutive >= 3;
    this._updateState(accountId, {
      lastUpstreamStatus: status,
      lastUpstreamError: typeof body === 'string' ? body.slice(0, 500) : body,
      lastUsedAt: new Date().toISOString(),
      consecutiveUpstreamErrors: consecutive,
      ...(shouldExclude ? {
        healthOk: false,
        lastHealthErrorAt: new Date().toISOString(),
        lastHealthError: `consecutive upstream errors (${consecutive})`,
      } : {}),
    });
  }
}

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
   * @returns {Array<object>}
   */
  getVerifiedUpstreams(model) {
    const list = [...this.instances.values()]
      .filter(s => s && s.verified && (s.proxyUrl || s.baseUrl || s.localUrl || s.tunnel))
      .filter(s => !s.status || ['ACTIVE', 'DEPLOYED_UNVERIFIED'].includes(s.status));

    const filtered = model
      ? list.filter(s => {
          const models = Array.isArray(s.models) ? s.models : [];
          return models.length === 0 || models.includes(model);
        })
      : list;

    return filtered.sort((a, b) => {
      const pa = Number.isFinite(a.priority) ? a.priority : 100;
      const pb = Number.isFinite(b.priority) ? b.priority : 100;
      if (pa !== pb) return pa - pb;
      const va = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) || 0 : 0;
      const vb = b.lastVerifiedAt ? Date.parse(b.lastVerifiedAt) || 0 : 0;
      return vb - va;
    });
  }

  /**
   * 选择一个已验证的 skill-proxy 上游
   * @param {string} [model]
   * @returns {object|null}
   */
  chooseVerifiedUpstream(model) {
    return this.getVerifiedUpstreams(model)[0] || null;
  }

  /**
   * 标记代理请求成功
   */
  markProxySuccess(accountId, latencyMs) {
    const state = this.instances.get(accountId);
    if (!state) return;
    state.lastUsedAt = new Date().toISOString();
    state.lastProxyLatencyMs = latencyMs;
    state.healthOk = true;
    state.consecutiveFailures = 0;
  }

  /**
   * 标记代理请求失败（传输层错误：连接断开、超时等）
   * 会将 healthOk 设为 false，影响路由选择
   */
  markProxyFailure(accountId, error) {
    const state = this.instances.get(accountId);
    if (!state) return;
    state.lastHealthError = error;
    state.lastProxyError = error;
    state.healthOk = false;
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  }

  /**
   * 标记上游业务错误（upstream 返回 4xx/5xx）
   * 不影响 healthOk（连接本身是通的）
   */
  markProxyUpstreamError(accountId, status, body) {
    const state = this.instances.get(accountId);
    if (!state) return;
    state.lastUpstreamStatus = status;
    state.lastUpstreamError = typeof body === 'string' ? body.slice(0, 500) : body;
    state.lastUsedAt = new Date().toISOString();
    // 不设 healthOk = false；连接正常，只是上游返回了业务错误
  }

  // ─── Agent 查询（兼容旧 Admin API） ───────────────────────

  /**
   * 获取所有已注册的 Agent 条目
   * 当前架构已移除 Agent WS 回连，返回空数组
   * @returns {Array<object>}
   */
  getAll() {
    return [];
  }

  /**
   * 获取健康的 Agent 条目
   * 当前架构已移除 Agent WS 回连，返回空数组
   * @returns {Array<object>}
   */
  getHealthy() {
    return [];
  }
}

/**
 * 单账号生命周期管理 — 状态机
 *
 * 状态机：
 *   NONE → CREATING → READY → DEPLOYING → DEPLOYED_UNVERIFIED → ACTIVE
 *   ACTIVE → CREATING (续期)
 *   CREATING/READY/DEPLOYING/DEPLOYED_UNVERIFIED → FAILED → CREATING (冷却重试)
 *   ACTIVE → EXPIRED → DESTROYED → CREATING
 *
 * 部署方式：skill-proxy（DeployClient 通过小米平台 WS + AI 对话部署）
 * 不再支持旧 Agent WS 回连模式
 */

export class AccountWorker {
  /** 从 MiMo API 响应推断限时沙箱的实际创建时间 */
  static sandboxCreatedAt(apiResult) {
    if (apiResult.createTime) return typeof apiResult.createTime === 'number' ? new Date(apiResult.createTime).toISOString() : String(apiResult.createTime);
    if (apiResult.expireTime) return new Date(apiResult.expireTime - 3600_000).toISOString();
    return new Date().toISOString();
  }

  /**
   * @param {object} account - 账号配置 { id, name, cookie, priority }
   * @param {object} deps - 依赖注入
   * @param {import('../gateway/registry.mjs').Registry} deps.registry
   * @param {object} deps.api - MiMo API (createInstance, destroyInstance, getStatus)
   * @param {object} [deps.deployer] - 部署器
   * @param {object} [deps.config] - 调度配置
   */
  constructor(account, deps) {
    this.account = account;
    this.registry = deps.registry;
    this.api = deps.api;
    this.deployer = deps.deployer;
    this.config = deps.config || {};

    this.state = 'NONE';
    this.instance = null;
    this.cooldownUntil = 0;

    // Initialize registry state with account config (weight, priority)
    this.registry.updateInstanceState(this.account.id, {
      accountId: this.account.id,
      weight: this.account.weight,
      priority: this.account.priority,
    });
  }

  snapshot() {
    const now = Date.now();
    return {
      state: this.state,
      instance: this.instance ? {
        ...this.instance,
        remaining: this.instance.expiresAt ? this.instance.expiresAt - now : Infinity,
        cooldownElapsed: now >= this.cooldownUntil,
      } : null,
    };
  }

  setState(nextState, extra = {}) {
    this.state = nextState;
    this.registry.setInstanceStatus(this.account.id, nextState);
    if (extra && Object.keys(extra).length > 0) {
      this.registry.updateInstanceState(this.account.id, extra);
    }
  }

  adoptActiveTunnel(extra = {}) {
    const currentState = this.registry.getInstanceState(this.account.id) || {};
    if (!currentState.tunnel) return false;

    this.setState('ACTIVE', {
      ...extra,
      verified: true,
      healthOk: true,
      lastVerifiedAt: currentState.lastVerifiedAt || new Date().toISOString(),
      tunnel: currentState.tunnel,
      tunnelAccountId: currentState.tunnelAccountId || this.account.id,
      tunnelRunId: currentState.tunnelRunId || extra.runId || null,
      tunnelConnectedAt: currentState.tunnelConnectedAt || new Date().toISOString(),
      deployMode: extra.deployMode || currentState.deployMode || 'tunnel',
      deployStage: extra.deployStage || 'tunnel-adopted',
      deployStatus: 'ok',
      lastDeployError: null,
      failureType: null,
      retryable: true,
      confirmationSource: extra.confirmationSource || 'tunnel-registration',
    });
    console.log(`✅ [${this.account.id}] 采用已注册 tunnel，标记为 ACTIVE (${currentState.tunnelRunId || 'unknown-run'})`);
    return true;
  }

  async deployCurrentInstance() {
    if (!this.deployer) return null;

    const prevRegistryState = this.registry.getInstanceState(this.account.id) || {};
    const prevDeployCount = Number(prevRegistryState.deployCount) || 0;
    this.setState('DEPLOYING', {
      deployMode: 'tunnel',
      verified: false,
      healthOk: false,
      lastDeployAt: new Date().toISOString(),
      lastDeployError: null,
      deployTimeline: [],
      confirmationSource: null,
      responseText: null,
      deployCount: prevDeployCount + 1,
    });

    const result = await this.deployer.deploy(this.account);

    const deployMeta = {
      deployMode: result?.deployMode || 'tunnel',
      proxyUrl: result?.proxyUrl || null,
      runId: result?.runId || null,
      created: !!result?.created,
      started: !!result?.started,
      healthOk: !!result?.healthOk,
      verified: !!result?.verified,
      lastDeployAt: new Date().toISOString(),
      lastVerifiedAt: result?.verified ? new Date().toISOString() : null,
      lastDeployError: null,
      deployStage: result?.stage || (result?.verified ? 'complete' : 'tunnel-wait'),
      deployStatus: result?.stageStatus || (result?.verified ? 'ok' : 'pending'),
      retryable: result?.retryable !== false,
      failureType: result?.failureType || null,
      confirmationSource: result?.confirmationSource || null,
      responseText: result?.responseText || null,
      deployTimeline: Array.isArray(result?.timeline) ? result.timeline : [],
    };

    const currentState = this.registry.getInstanceState(this.account.id) || {};
    const tunnelAlreadyConnected = !!currentState.tunnel && (!result?.runId || !currentState.tunnelRunId || currentState.tunnelRunId === result.runId);

    if (result?.verified || tunnelAlreadyConnected) {
      this.setState('ACTIVE', {
        ...deployMeta,
        // tunnel 注册可能早于 deploy() 返回；不要用 deploy() 的 pending 元数据覆盖已验证状态。
        verified: true,
        healthOk: true,
        lastVerifiedAt: currentState.lastVerifiedAt || new Date().toISOString(),
        tunnel: currentState.tunnel || null,
        tunnelAccountId: currentState.tunnelAccountId || this.account.id,
        tunnelRunId: currentState.tunnelRunId || result?.runId || null,
        tunnelConnectedAt: currentState.tunnelConnectedAt || new Date().toISOString(),
      });
      console.log(`✅ [${this.account.id}] 部署完成并验证可用 (${result?.proxyUrl || 'tunnel'})`);
      return result;
    }

    // Tunnel 模式：部署完成但等待 tunnel 连接
    this.setState('DEPLOYED_UNVERIFIED', deployMeta);
    console.log(`⏳ [${this.account.id}] 部署完成，等待 tunnel 连接到 Gateway...`);
    return result;
  }

  async create() {
    this.setState('CREATING');

    try {
      console.log(`📦 [${this.account.id}] 创建实例...`);
      const result = await this.api.createInstance(this.account.cookie);

      this.instance = {
        accountId: this.account.id,
        status: result.status,
        expiresAt: result.expireTime || (Date.now() + 3600_000),
        createdAt: Date.now(),
      };

      this.setState('READY', {
        createdAt: AccountWorker.sandboxCreatedAt(result),
        expiresAt: this.instance.expiresAt,
      });
      console.log(`✅ [${this.account.id}] 实例就绪 (status=${result.status}, expires=${new Date(this.instance.expiresAt).toLocaleString()})`);

      if (this.deployer) {
        try {
          await this.deployCurrentInstance();
        } catch (err) {
          const deployResult = err?.deployResult || {};
          const adopted = this.adoptActiveTunnel({
            deployMode: deployResult.deployMode || 'tunnel',
            runId: deployResult.runId || null,
            deployTimeline: Array.isArray(deployResult.timeline) ? deployResult.timeline : [],
            responseText: deployResult.responseText || null,
          });
          if (adopted) return;

          console.error(`❌ [${this.account.id}] 部署失败:`, err.message);
          this.setState('FAILED', {
            verified: false,
            healthOk: false,
            lastDeployError: deployResult.lastError || err.message,
            lastDeployAt: new Date().toISOString(),
            deployMode: deployResult.deployMode || 'skill-proxy',
            deployStage: deployResult.stage || 'unknown',
            deployStatus: deployResult.stageStatus || 'failed',
            retryable: !!deployResult.retryable,
            failureType: deployResult.failureType || 'unknown',
            confirmationSource: deployResult.confirmationSource || null,
            responseText: deployResult.responseText || null,
            deployTimeline: Array.isArray(deployResult.timeline) ? deployResult.timeline : [],
          });
          this.cooldownUntil = Date.now() + (this.config.retryBaseDelay || 30_000);
        }
      }
    } catch (err) {
      console.error(`❌ [${this.account.id}] 创建失败:`, err.message);
      this.setState('FAILED', {
        verified: false,
        healthOk: false,
        lastDeployError: err.message,
      });
      this.cooldownUntil = Date.now() + (this.config.retryBaseDelay || 30_000);
    }
  }

  async renew() {
    console.log(`🔄 [${this.account.id}] 开始续期...`);
    const oldInstance = this.instance;
    const oldState = this.state;

    this.setState('CREATING');

    try {
      const result = await this.api.createInstance(this.account.cookie);

      const newInstance = {
        accountId: this.account.id,
        status: result.status,
        expiresAt: result.expireTime || (Date.now() + 3600_000),
        createdAt: Date.now(),
      };
      this.instance = newInstance;

      this.setState('READY', {
        createdAt: AccountWorker.sandboxCreatedAt(result),
        expiresAt: newInstance.expiresAt,
      });
      console.log(`✅ [${this.account.id}] 新实例就绪 (status=${result.status})`);

      if (this.deployer) {
        try {
          await this.deployCurrentInstance();
        } catch (err) {
          const deployResult = err?.deployResult || {};
          const adopted = this.adoptActiveTunnel({
            deployMode: deployResult.deployMode || 'tunnel',
            runId: deployResult.runId || null,
            deployTimeline: Array.isArray(deployResult.timeline) ? deployResult.timeline : [],
            responseText: deployResult.responseText || null,
          });
          if (adopted) return;

          console.error(`❌ [${this.account.id}] 新实例部署失败:`, err.message);
          this.instance = oldInstance;
          this.setState(oldState || 'ACTIVE', {
            lastDeployError: deployResult.lastError || err.message,
            verified: oldState === 'ACTIVE',
            deployStage: deployResult.stage || 'unknown',
            deployStatus: deployResult.stageStatus || 'failed',
            retryable: !!deployResult.retryable,
            failureType: deployResult.failureType || 'unknown',
            confirmationSource: deployResult.confirmationSource || null,
            responseText: deployResult.responseText || null,
            deployTimeline: Array.isArray(deployResult.timeline) ? deployResult.timeline : [],
          });
          return;
        }
      }

      // 销毁旧实例
      // 注意: destroyInstance API 基于 cookie 操作，无法指定 instanceId。
      // 守卫：仅在 this.instance 仍指向刚创建的实例时才执行销毁，
      // 避免在并发 renew 或平台自动替换后误销毁新实例。
      if (oldInstance && this.instance === newInstance) {
        try {
          await this.api.destroyInstance(this.account.cookie);
          console.log(`🗑️ [${this.account.id}] 旧实例已销毁`);
        } catch (err) {
          console.warn(`⚠️ [${this.account.id}] 销毁旧实例失败:`, err.message);
        }
      }
    } catch (err) {
      console.error(`❌ [${this.account.id}] 续期失败:`, err.message);
      this.instance = oldInstance;
      if (oldInstance) {
        this.setState(oldState || 'ACTIVE');
      } else {
        this.setState('FAILED', { verified: false, healthOk: false, lastDeployError: err.message });
        this.cooldownUntil = Date.now() + (this.config.retryBaseDelay || 30_000);
      }
    }
  }

  async pause() {
    console.log(`⏸️ [${this.account.id}] 暂停`);
    this.setState('PAUSED', {
      retryable: false,
      failureType: 'paused',
    });
  }

  async manualStop() {
    console.log(`🛑 [${this.account.id}] 手动停止`);

    try {
      await this.api.destroyInstance(this.account.cookie);
      console.log(`🗑️ [${this.account.id}] 实例已销毁`);
    } catch (err) {
      console.warn(`⚠️ [${this.account.id}] 销毁实例失败（可能已不存在）:`, err.message);
    }

    this.instance = null;
    this.setState('MANUAL_STOPPED', {
      verified: false,
      healthOk: false,
      tunnel: null,
      tunnelAccountId: null,
      tunnelRunId: null,
      tunnelConnectedAt: null,
      retryable: false,
      failureType: 'manual_stop',
      lastManualStopAt: new Date().toISOString(),
      destroyedAt: new Date().toISOString(),
      lastDeployError: null,
      deployStage: null,
      deployStatus: null,
    });
    this.cooldownUntil = 0;
  }

  async recover() {
    this.setState('RECOVERING');

    try {
      if (this.deployer) {
        await this.deployCurrentInstance();
        return;
      }

      this.setState('FAILED', { verified: false, healthOk: false, lastDeployError: null });
      this.cooldownUntil = Date.now() + (this.config.retryBaseDelay || 30_000);
    } catch (err) {
      console.error(`❌ [${this.account.id}] 恢复失败:`, err.message);
      const deployResult = err?.deployResult || {};
      this.registry.updateInstanceState(this.account.id, {
        lastDeployError: deployResult.lastError || err.message,
        deployStage: deployResult.stage || 'unknown',
        deployStatus: deployResult.stageStatus || 'failed',
        retryable: !!deployResult.retryable,
        failureType: deployResult.failureType || 'unknown',
        confirmationSource: deployResult.confirmationSource || null,
        responseText: deployResult.responseText || null,
        deployTimeline: Array.isArray(deployResult.timeline) ? deployResult.timeline : [],
      });
      this.setState('CREATING');
      await this.create();
    }
  }
}

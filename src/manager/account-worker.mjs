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

  async deployCurrentInstance() {
    if (!this.deployer) return null;

    this.setState('DEPLOYING', {
      deployMode: 'skill-proxy',
      verified: false,
      healthOk: false,
      lastDeployAt: new Date().toISOString(),
      lastDeployError: null,
      deployTimeline: [],
      confirmationSource: null,
      responseText: null,
    });

    const result = await this.deployer.deploy(this.account);

    const deployMeta = {
      deployMode: result?.deployMode || 'skill-proxy',
      proxyUrl: result?.proxyUrl || null,
      created: !!result?.created,
      started: !!result?.started,
      healthOk: !!result?.healthOk,
      verified: !!result?.verified,
      lastDeployAt: new Date().toISOString(),
      lastVerifiedAt: result?.verified ? new Date().toISOString() : null,
      lastDeployError: null,
      deployStage: result?.stage || (result?.verified ? 'complete' : 'health'),
      deployStatus: result?.stageStatus || (result?.verified ? 'ok' : 'failed'),
      retryable: result?.retryable !== false,
      failureType: result?.failureType || null,
      confirmationSource: result?.confirmationSource || null,
      responseText: result?.responseText || null,
      deployTimeline: Array.isArray(result?.timeline) ? result.timeline : [],
    };

    if (result?.verified) {
      this.setState('ACTIVE', deployMeta);
      console.log(`✅ [${this.account.id}] 代理部署完成并验证可用 (${result.proxyUrl})`);
      return result;
    }

    this.setState('DEPLOYED_UNVERIFIED', deployMeta);
    console.log(`⚠️ [${this.account.id}] 代理部署完成，但尚未验证为 ACTIVE (${result?.proxyUrl || 'unknown'})`);
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

      this.setState('READY');
      console.log(`✅ [${this.account.id}] 实例就绪 (status=${result.status}, expires=${new Date(this.instance.expiresAt).toLocaleString()})`);

      if (this.deployer) {
        try {
          await this.deployCurrentInstance();
        } catch (err) {
          console.error(`❌ [${this.account.id}] 部署失败:`, err.message);
          const deployResult = err?.deployResult || {};
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

      this.instance = {
        accountId: this.account.id,
        status: result.status,
        expiresAt: result.expireTime || (Date.now() + 3600_000),
        createdAt: Date.now(),
      };

      this.setState('READY');
      console.log(`✅ [${this.account.id}] 新实例就绪 (status=${result.status})`);

      if (this.deployer) {
        try {
          await this.deployCurrentInstance();
        } catch (err) {
          console.error(`❌ [${this.account.id}] 新实例部署失败:`, err.message);
          const deployResult = err?.deployResult || {};
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
      if (oldInstance) {
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

/**
 * Manager 调度器 — 状态机驱动的实例生命周期管理
 *
 * 核心调度循环：定期检查每个账号的状态，执行相应操作。
 * 部署方式：skill-proxy（不再支持旧 Agent WS 回连）
 *
 * ACTIVE 必须建立在显式验证结果（verified / healthOk）之上
 * DEPLOYED_UNVERIFIED 代表基础部署完成，但仍未证明可稳定承载流量
 */

export class Scheduler {
  /**
   * @param {import('./account-worker.mjs').AccountWorker[]} workers
   * @param {import('../gateway/registry.mjs').Registry} registry
   * @param {object} opts
   */
  constructor(workers, registry, opts = {}) {
    this.workers = workers;
    this.registry = registry;
    this.checkInterval = opts.checkInterval || 60_000;
    this.renewBefore = opts.renewBefore || 300_000; // 5 分钟
    this.running = false;
    this.timer = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    console.log(`⏰ 调度器启动 (间隔 ${this.checkInterval / 1000}s, 续期阈值 ${this.renewBefore / 1000}s)`);

    // 首次 tick 加随机 jitter，避免多个 worker 同时触发（thundering herd）
    const jitter = Math.random() * this.checkInterval * 0.15;
    await this._sleep(jitter);

    while (this.running) {
      await this.tick();
      if (!this.running) break;
      await this._sleep(this.checkInterval);
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick() {
    for (const worker of this.workers) {
      try {
        await this._tickWorker(worker);
      } catch (err) {
        console.error(`❌ 调度错误 [${worker.account.id}]:`, err.message);
      }
    }
  }

  async _tickWorker(worker) {
    const { state, instance } = worker.snapshot();
    const instanceState = this.registry.getInstanceState(worker.account.id) || {};
    const failureType = instanceState.failureType || 'unknown';
    const retryable = instanceState.retryable !== false;
    const deployStage = instanceState.deployStage || null;

    switch (state) {
      case 'NONE':
      case 'DESTROYED':
      case 'EXPIRED':
        console.log(`🔄 [${worker.account.id}] ${state} → 创建实例`);
        await worker.create();
        break;

      case 'CREATING':
      case 'DEPLOYING':
      case 'RECOVERING':
        // 等下次检查
        break;

      case 'READY':
      case 'DEPLOYED_UNVERIFIED':
        // 检查 tunnel 模式：如果 tunnel 已连接，直接升级为 ACTIVE
        if (state === 'DEPLOYED_UNVERIFIED' && instanceState.tunnel) {
          if (!instanceState.verified || !instanceState.healthOk) {
            console.log(`✅ [${worker.account.id}] Tunnel 已连接 → 标记为 ACTIVE`);
            this.registry.updateInstanceState(worker.account.id, {
              verified: true,
              healthOk: true,
              status: 'ACTIVE',
              lastVerifiedAt: new Date().toISOString(),
            });
          }
          break;
        }

        // 检查实例是否还存活
        try {
          const status = await worker.api.getStatus(worker.account.cookie);
          if (status.status !== 'AVAILABLE') {
            console.log(`⚠️ [${worker.account.id}] 实例状态: ${status.status} → 重建`);
            await worker.create();
            break;
          }
          if (worker.instance && status.expireTime) {
            worker.instance.expiresAt = status.expireTime;
          }
          this.registry.updateInstanceState(worker.account.id, { createdAt: worker.constructor.sandboxCreatedAt(status) });
        } catch (err) {
          console.warn(`⚠️ [${worker.account.id}] 状态检查失败:`, err.message);
        }

        // 续期检查
        if (instance && instance.remaining < this.renewBefore) {
          console.log(`🔄 [${worker.account.id}] 剩余 ${Math.round(instance.remaining / 1000)}s → 续期`);
          await worker.renew();
          break;
        }

        // 长时间未验证 → 触发恢复
        if (state === 'DEPLOYED_UNVERIFIED' && instanceState.lastDeployAt) {
          const unverifiedAgeMs = Date.now() - new Date(instanceState.lastDeployAt).getTime();
          if (Number.isFinite(unverifiedAgeMs) && unverifiedAgeMs > Math.max(this.checkInterval * 2, 120_000)) {
            if (failureType === 'refused') {
              console.log(`⏸️ [${worker.account.id}] DEPLOYED_UNVERIFIED 且最近为策略拒绝 → 暂不自动恢复`);
              break;
            }
            console.log(`⚠️ [${worker.account.id}] 长时间停留在 DEPLOYED_UNVERIFIED (${deployStage || 'unknown'}) → 触发恢复`);
            await worker.recover();
          }
        }
        break;

      case 'ACTIVE':
        // ACTIVE 要求已有显式验证结果
        if (!instanceState.verified || !instanceState.healthOk) {
          console.log(`⚠️ [${worker.account.id}] ACTIVE 但缺少验证元数据 → 恢复`);
          await worker.recover();
          break;
        }

        // Tunnel 模式：连接即健康，不需要 HTTP 状态检查
        if (instanceState.tunnel) {
          if (instanceState.tunnel.readyState !== 1) { // WebSocket.CLOSED
            console.log(`⚠️ [${worker.account.id}] Tunnel 连接已断开 → 恢复`);
            await worker.recover();
          }
          break;
        }

        // HTTP 模式：检查实例是否还存活
        try {
          const status = await worker.api.getStatus(worker.account.cookie);
          if (status.status !== 'AVAILABLE') {
            console.log(`⚠️ [${worker.account.id}] 实例状态: ${status.status} → 重建`);
            await worker.create();
            break;
          }
          if (worker.instance && status.expireTime) {
            worker.instance.expiresAt = status.expireTime;
          }
          this.registry.updateInstanceState(worker.account.id, { createdAt: worker.constructor.sandboxCreatedAt(status) });
        } catch (err) {
          console.warn(`⚠️ [${worker.account.id}] 状态检查失败:`, err.message);
        }

        // 续期检查
        if (instance && instance.remaining < this.renewBefore) {
          console.log(`🔄 [${worker.account.id}] 剩余 ${Math.round(instance.remaining / 1000)}s → 续期`);
          await worker.renew();
          break;
        }
        break;

      case 'MANUAL_STOPPED':
      case 'PAUSED':
        // Human-initiated stop; scheduler must not auto-create or recover.
        break;

      case 'FAILED':
        if (!retryable) {
          console.log(`⏸️ [${worker.account.id}] FAILED(${failureType}) 且不可重试 → 保持人工处理`);
          break;
        }

        if (failureType === 'refused') {
          console.log(`⏸️ [${worker.account.id}] 部署被远端策略拒绝 → 暂不自动重试`);
          break;
        }

        if (failureType === 'upstream_unavailable') {
          if (instance && instance.cooldownElapsed) {
            console.log(`🔄 [${worker.account.id}] 上游资源恢复窗口已到 → 重试创建`);
            await worker.create();
          }
          break;
        }

        if (failureType === 'disconnected') {
          if (instance) {
            console.log(`🔄 [${worker.account.id}] 部署链路断线 (${deployStage || 'unknown'}) → 优先恢复当前实例`);
            await worker.recover();
          }
          break;
        }

        if (failureType === 'timeout') {
          if (instance && instance.cooldownElapsed) {
            console.log(`🔄 [${worker.account.id}] 部署超时 → 冷却后恢复重试`);
            await worker.recover();
          }
          break;
        }

        if (instance && instance.cooldownElapsed) {
          console.log(`🔄 [${worker.account.id}] 冷却结束 → 重试创建`);
          await worker.create();
        }
        break;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => {
      this.timer = setTimeout(resolve, ms);
    });
  }
}

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

function now() {
  return Date.now();
}

function normalizePriority(value) {
  return Number.isFinite(value) ? value : 100;
}

function normalizeInflight(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 原子写入：先写临时文件再 rename，避免并发读到半写状态
 */
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

export function createRegistry(registryPath) {
  function ensureParent() {
    mkdirSync(dirname(registryPath), { recursive: true });
  }

  function empty() {
    return { updatedAt: null, upstreams: [] };
  }

  function load() {
    try {
      return existsSync(registryPath)
        ? JSON.parse(readFileSync(registryPath, 'utf-8'))
        : empty();
    } catch {
      return empty();
    }
  }

  function save(data) {
    ensureParent();
    data.updatedAt = new Date().toISOString();
    atomicWrite(registryPath, JSON.stringify(data, null, 2) + '\n');
  }

  function upsert(upstream) {
    const data = load();
    data.upstreams = Array.isArray(data.upstreams) ? data.upstreams : [];
    const idx = data.upstreams.findIndex(u => u.accountId === upstream.accountId);
    const next = {
      inflight: 0,
      lastOkAt: null,
      lastErrorAt: null,
      failureCount: 0,
      cooldownUntil: null,
      rateLimitedUntil: null,
      lastSyncAt: now(),
      successCount: 0,
      avgResponseMs: 0,
      ...upstream,
    };
    if (idx >= 0) {
      data.upstreams[idx] = {
        ...data.upstreams[idx],
        ...next,
      };
    } else {
      data.upstreams.push(next);
    }
    save(data);
    return data;
  }

  function remove(accountId) {
    const data = load();
    data.upstreams = (data.upstreams || []).filter(u => u.accountId !== accountId);
    save(data);
    return data;
  }

  function patch(accountId, patchData) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (!found) return data;
    Object.assign(found, patchData, { lastSyncAt: now() });
    save(data);
    return data;
  }

  function markInflight(accountId, delta) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (found) {
      found.inflight = Math.max(0, normalizeInflight(found.inflight) + delta);
      found.lastSyncAt = now();
      save(data);
    }
    return data;
  }

  function markSuccess(accountId, extra = {}) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (!found) return data;

    const successCount = (found.successCount || 0) + 1;
    const prevAvg = found.avgResponseMs || 0;
    const responseMs = extra.responseMs || 0;
    // 指数移动平均
    const avgResponseMs = responseMs > 0
      ? Math.round(prevAvg * 0.7 + responseMs * 0.3)
      : prevAvg;

    Object.assign(found, {
      healthy: true,
      lastOkAt: now(),
      lastError: null,
      lastErrorAt: null,
      failureCount: 0,
      cooldownUntil: null,
      rateLimitedUntil: null,
      successCount,
      avgResponseMs,
      lastSyncAt: now(),
      ...extra,
    });
    delete found.responseMs; // 不持久化临时字段
    save(data);
    return data;
  }

  function markFailure(accountId, error, options = {}) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (!found) return data;
    const failureCount = (found.failureCount || 0) + 1;
    const cooldownMs = options.cooldownMs ?? Math.min(120_000, failureCount * 10_000);

    const patch = {
      healthy: false,
      lastError: typeof error === 'string' ? error : error?.message || 'unknown error',
      lastErrorAt: now(),
      failureCount,
      cooldownUntil: now() + cooldownMs,
      lastSyncAt: now(),
    };
    if (options.statusCode) patch.lastStatusCode = options.statusCode;

    // 429 限流：额外设置 rateLimitedUntil，冷却时间更长
    if (options.statusCode === 429) {
      const rateLimitCooldown = Math.min(300_000, failureCount * 30_000); // 最长 5 分钟
      patch.rateLimitedUntil = now() + rateLimitCooldown;
      patch.cooldownUntil = Math.max(patch.cooldownUntil, patch.rateLimitedUntil);
    }

    Object.assign(found, patch);
    save(data);
    return data;
  }

  /**
   * 选择候选 upstreams（过滤不健康、冷却中、限流中的）
   */
  function listCandidates() {
    const data = load();
    const current = now();
    return (data.upstreams || [])
      .filter(u => u.baseUrl)
      .filter(u => u.healthy)
      .filter(u => !u.cooldownUntil || u.cooldownUntil <= current)
      .filter(u => !u.rateLimitedUntil || u.rateLimitedUntil <= current);
  }

  /**
   * 加权轮转选路
   *
   * 权重计算：
   *   baseWeight = 1000 / priority  (优先级越低数字越大，权重越高)
   *   inflightPenalty = inflight * 50  (并发越高，权重越低)
   *   failurePenalty = failureCount * 100  (最近失败越多，权重越低)
   *   rateLimitPenalty = 500 (如果最近被限流过，额外扣分)
   *   responseBonus = max(0, 200 - avgResponseMs / 100)  (响应快加分)
   *
   * 最终按权重随机选择（非纯随机，权重越高概率越大）
   */
  function chooseWeighted() {
    const candidates = listCandidates();
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const current = now();
    const scored = candidates.map(u => {
      const priority = normalizePriority(u.priority);
      const inflight = normalizeInflight(u.inflight);
      const failureCount = u.failureCount || 0;
      const avgResponseMs = u.avgResponseMs || 0;
      const recentlyRateLimited = u.rateLimitedUntil && (u.rateLimitedUntil - current) > -60_000;

      let score = 1000 / Math.max(1, priority);
      score -= inflight * 50;
      score -= failureCount * 100;
      if (recentlyRateLimited) score -= 500;
      score += Math.max(0, 200 - avgResponseMs / 100);

      return { upstream: u, score: Math.max(1, score) };
    });

    // 按权重随机选择
    const totalScore = scored.reduce((sum, s) => sum + s.score, 0);
    let roll = Math.random() * totalScore;
    for (const s of scored) {
      roll -= s.score;
      if (roll <= 0) return s.upstream;
    }
    return scored[scored.length - 1].upstream;
  }

  /**
   * 向后兼容：简单选第一个
   */
  function choose() {
    const candidates = listCandidates();
    return candidates[0] || null;
  }

  return {
    registryPath,
    load,
    save,
    upsert,
    remove,
    patch,
    markInflight,
    markSuccess,
    markFailure,
    listCandidates,
    choose,
    chooseWeighted,
  };
}

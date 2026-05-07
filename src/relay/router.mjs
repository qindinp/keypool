/**
 * Relay 路由器 — 加权选路 + 故障转移
 *
 * 选路策略：
 *   1. 优先选高权重节点（权重由 priority、并发数、失败率、响应速度综合计算）
 *   2. 被 429 限流的节点自动降权或跳过
 *   3. fallback 时排除已失败的节点，按权重依次尝试
 */

/**
 * 选择一个上游节点（加权轮转）
 * @param {import('../manager/registry.mjs').Registry} registry
 * @returns {object|null}
 */
export function pickUpstream(registry) {
  return registry.chooseWeighted();
}

/**
 * 列出 fallback 候选（排除已知失败的节点）
 * @param {import('../manager/registry.mjs').Registry} registry
 * @param {string[]} excludedAccountIds - 已失败的账号 ID
 * @returns {object[]}
 */
export function listFallbackUpstreams(registry, excludedAccountIds = []) {
  const excluded = new Set(excludedAccountIds);
  const candidates = registry.listCandidates().filter(item => !excluded.has(item.accountId));
  // 按权重排序（高权重在前）
  return sortCandidates(candidates);
}

/**
 * 对候选节点按综合评分排序（高分在前）
 */
function sortCandidates(candidates) {
  const now = Date.now();
  return [...candidates].sort((a, b) => {
    const scoreA = computeScore(a, now);
    const scoreB = computeScore(b, now);
    return scoreB - scoreA;
  });
}

function computeScore(upstream, current) {
  const priority = Number.isFinite(upstream.priority) ? upstream.priority : 100;
  const inflight = Number.isFinite(upstream.inflight) ? upstream.inflight : 0;
  const failureCount = upstream.failureCount || 0;
  const avgResponseMs = upstream.avgResponseMs || 0;
  const recentlyRateLimited = upstream.rateLimitedUntil && (upstream.rateLimitedUntil - current) > -60_000;

  let score = 1000 / Math.max(1, priority);
  score -= inflight * 50;
  score -= failureCount * 100;
  if (recentlyRateLimited) score -= 500;
  score += Math.max(0, 200 - avgResponseMs / 100);

  return Math.max(1, score);
}

/**
 * Admin 数据构建器
 * - buildOverview: 总览数据
 * - buildAgents: Agent 列表
 * - buildInstances: 实例状态
 * - loadAccountsSummary: 账号摘要（不含原始 cookie）
 */

import { existsSync, readFileSync } from 'node:fs';
import { accountsPath } from './audit.mjs';
import { buildManagerStatus } from './handlers.mjs';

export function buildOverview(registry, req, context = {}) {
  const agents = buildAgents(registry);
  const instances = buildInstances(registry);
  const accounts = loadAccountsSummary();
  const host = req?.headers?.host || '127.0.0.1:9300';
  const manager = buildManagerStatus(context.manager);

  const instanceList = Object.values(instances);
  const activeInstances = instanceList.filter(item => item.status === 'ACTIVE').length;
  const creatingInstances = instanceList.filter(item => ['CREATING', 'READY', 'DEPLOYING', 'DEPLOYED_UNVERIFIED', 'RECOVERING'].includes(item.status)).length;
  const failedInstances = instanceList.filter(item => item.status === 'FAILED').length;
  const verifiedInstances = instanceList.filter(item => item.verified || item.status === 'ACTIVE').length;

  return {
    service: {
      status: verifiedInstances > 0 || agents.some(item => item.healthy) ? 'ok' : 'degraded',
      accessUrl: `http://${host}/v1`,
      adminUrl: `http://${host}/admin`,
      healthUrl: `http://${host}/health`,
      generatedAt: new Date().toISOString(),
      manager,
    },
    metrics: {
      agents: agents.length,
      healthyAgents: agents.filter(item => item.healthy).length,
      inflight: agents.reduce((sum, item) => sum + item.inflight, 0),
      accounts: accounts.accounts.length,
      enabledAccounts: accounts.accounts.filter(item => item.enabled).length,
      instances: instanceList.length,
      activeInstances,
      verifiedInstances,
      creatingInstances,
      failedInstances,
      missingAgentBindings: instanceList.filter(item => !item.agentId).length,
      retryableFailures: instanceList.filter(item => item.status === 'FAILED' && item.retryable).length,
      historyConfirmedStages: instanceList.filter(item => item.confirmationSource === 'history').length,
    },
  };
}

export function buildAgents(registry) {
  const now = Date.now();
  return registry.getAll().map(entry => ({
    agentId: entry.agentId,
    instanceId: entry.instanceId,
    accountId: entry.accountId,
    models: entry.models,
    connectedAt: entry.connectedAt,
    connectedAgoMs: now - entry.connectedAt,
    healthy: entry.healthy,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
    inflight: entry.inflight,
    avgLatency: entry.successCount > 0 ? Math.round(entry.totalLatency / entry.successCount) : 0,
    lastUsed: entry.lastUsed || 0,
  }));
}

export function buildInstances(registry) {
  const result = {};
  for (const [accountId, state] of registry.getAllInstances()) {
    result[accountId] = {
      accountId,
      status: state?.status || 'NONE',
      agentId: state?.agentId || null,
      currentTailnetIpUrl: state?.currentTailnetIpUrl || null,
      currentTailnetUrl: state?.currentTailnetUrl || null,
      currentShareUrl: state?.currentShareUrl || null,
      currentLocalUrl: state?.currentLocalUrl || null,
      lastDeployAt: state?.lastDeployAt || null,
      lastHealthError: state?.lastHealthError || null,
      lastDeployError: state?.lastDeployError || null,
      lastVerifiedAt: state?.lastVerifiedAt || null,
      verified: !!state?.verified,
      healthOk: !!state?.healthOk,
      deployMode: state?.deployMode || null,
      deployStage: state?.deployStage || null,
      deployStatus: state?.deployStatus || null,
      failureType: state?.failureType || null,
      retryable: !!state?.retryable,
      confirmationSource: state?.confirmationSource || null,
      responseText: state?.responseText || null,
      deployTimeline: Array.isArray(state?.deployTimeline) ? state.deployTimeline : [],
      proxyUrl: state?.proxyUrl || null,
      agentOnline: !!state?.agentOnline,
      deployCount: state?.deployCount || 0,
      createdAt: state?.createdAt || null,
      destroyedAt: state?.destroyedAt || null,
    };
  }
  return result;
}

export function loadAccountsSummary() {
  const fallback = { path: accountsPath, exists: false, accounts: [] };
  if (!existsSync(accountsPath)) return fallback;

  try {
    const raw = JSON.parse(readFileSync(accountsPath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
    return {
      path: accountsPath,
      exists: true,
      accounts: list.map((item, index) => ({
        id: String(item?.id || item?.name || `account-${index + 1}`),
        name: String(item?.name || item?.id || `account-${index + 1}`),
        enabled: item?.enabled !== false,
        priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : 100,
        tags: Array.isArray(item?.tags) ? item.tags : [],
        hasCookie: typeof item?.cookie === 'string' && item.cookie.trim().length > 0,
        hasCookieFile: typeof item?.cookieFile === 'string' && item.cookieFile.trim().length > 0,
        weight: Number.isFinite(Number(item?.weight)) ? Math.max(0, Math.round(Number(item.weight))) : 100,
      })),
    };
  } catch (error) {
    return {
      ...fallback,
      exists: true,
      error: error?.message || 'accounts.json 解析失败',
    };
  }
}

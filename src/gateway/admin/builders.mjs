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
      status: verifiedInstances > 0 ? 'ok' : 'degraded',
      accessUrl: `http://${host}/v1`,
      adminUrl: `http://${host}/admin`,
      healthUrl: `http://${host}/health`,
      generatedAt: new Date().toISOString(),
      manager,
    },
    metrics: {
      accounts: accounts.accounts.length,
      enabledAccounts: accounts.accounts.filter(item => item.enabled).length,
      instances: instanceList.length,
      activeInstances,
      verifiedInstances,
      creatingInstances,
      failedInstances,
      retryableFailures: instanceList.filter(item => item.status === 'FAILED' && item.retryable).length,
    },
  };
}

export function buildAgents(registry) {
  const result = [];
  for (const [accountId, state] of registry.getAllInstances()) {
    if (!state?.tunnel) continue;
    result.push({
      accountId,
      status: state.status || 'NONE',
      connectedAt: state.tunnelConnectedAt || null,
      verified: !!state.verified,
      healthOk: !!state.healthOk,
    });
  }
  return result;
}

export function buildInstances(registry) {
  const result = {};
  for (const [accountId, state] of registry.getAllInstances()) {
    result[accountId] = {
      accountId,
      status: state?.status || 'NONE',
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
      deployTimeline: Array.isArray(state?.deployTimeline) ? state.deployTimeline : [],
      proxyUrl: state?.proxyUrl || null,
      tunnelConnectedAt: state?.tunnelConnectedAt || null,
      tunnelRunId: state?.tunnelRunId || null,
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

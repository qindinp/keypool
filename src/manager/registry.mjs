import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
    writeFileSync(registryPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
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
      lastSyncAt: now(),
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
    data.updatedAt = new Date().toISOString();
    save(data);
    return data;
  }

  function remove(accountId) {
    const data = load();
    data.upstreams = (data.upstreams || []).filter(u => u.accountId !== accountId);
    data.updatedAt = new Date().toISOString();
    save(data);
    return data;
  }

  function patch(accountId, patchData) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (!found) return data;
    Object.assign(found, patchData, { lastSyncAt: now() });
    data.updatedAt = new Date().toISOString();
    save(data);
    return data;
  }

  function markInflight(accountId, delta) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (found) {
      found.inflight = Math.max(0, normalizeInflight(found.inflight) + delta);
      found.lastSyncAt = now();
      data.updatedAt = new Date().toISOString();
      save(data);
    }
    return data;
  }

  function markSuccess(accountId, extra = {}) {
    return patch(accountId, {
      healthy: true,
      lastOkAt: now(),
      lastError: null,
      lastErrorAt: null,
      failureCount: 0,
      cooldownUntil: null,
      ...extra,
    });
  }

  function markFailure(accountId, error, options = {}) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (!found) return data;
    const failureCount = normalizeInflight(found.failureCount) + 1;
    const cooldownMs = options.cooldownMs ?? Math.min(120_000, failureCount * 10_000);
    found.healthy = false;
    found.lastError = typeof error === 'string' ? error : error?.message || 'unknown error';
    found.lastErrorAt = now();
    found.failureCount = failureCount;
    found.cooldownUntil = now() + cooldownMs;
    found.lastSyncAt = now();
    if (options.statusCode) found.lastStatusCode = options.statusCode;
    data.updatedAt = new Date().toISOString();
    save(data);
    return data;
  }

  function listCandidates() {
    const data = load();
    const current = now();
    return (data.upstreams || [])
      .filter(u => u.baseUrl)
      .filter(u => u.healthy)
      .filter(u => !u.cooldownUntil || u.cooldownUntil <= current)
      .sort((a, b) => {
        const pa = normalizePriority(a.priority);
        const pb = normalizePriority(b.priority);
        if (pa !== pb) return pa - pb;
        const ia = normalizeInflight(a.inflight);
        const ib = normalizeInflight(b.inflight);
        if (ia !== ib) return ia - ib;
        return (b.lastOkAt || 0) - (a.lastOkAt || 0);
      });
  }

  function choose() {
    return listCandidates()[0] || null;
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
  };
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function now() {
  return Date.now();
}

export function createRegistry(registryPath) {
  function ensureParent() {
    mkdirSync(dirname(registryPath), { recursive: true });
  }

  function load() {
    try {
      return existsSync(registryPath)
        ? JSON.parse(readFileSync(registryPath, 'utf-8'))
        : { updatedAt: null, upstreams: [] };
    } catch {
      return { updatedAt: null, upstreams: [] };
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

  function markInflight(accountId, delta) {
    const data = load();
    const found = (data.upstreams || []).find(u => u.accountId === accountId);
    if (found) {
      found.inflight = Math.max(0, (found.inflight || 0) + delta);
      found.lastSyncAt = now();
      data.updatedAt = new Date().toISOString();
      save(data);
    }
    return data;
  }

  function choose() {
    const data = load();
    const candidates = (data.upstreams || []).filter(u => u.healthy && u.baseUrl);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const pa = Number.isFinite(a.priority) ? a.priority : 100;
      const pb = Number.isFinite(b.priority) ? b.priority : 100;
      if (pa !== pb) return pa - pb;
      const ia = Number.isFinite(a.inflight) ? a.inflight : 0;
      const ib = Number.isFinite(b.inflight) ? b.inflight : 0;
      if (ia !== ib) return ia - ib;
      return (b.lastOkAt || 0) - (a.lastOkAt || 0);
    });
    return candidates[0];
  }

  return { registryPath, load, save, upsert, remove, markInflight, choose };
}

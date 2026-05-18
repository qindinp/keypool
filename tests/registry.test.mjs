import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/gateway/registry.mjs';

function createInstance(overrides = {}) {
  return {
    accountId: 'default',
    verified: true,
    status: 'ACTIVE',
    healthOk: true,
    tunnel: { readyState: 1 },
    proxyUrl: null,
    baseUrl: null,
    localUrl: null,
    priority: 100,
    weight: 10,
    lastVerifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('registry: chooseVerifiedUpstream returns null when no upstreams', () => {
  const registry = new Registry();
  assert.equal(registry.chooseVerifiedUpstream('mimo-v2.5-pro'), null);
});

test('registry: chooseVerifiedUpstream returns single upstream', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1' }));

  const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro');
  assert.equal(chosen.accountId, 'a1');
});

test('registry: chooseVerifiedUpstream excludes accountIds', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1' }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2' }));

  const exclude = new Set(['a1']);
  const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro', { excludeAccountIds: exclude });
  assert.equal(chosen.accountId, 'a2');
});

test('registry: chooseVerifiedUpstream returns null when all excluded', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1' }));

  const exclude = new Set(['a1']);
  const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro', { excludeAccountIds: exclude });
  assert.equal(chosen, null);
});

test('registry: getVerifiedUpstreams filters healthOk=false', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', healthOk: true }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', healthOk: false, lastHealthErrorAt: new Date().toISOString() }));

  const upstreams = registry.getVerifiedUpstreams('mimo-v2.5-pro');
  assert.equal(upstreams.length, 1);
  assert.equal(upstreams[0].accountId, 'a1');
});

test('registry: getVerifiedUpstreams recovers healthOk after 60s', () => {
  const registry = new Registry();
  const oldTime = new Date(Date.now() - 61_000).toISOString();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', healthOk: false, lastHealthErrorAt: oldTime }));

  const upstreams = registry.getVerifiedUpstreams('mimo-v2.5-pro');
  assert.equal(upstreams.length, 1, 'should recover after 60s');
});

test('registry: getVerifiedUpstreams excludes unverified', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', verified: true }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', verified: false }));

  const upstreams = registry.getVerifiedUpstreams('mimo-v2.5-pro');
  assert.equal(upstreams.length, 1);
  assert.equal(upstreams[0].accountId, 'a1');
});

test('registry: getVerifiedUpstreams sorts by priority', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', priority: 200 }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', priority: 50 }));

  const upstreams = registry.getVerifiedUpstreams('mimo-v2.5-pro');
  assert.equal(upstreams[0].accountId, 'a2', 'lower priority number first');
  assert.equal(upstreams[1].accountId, 'a1');
});

test('registry: weighted random with equal weights distributes roughly evenly', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', weight: 10 }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', weight: 10 }));

  const counts = { a1: 0, a2: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro');
    counts[chosen.accountId]++;
  }

  // With equal weights (10+10=20 each), expect ~50% each. Allow 5% margin.
  const ratio1 = counts.a1 / N;
  const ratio2 = counts.a2 / N;
  assert.ok(ratio1 > 0.45 && ratio1 < 0.55, `a1 ratio ${ratio1.toFixed(3)} should be ~0.5`);
  assert.ok(ratio2 > 0.45 && ratio2 < 0.55, `a2 ratio ${ratio2.toFixed(3)} should be ~0.5`);
});

test('registry: weighted random with different weights skews distribution', () => {
  const registry = new Registry();
  // a1: weight 30 + BASE_WEIGHT 10 = 40; a2: weight 10 + BASE_WEIGHT 10 = 20
  // Expected: a1 ~67%, a2 ~33%
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', weight: 30 }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', weight: 10 }));

  const counts = { a1: 0, a2: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro');
    counts[chosen.accountId]++;
  }

  const ratio1 = counts.a1 / N;
  // Expected: 40/60 ≈ 0.667. Allow 5% margin.
  assert.ok(ratio1 > 0.6 && ratio1 < 0.73, `a1 ratio ${ratio1.toFixed(3)} should be ~0.667`);
});

test('registry: weighted random with weight=0 still has base probability', () => {
  const registry = new Registry();
  // a1: weight 0 + BASE_WEIGHT 10 = 10; a2: weight 90 + BASE_WEIGHT 10 = 100
  // Expected: a1 ~9%, a2 ~91%
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', weight: 0 }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', weight: 90 }));

  const counts = { a1: 0, a2: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro');
    counts[chosen.accountId]++;
  }

  const ratio1 = counts.a1 / N;
  // weight=0 still gets 10/(10+100) ≈ 0.091. Allow wide margin.
  assert.ok(ratio1 > 0.03 && ratio1 < 0.15, `a1 ratio ${ratio1.toFixed(3)} should be ~0.09`);
  assert.ok(counts.a1 > 0, 'weight=0 upstream should still be selected sometimes');
});

test('registry: higher priority tier always chosen before lower', () => {
  const registry = new Registry();
  // a1: priority 200, weight 100; a2: priority 50, weight 1
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', priority: 200, weight: 100 }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', priority: 50, weight: 1 }));

  const N = 100;
  for (let i = 0; i < N; i++) {
    const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro');
    assert.equal(chosen.accountId, 'a2', 'lower priority number always wins');
  }
});

test('registry: markProxyFailure sets healthOk=false', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1' }));

  registry.markProxyFailure('a1', 'connection refused');
  const state = registry.getInstanceState('a1');
  assert.equal(state.healthOk, false);
  assert.equal(state.lastHealthError, 'connection refused');
  assert.ok(state.lastHealthErrorAt);
});

test('registry: markProxySuccess resets healthOk and consecutiveFailures', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', healthOk: false, consecutiveFailures: 3 }));

  registry.markProxySuccess('a1', 150);
  const state = registry.getInstanceState('a1');
  assert.equal(state.healthOk, true);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastProxyLatencyMs, 150);
});

test('registry: markProxyUpstreamError does not affect healthOk', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', healthOk: true }));

  registry.markProxyUpstreamError('a1', 400, 'bad request');
  const state = registry.getInstanceState('a1');
  assert.equal(state.healthOk, true, 'healthOk should remain true for upstream business errors');
  assert.equal(state.lastUpstreamStatus, 400);
});

test('registry: getHealthyUpstreamCount returns correct count', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', healthOk: true }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', healthOk: false, lastHealthErrorAt: new Date().toISOString() }));

  assert.equal(registry.getHealthyUpstreamCount('mimo-v2.5-pro'), 1);
});

test('registry: model param does not filter (instances lack model info)', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1' }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2' }));

  // model param is accepted but not used for filtering — instances don't carry model info
  const upstreams = registry.getVerifiedUpstreams('mimo-v2.5-pro');
  assert.equal(upstreams.length, 2);

  const upstreams2 = registry.getVerifiedUpstreams('mimo-v2-flash');
  assert.equal(upstreams2.length, 2);
});

test('registry: 3 upstreams weighted random distributes proportionally', () => {
  const registry = new Registry();
  // a1: w=20 → 30, a2: w=10 → 20, a3: w=50 → 60
  // Expected: a1 ~27%, a2 ~18%, a3 ~55%
  registry.updateInstanceState('a1', createInstance({ accountId: 'a1', weight: 20 }));
  registry.updateInstanceState('a2', createInstance({ accountId: 'a2', weight: 10 }));
  registry.updateInstanceState('a3', createInstance({ accountId: 'a3', weight: 50 }));

  const counts = { a1: 0, a2: 0, a3: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const chosen = registry.chooseVerifiedUpstream('mimo-v2.5-pro');
    counts[chosen.accountId]++;
  }

  const r1 = counts.a1 / N; // 30/110 ≈ 0.273
  const r2 = counts.a2 / N; // 20/110 ≈ 0.182
  const r3 = counts.a3 / N; // 60/110 ≈ 0.545
  assert.ok(r1 > 0.2 && r1 < 0.35, `a1 ratio ${r1.toFixed(3)} should be ~0.273`);
  assert.ok(r2 > 0.1 && r2 < 0.26, `a2 ratio ${r2.toFixed(3)} should be ~0.182`);
  assert.ok(r3 > 0.47 && r3 < 0.62, `a3 ratio ${r3.toFixed(3)} should be ~0.545`);
});

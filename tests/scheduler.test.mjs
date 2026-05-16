import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/manager/scheduler.mjs';

function makeWorker(overrides = {}) {
  return {
    account: { id: overrides.id || 'test-account' },
    instance: overrides.instance || null,
    snapshot() {
      return {
        state: overrides.state || 'NONE',
        instance: overrides.instance || null,
      };
    },
    async create() { (overrides.onCreate || (() => {}))(); },
    async recover() { (overrides.onRecover || (() => {}))(); },
    async renew() { (overrides.onRenew || (() => {}))(); },
    async deployCurrentInstance() { (overrides.onDeploy || (() => {}))(); },
    api: overrides.api || { getStatus: async () => ({ status: 'AVAILABLE', expireTime: Date.now() + 3600_000 }) },
    constructor: { sandboxCreatedAt: () => new Date().toISOString() },
    ...overrides.extra,
  };
}

function makeRegistry(overrides = {}) {
  return {
    getInstanceState() {
      return {
        status: overrides.status || 'NONE',
        verified: overrides.verified || false,
        healthOk: overrides.healthOk || false,
        tunnel: overrides.tunnel || null,
        failureType: overrides.failureType || null,
        retryable: overrides.retryable !== undefined ? overrides.retryable : true,
        lastDeployAt: overrides.lastDeployAt || null,
        deployStage: overrides.deployStage || null,
        ...overrides.extraState,
      };
    },
    updateInstanceState() {},
  };
}

// ─── MANUAL_STOPPED (existing) ──────────────────────────────────

test('scheduler leaves MANUAL_STOPPED workers untouched', async () => {
  let createCalls = 0;
  let recoverCalls = 0;

  const worker = {
    account: { id: 'account-manual' },
    snapshot() {
      return { state: 'MANUAL_STOPPED', instance: null };
    },
    async create() { createCalls += 1; },
    async recover() { recoverCalls += 1; },
  };

  const registry = {
    getInstanceState(accountId) {
      assert.equal(accountId, 'account-manual');
      return { status: 'MANUAL_STOPPED', verified: false, healthOk: false };
    },
  };

  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(createCalls, 0);
  assert.equal(recoverCalls, 0);
});

// ─── DESTROYED (existing) ───────────────────────────────────────

test('current DESTROYED behavior is explicit: scheduler recreates it', async () => {
  let createCalls = 0;

  const worker = {
    account: { id: 'account-destroyed' },
    snapshot() {
      return { state: 'DESTROYED', instance: null };
    },
    async create() { createCalls += 1; },
  };

  const registry = {
    getInstanceState() {
      return { status: 'DESTROYED' };
    },
  };

  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(createCalls, 1);
});

// ─── NONE → create ──────────────────────────────────────────────

test('NONE: calls worker.create()', async () => {
  let created = false;
  const worker = makeWorker({ state: 'NONE', onCreate: () => { created = true; } });
  const scheduler = new Scheduler([worker], makeRegistry(), { checkInterval: 1 });
  await scheduler.tick();
  assert.ok(created);
});

// ─── CREATING → no-op ───────────────────────────────────────────

test('CREATING: does nothing', async () => {
  let created = false;
  let recovered = false;
  const worker = makeWorker({
    state: 'CREATING',
    onCreate: () => { created = true; },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], makeRegistry({ status: 'CREATING' }), { checkInterval: 1 });
  await scheduler.tick();
  assert.equal(created, false);
  assert.equal(recovered, false);
});

// ─── DEPLOYING → no-op ──────────────────────────────────────────

test('DEPLOYING: does nothing', async () => {
  let created = false;
  const worker = makeWorker({
    state: 'DEPLOYING',
    onCreate: () => { created = true; },
  });
  const scheduler = new Scheduler([worker], makeRegistry({ status: 'DEPLOYING' }), { checkInterval: 1 });
  await scheduler.tick();
  assert.equal(created, false);
});

// ─── DEPLOYED_UNVERIFIED + tunnel → upgrade to ACTIVE ───────────

test('DEPLOYED_UNVERIFIED with tunnel: marks ACTIVE', async () => {
  let updatedState = null;
  const registry = makeRegistry({
    status: 'DEPLOYED_UNVERIFIED',
    tunnel: { readyState: 1 },
  });
  registry.updateInstanceState = (id, patch) => { updatedState = patch; };

  const worker = makeWorker({ state: 'DEPLOYED_UNVERIFIED' });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(updatedState);
  assert.equal(updatedState.verified, true);
  assert.equal(updatedState.healthOk, true);
  assert.equal(updatedState.status, 'ACTIVE');
});

// ─── DEPLOYED_UNVERIFIED + tunnel already verified → no-op ──────

test('DEPLOYED_UNVERIFIED with tunnel already verified: no update', async () => {
  let updated = false;
  const registry = makeRegistry({
    status: 'DEPLOYED_UNVERIFIED',
    tunnel: { readyState: 1 },
    verified: true,
    healthOk: true,
  });
  registry.updateInstanceState = () => { updated = true; };

  const worker = makeWorker({ state: 'DEPLOYED_UNVERIFIED' });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(updated, false);
});

// ─── DEPLOYED_UNVERIFIED without tunnel, no stale deploy → no recover ──

test('DEPLOYED_UNVERIFIED without tunnel, recent deploy: no recover', async () => {
  let recovered = false;
  const registry = makeRegistry({
    status: 'DEPLOYED_UNVERIFIED',
    lastDeployAt: new Date().toISOString(), // just deployed
  });

  const worker = makeWorker({
    state: 'DEPLOYED_UNVERIFIED',
    instance: { remaining: 3_600_000 }, // plenty of time
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(recovered, false);
});

// ─── DEPLOYED_UNVERIFIED + refused failure → no recover ─────────

test('DEPLOYED_UNVERIFIED with refused failure: no auto recover', async () => {
  let recovered = false;
  const twoHoursAgo = new Date(Date.now() - 7_200_000).toISOString();
  const registry = makeRegistry({
    status: 'DEPLOYED_UNVERIFIED',
    failureType: 'refused',
    lastDeployAt: twoHoursAgo,
  });

  const worker = makeWorker({
    state: 'DEPLOYED_UNVERIFIED',
    instance: { remaining: 3_600_000 },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(recovered, false);
});

// ─── DEPLOYED_UNVERIFIED + stale deploy + not refused → recover ──

test('DEPLOYED_UNVERIFIED with stale deploy: triggers recover', async () => {
  let recovered = false;
  const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
  const registry = makeRegistry({
    status: 'DEPLOYED_UNVERIFIED',
    lastDeployAt: fiveMinAgo,
  });

  const worker = makeWorker({
    state: 'DEPLOYED_UNVERIFIED',
    instance: { remaining: 3_600_000 },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 60_000 });
  await scheduler.tick();

  assert.ok(recovered);
});

// ─── ACTIVE + verified + tunnel connected → no-op ───────────────

test('ACTIVE with verified tunnel: does nothing', async () => {
  let recovered = false;
  let created = false;
  const registry = makeRegistry({
    status: 'ACTIVE',
    verified: true,
    healthOk: true,
    tunnel: { readyState: 1 },
  });

  const worker = makeWorker({
    state: 'ACTIVE',
    instance: { remaining: 3_600_000 },
    onRecover: () => { recovered = true; },
    onCreate: () => { created = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(recovered, false);
  assert.equal(created, false);
});

// ─── ACTIVE + not verified → recover ────────────────────────────

test('ACTIVE without verification: triggers recover', async () => {
  let recovered = false;
  const registry = makeRegistry({
    status: 'ACTIVE',
    verified: false,
    healthOk: false,
  });

  const worker = makeWorker({
    state: 'ACTIVE',
    instance: { remaining: 3_600_000 },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(recovered);
});

// ─── ACTIVE + tunnel disconnected → recover ─────────────────────

test('ACTIVE with disconnected tunnel: triggers recover', async () => {
  let recovered = false;
  const registry = makeRegistry({
    status: 'ACTIVE',
    verified: true,
    healthOk: true,
    tunnel: { readyState: 3 }, // CLOSED
  });

  const worker = makeWorker({
    state: 'ACTIVE',
    instance: { remaining: 3_600_000 },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(recovered);
});

// ─── ACTIVE + remaining < renewBefore → renew ───────────────────

test('ACTIVE with low remaining time: triggers renew', async () => {
  let renewed = false;
  const registry = makeRegistry({
    status: 'ACTIVE',
    verified: true,
    healthOk: true,
  });

  const worker = makeWorker({
    state: 'ACTIVE',
    instance: { remaining: 60_000 }, // < 300_000 renewBefore
    onRenew: () => { renewed = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1, renewBefore: 300_000 });
  await scheduler.tick();

  assert.ok(renewed);
});

// ─── FAILED non-retryable → no-op ───────────────────────────────

test('FAILED non-retryable: does nothing', async () => {
  let created = false;
  let recovered = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: false,
    failureType: 'deploy_error',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { cooldownElapsed: true },
    onCreate: () => { created = true; },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(created, false);
  assert.equal(recovered, false);
});

// ─── FAILED refused → no-op ─────────────────────────────────────

test('FAILED refused: does nothing', async () => {
  let created = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'refused',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { cooldownElapsed: true },
    onCreate: () => { created = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(created, false);
});

// ─── FAILED upstream_unavailable + cooldown elapsed → create ────

test('FAILED upstream_unavailable with cooldown elapsed: creates', async () => {
  let created = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'upstream_unavailable',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { cooldownElapsed: true },
    onCreate: () => { created = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(created);
});

// ─── FAILED upstream_unavailable + cooldown not elapsed → no-op ──

test('FAILED upstream_unavailable without cooldown: does nothing', async () => {
  let created = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'upstream_unavailable',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { cooldownElapsed: false },
    onCreate: () => { created = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(created, false);
});

// ─── FAILED disconnected + instance → recover ───────────────────

test('FAILED disconnected with instance: recovers', async () => {
  let recovered = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'disconnected',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { remaining: 100_000 },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(recovered);
});

// ─── FAILED disconnected + no instance → no-op ──────────────────

test('FAILED disconnected without instance: does nothing', async () => {
  let recovered = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'disconnected',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: null,
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(recovered, false);
});

// ─── FAILED timeout + cooldown elapsed → recover ────────────────

test('FAILED timeout with cooldown elapsed: recovers', async () => {
  let recovered = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'timeout',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { cooldownElapsed: true },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(recovered);
});

// ─── FAILED generic retryable + cooldown elapsed → create ───────

test('FAILED generic retryable with cooldown elapsed: creates', async () => {
  let created = false;
  const registry = makeRegistry({
    status: 'FAILED',
    retryable: true,
    failureType: 'deploy_error',
  });

  const worker = makeWorker({
    state: 'FAILED',
    instance: { cooldownElapsed: true },
    onCreate: () => { created = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.ok(created);
});

// ─── EXPIRED → create ───────────────────────────────────────────

test('EXPIRED: calls worker.create()', async () => {
  let created = false;
  const worker = makeWorker({ state: 'EXPIRED', onCreate: () => { created = true; } });
  const scheduler = new Scheduler([worker], makeRegistry({ status: 'EXPIRED' }), { checkInterval: 1 });
  await scheduler.tick();
  assert.ok(created);
});

// ─── PAUSED → no-op ─────────────────────────────────────────────

test('PAUSED: does nothing', async () => {
  let created = false;
  let recovered = false;
  const worker = makeWorker({
    state: 'PAUSED',
    onCreate: () => { created = true; },
    onRecover: () => { recovered = true; },
  });
  const scheduler = new Scheduler([worker], makeRegistry({ status: 'PAUSED' }), { checkInterval: 1 });
  await scheduler.tick();
  assert.equal(created, false);
  assert.equal(recovered, false);
});

// ─── READY + remaining < renewBefore → renew ────────────────────

test('READY with low remaining time: triggers renew', async () => {
  let renewed = false;
  const registry = makeRegistry({ status: 'READY' });

  const worker = makeWorker({
    state: 'READY',
    instance: { remaining: 30_000 },
    onRenew: () => { renewed = true; },
  });
  const scheduler = new Scheduler([worker], registry, { checkInterval: 1, renewBefore: 300_000 });
  await scheduler.tick();

  assert.ok(renewed);
});

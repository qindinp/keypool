import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/manager/scheduler.mjs';

test('scheduler leaves PAUSED workers untouched', async () => {
  let createCalls = 0;
  let recoverCalls = 0;

  const worker = {
    account: { id: 'account-paused' },
    snapshot() {
      return { state: 'PAUSED', instance: null };
    },
    async create() { createCalls += 1; },
    async recover() { recoverCalls += 1; },
  };

  const registry = {
    getInstanceState() {
      return { status: 'PAUSED', verified: false, healthOk: false };
    },
  };

  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(createCalls, 0);
  assert.equal(recoverCalls, 0);
});

test('AccountWorker.manualStop() sets correct state', async () => {
  const { AccountWorker } = await import('../src/manager/account-worker.mjs');

  let destroyCalled = false;
  const account = { id: 'account-1', cookie: 'cookie1' };
  const registry = {
    setInstanceStatus() {},
    updateInstanceState() {},
    getInstanceState() { return {}; },
  };
  const api = {
    createInstance: async () => ({ status: 'AVAILABLE', expireTime: Date.now() + 3600_000 }),
    destroyInstance: async () => { destroyCalled = true; },
  };

  const worker = new AccountWorker(account, { registry, api });
  worker.instance = { accountId: 'account-1', status: 'AVAILABLE' };
  worker.state = 'ACTIVE';

  await worker.manualStop();

  assert.equal(destroyCalled, true);
  assert.equal(worker.state, 'MANUAL_STOPPED');
  assert.equal(worker.instance, null);
});

test('AccountWorker.manualStop() handles already-destroyed instance gracefully', async () => {
  const { AccountWorker } = await import('../src/manager/account-worker.mjs');

  const account = { id: 'account-2', cookie: 'cookie2' };
  const registry = {
    setInstanceStatus() {},
    updateInstanceState() {},
    getInstanceState() { return {}; },
  };
  const api = {
    createInstance: async () => ({ status: 'AVAILABLE', expireTime: Date.now() + 3600_000 }),
    destroyInstance: async () => { throw new Error('instance not found'); },
  };

  const worker = new AccountWorker(account, { registry, api });
  worker.instance = { accountId: 'account-2', status: 'AVAILABLE' };
  worker.state = 'ACTIVE';

  // Should not throw even if destroyInstance fails
  await worker.manualStop();

  assert.equal(worker.state, 'MANUAL_STOPPED');
  assert.equal(worker.instance, null);
});

test('AccountWorker adopts already registered tunnel when deployer reports marker failure', async () => {
  const { AccountWorker } = await import('../src/manager/account-worker.mjs');

  const state = new Map();
  const account = { id: 'account-3', cookie: 'cookie3' };
  const registry = {
    setInstanceStatus(accountId, status) {
      const current = state.get(accountId) || {};
      state.set(accountId, { ...current, status });
    },
    updateInstanceState(accountId, patch) {
      const current = state.get(accountId) || {};
      state.set(accountId, { ...current, ...patch });
    },
    getInstanceState(accountId) {
      return state.get(accountId) || {};
    },
  };
  const api = {
    createInstance: async () => ({ status: 'AVAILABLE', expireTime: Date.now() + 3600_000 }),
    destroyInstance: async () => {},
  };
  const deployer = {
    async deploy() {
      registry.updateInstanceState(account.id, {
        tunnel: { readyState: 1 },
        tunnelAccountId: account.id,
        tunnelRunId: 'account-3-run',
        tunnelConnectedAt: new Date().toISOString(),
        verified: true,
        healthOk: true,
      });
      const err = new Error('chat marker timeout');
      err.deployResult = {
        deployMode: 'tunnel',
        runId: 'account-3-run',
        stage: 'start',
        stageStatus: 'timeout',
        timeline: [{ stage: 'start', status: 'timeout' }],
      };
      throw err;
    },
  };

  const worker = new AccountWorker(account, { registry, api, deployer, config: { retryBaseDelay: 1 } });
  await worker.create();

  const finalState = registry.getInstanceState(account.id);
  assert.equal(worker.state, 'ACTIVE');
  assert.equal(finalState.status, 'ACTIVE');
  assert.equal(finalState.verified, true);
  assert.equal(finalState.healthOk, true);
  assert.equal(finalState.tunnelRunId, 'account-3-run');
  assert.equal(finalState.lastDeployError, null);
});

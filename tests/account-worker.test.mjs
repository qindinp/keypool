import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountWorker } from '../src/manager/account-worker.mjs';
import { Registry } from '../src/gateway/registry.mjs';

function createAccount(overrides = {}) {
  return {
    id: 'test-account',
    name: 'Test Account',
    cookie: 'test-cookie',
    priority: 100,
    weight: 10,
    ...overrides,
  };
}

function createMockApi(overrides = {}) {
  return {
    createInstance: overrides.createInstance || (async () => ({
      status: 'RUNNING',
      expireTime: Date.now() + 3600_000,
      createTime: Date.now(),
    })),
    destroyInstance: overrides.destroyInstance || (async () => {}),
  };
}

function createMockDeployer(overrides = {}) {
  return {
    deploy: overrides.deploy || (async () => ({
      verified: true,
      proxyUrl: 'http://localhost:8080',
      runId: 'run-123',
      deployMode: 'tunnel',
      stage: 'complete',
      stageStatus: 'ok',
      timeline: [],
    })),
  };
}

function createWorker(accountOverrides = {}, apiOverrides = {}, deployerOverrides = {}) {
  const registry = new Registry();
  const account = createAccount(accountOverrides);
  const api = createMockApi(apiOverrides);
  const deps = { registry, api, config: { retryBaseDelay: 100 } };
  if (deployerOverrides !== null) {
    deps.deployer = createMockDeployer(deployerOverrides);
  }
  return new AccountWorker(account, deps);
}

// ─── sandboxCreatedAt ────────────────────────────────────────────

test('sandboxCreatedAt: uses createTime when present', () => {
  const ts = 1700000000000;
  const result = AccountWorker.sandboxCreatedAt({ createTime: ts });
  assert.equal(result, new Date(ts).toISOString());
});

test('sandboxCreatedAt: uses createTime as-is when string', () => {
  const result = AccountWorker.sandboxCreatedAt({ createTime: '2024-01-01T00:00:00Z' });
  assert.equal(result, '2024-01-01T00:00:00Z');
});

test('sandboxCreatedAt: falls back to expireTime - 1h', () => {
  const expire = 1700003600000;
  const result = AccountWorker.sandboxCreatedAt({ expireTime: expire });
  assert.equal(result, new Date(expire - 3600_000).toISOString());
});

test('sandboxCreatedAt: falls back to Date.now() when neither present', () => {
  const before = Date.now();
  const result = AccountWorker.sandboxCreatedAt({});
  const after = Date.now();
  const parsed = new Date(result).getTime();
  assert.ok(parsed >= before && parsed <= after);
});

// ─── constructor / initial state ─────────────────────────────────

test('worker: initial state is NONE', () => {
  const worker = createWorker();
  assert.equal(worker.state, 'NONE');
  assert.equal(worker.instance, null);
});

test('worker: constructor writes account config to registry', () => {
  const registry = new Registry();
  const account = createAccount({ id: 'acc-1', weight: 50, priority: 200 });
  new AccountWorker(account, { registry, api: createMockApi(), config: {} });
  const state = registry.getInstanceState('acc-1');
  assert.equal(state.accountId, 'acc-1');
  assert.equal(state.weight, 50);
  assert.equal(state.priority, 200);
});

// ─── snapshot ────────────────────────────────────────────────────

test('snapshot: returns null instance when no instance', () => {
  const worker = createWorker();
  const snap = worker.snapshot();
  assert.equal(snap.state, 'NONE');
  assert.equal(snap.instance, null);
});

test('snapshot: returns instance with remaining time', () => {
  const worker = createWorker();
  worker.instance = {
    accountId: 'test-account',
    status: 'RUNNING',
    expiresAt: Date.now() + 100_000,
    createdAt: Date.now(),
  };
  const snap = worker.snapshot();
  assert.ok(snap.instance.remaining > 0);
  assert.ok(snap.instance.remaining <= 100_000);
});

// ─── create ──────────────────────────────────────────────────────

test('create: transitions CREATING → READY when no deployer', async () => {
  const registry = new Registry();
  const account = createAccount();
  const api = createMockApi();
  const worker = new AccountWorker(account, { registry, api, config: {} });

  await worker.create();

  assert.equal(worker.state, 'READY');
  assert.ok(worker.instance);
  assert.equal(worker.instance.status, 'RUNNING');
});

test('create: uses expireTime for expiresAt', async () => {
  const futureTime = Date.now() + 7200_000;
  const worker = createWorker({}, {
    createInstance: async () => ({ status: 'RUNNING', expireTime: futureTime }),
  });
  await worker.create();
  assert.equal(worker.instance.expiresAt, futureTime);
});

test('create: falls back to now+1h when no expireTime', async () => {
  const before = Date.now();
  const worker = createWorker({}, {
    createInstance: async () => ({ status: 'RUNNING' }),
  });
  await worker.create();
  assert.ok(worker.instance.expiresAt >= before + 3600_000 - 1000);
});

test('create: sets FAILED on API error', async () => {
  const worker = createWorker({}, {
    createInstance: async () => { throw new Error('API down'); },
  });
  await worker.create();
  assert.equal(worker.state, 'FAILED');
  assert.equal(worker.cooldownUntil > Date.now() - 1000, true);
});

test('create: with deployer calls deploy', async () => {
  let deployCalled = false;
  const worker = createWorker({}, {}, {
    deploy: async () => { deployCalled = true; return { verified: true }; },
  });
  await worker.create();
  assert.ok(deployCalled);
  assert.equal(worker.state, 'ACTIVE');
});

test('create: deploy failure sets FAILED', async () => {
  const worker = createWorker({}, {}, {
    deploy: async () => { throw new Error('deploy broke'); },
  });
  await worker.create();
  assert.equal(worker.state, 'FAILED');
});

// ─── deployCurrentInstance ───────────────────────────────────────

test('deployCurrentInstance: sets ACTIVE when verified', async () => {
  const registry = new Registry();
  const worker = createWorker({}, {}, {
    deploy: async () => ({
      verified: true,
      proxyUrl: 'http://localhost:8080',
      runId: 'run-1',
      deployMode: 'tunnel',
      stage: 'complete',
      stageStatus: 'ok',
      timeline: [],
    }),
  });
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 3600_000, createdAt: Date.now() };

  await worker.deployCurrentInstance();
  assert.equal(worker.state, 'ACTIVE');
});

test('deployCurrentInstance: sets DEPLOYED_UNVERIFIED when not verified', async () => {
  const worker = createWorker({}, {}, {
    deploy: async () => ({
      verified: false,
      runId: 'run-2',
      deployMode: 'tunnel',
      stage: 'tunnel-wait',
      stageStatus: 'pending',
      timeline: [],
    }),
  });
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 3600_000, createdAt: Date.now() };

  await worker.deployCurrentInstance();
  assert.equal(worker.state, 'DEPLOYED_UNVERIFIED');
});

// ─── setState ────────────────────────────────────────────────────

test('setState: updates registry', () => {
  const registry = new Registry();
  const account = createAccount();
  const api = createMockApi();
  const worker = new AccountWorker(account, { registry, api, config: {} });
  worker.setState('ACTIVE', { verified: true });
  assert.equal(registry.getInstanceStatus('test-account'), 'ACTIVE');
  const state = registry.getInstanceState('test-account');
  assert.equal(state.verified, true);
});

// ─── adoptActiveTunnel ───────────────────────────────────────────

test('adoptActiveTunnel: returns false when no tunnel', () => {
  const worker = createWorker();
  assert.equal(worker.adoptActiveTunnel(), false);
});

test('adoptActiveTunnel: returns true and sets ACTIVE when tunnel exists', () => {
  const registry = new Registry();
  const account = createAccount();
  const api = createMockApi();
  const worker = new AccountWorker(account, { registry, api, config: {} });
  registry.updateInstanceState('test-account', {
    tunnel: { readyState: 1 },
    tunnelRunId: 'run-abc',
    lastVerifiedAt: new Date().toISOString(),
  });
  const result = worker.adoptActiveTunnel({ deployMode: 'tunnel' });
  assert.equal(result, true);
  assert.equal(worker.state, 'ACTIVE');
});

// ─── manualStop ──────────────────────────────────────────────────

test('manualStop: sets MANUAL_STOPPED and clears instance', async () => {
  const destroyed = [];
  const worker = createWorker({}, {
    destroyInstance: async (cookie) => destroyed.push(cookie),
  });
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 3600_000, createdAt: Date.now() };
  worker.state = 'ACTIVE';

  await worker.manualStop();

  assert.equal(worker.state, 'MANUAL_STOPPED');
  assert.equal(worker.instance, null);
  assert.deepEqual(destroyed, ['test-cookie']);
  assert.equal(worker.cooldownUntil, 0);
});

test('manualStop: handles destroyInstance failure gracefully', async () => {
  const worker = createWorker({}, {
    destroyInstance: async () => { throw new Error('already gone'); },
  });
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 3600_000, createdAt: Date.now() };

  await worker.manualStop();
  assert.equal(worker.state, 'MANUAL_STOPPED');
});

// ─── renew ───────────────────────────────────────────────────────

test('renew: creates new instance and destroys old one', async () => {
  let destroyCalled = false;
  const worker = createWorker({}, {
    createInstance: async () => ({ status: 'RUNNING', expireTime: Date.now() + 7200_000, createTime: Date.now() }),
    destroyInstance: async () => { destroyCalled = true; },
  }, null);
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 1000, createdAt: Date.now() };
  worker.state = 'ACTIVE';

  await worker.renew();

  assert.equal(worker.state, 'READY');
  assert.ok(worker.instance);
  assert.ok(destroyCalled);
});

test('renew: preserves old instance on create failure', async () => {
  const oldInstance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 1000, createdAt: Date.now() };
  const worker = createWorker({}, {
    createInstance: async () => { throw new Error('create failed'); },
  });
  worker.instance = oldInstance;
  worker.state = 'ACTIVE';

  await worker.renew();

  assert.equal(worker.instance, oldInstance);
  assert.equal(worker.state, 'ACTIVE');
});

test('renew: restores old instance on deploy failure', async () => {
  const oldInstance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 1000, createdAt: Date.now() };
  const worker = createWorker({}, {}, {
    deploy: async () => { throw { deployResult: { stage: 'install', stageStatus: 'failed', lastError: 'install broke' } }; },
  });
  worker.instance = oldInstance;
  worker.state = 'ACTIVE';

  await worker.renew();

  assert.equal(worker.instance, oldInstance);
  assert.equal(worker.state, 'ACTIVE');
});

// ─── recover ─────────────────────────────────────────────────────

test('recover: delegates to deployCurrentInstance when deployer present', async () => {
  let deployCalled = false;
  const worker = createWorker({}, {}, {
    deploy: async () => { deployCalled = true; return { verified: true }; },
  });
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 3600_000, createdAt: Date.now() };

  await worker.recover();
  assert.ok(deployCalled);
  assert.equal(worker.state, 'ACTIVE');
});

test('recover: sets FAILED when no deployer', async () => {
  const registry = new Registry();
  const account = createAccount();
  const api = createMockApi();
  const worker = new AccountWorker(account, { registry, api, config: { retryBaseDelay: 100 } });

  await worker.recover();
  assert.equal(worker.state, 'FAILED');
});

// ─── deployCurrentInstance: deployCount increments ────────────────

test('deployCurrentInstance: increments deployCount', async () => {
  const registry = new Registry();
  const account = createAccount();
  const api = createMockApi();
  const deployer = createMockDeployer({
    deploy: async () => ({ verified: false, stage: 'tunnel-wait', stageStatus: 'pending' }),
  });
  const worker = new AccountWorker(account, { registry, api, deployer, config: {} });
  registry.updateInstanceState('test-account', { deployCount: 5 });
  worker.instance = { accountId: 'test-account', status: 'RUNNING', expiresAt: Date.now() + 3600_000, createdAt: Date.now() };

  await worker.deployCurrentInstance();
  const state = registry.getInstanceState('test-account');
  assert.equal(state.deployCount, 6);
});

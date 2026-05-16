import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeManagerConfig,
  buildManagerStatus,
  startManager,
  stopManager,
  restartManager,
  reloadAccounts,
  runAccountAction,
  normalizeTags,
} from '../src/gateway/admin/handlers.mjs';

// ─── sanitizeManagerConfig ──────────────────────────────────────

test('sanitizeManagerConfig: redacts tailscaleAuthKey', () => {
  const result = sanitizeManagerConfig({ tailscaleAuthKey: 'tskey-auth-abc123', port: 9300 });
  assert.equal(result.tailscaleAuthKey, '<redacted>');
  assert.equal(result.port, 9300);
});

test('sanitizeManagerConfig: passes through when no auth key', () => {
  const result = sanitizeManagerConfig({ port: 9300, host: '0.0.0.0' });
  assert.equal(result.port, 9300);
  assert.equal(result.host, '0.0.0.0');
});

test('sanitizeManagerConfig: handles null/undefined', () => {
  assert.equal(sanitizeManagerConfig(null), null);
  assert.equal(sanitizeManagerConfig(undefined), undefined);
});

// ─── buildManagerStatus ���────────────────────────────────────────

test('buildManagerStatus: null manager returns default status', () => {
  const result = buildManagerStatus(null);
  assert.equal(result.running, false);
  assert.equal(result.workers, 0);
  assert.equal(result.enabled, false);
  assert.ok(result.note);
});

test('buildManagerStatus: reports worker count', () => {
  const manager = {
    workers: [{ id: 1 }, { id: 2 }, { id: 3 }],
    config: { checkInterval: 30000 },
  };
  const result = buildManagerStatus(manager);
  assert.equal(result.running, true);
  assert.equal(result.workers, 3);
  assert.equal(result.enabled, true);
});

test('buildManagerStatus: handles missing workers array', () => {
  const manager = { config: {} };
  const result = buildManagerStatus(manager);
  assert.equal(result.running, true);
  assert.equal(result.workers, 0);
});

// ─── startManager ──────────────────────────────────────────────

test('startManager: returns error when no manager', async () => {
  const result = await startManager(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_unavailable');
});

test('startManager: calls manager.start()', async () => {
  let started = false;
  const manager = {
    start() { started = true; },
    workers: [],
    config: {},
  };
  const result = await startManager(manager);
  assert.equal(result.ok, true);
  assert.ok(started);
  assert.ok(result.manager);
});

test('startManager: handles start() throw', async () => {
  const manager = {
    start() { throw new Error('already running'); },
    workers: [],
    config: {},
  };
  const result = await startManager(manager);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_start_failed');
  assert.ok(result.message.includes('already running'));
});

// ─── stopManager ───────────────────────────────────────────────

test('stopManager: returns error when no manager', async () => {
  const result = await stopManager(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_unavailable');
});

test('stopManager: calls manager.stop()', async () => {
  let stopped = false;
  const manager = {
    async stop() { stopped = true; },
    workers: [{ id: 1 }],
    config: {},
  };
  const result = await stopManager(manager);
  assert.equal(result.ok, true);
  assert.ok(stopped);
  assert.equal(result.manager.running, false);
  assert.equal(result.manager.workers, 1);
});

test('stopManager: handles stop() throw', async () => {
  const manager = {
    async stop() { throw new Error('stop failed'); },
    workers: [],
    config: {},
  };
  const result = await stopManager(manager);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_stop_failed');
});

// ─── restartManager ────────────────────────────────────────────

test('restartManager: returns error when no manager', async () => {
  const result = await restartManager(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_unavailable');
});

test('restartManager: stops then starts', async () => {
  const calls = [];
  const manager = {
    start() { calls.push('start'); },
    async stop() { calls.push('stop'); },
    workers: [],
    config: {},
  };
  const result = await restartManager(manager);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['stop', 'start']);
  assert.ok(result.message.includes('重启'));
});

test('restartManager: returns stop failure', async () => {
  const manager = {
    start() {},
    async stop() { throw new Error('cannot stop'); },
    workers: [],
    config: {},
  };
  const result = await restartManager(manager);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_stop_failed');
});

// ─── reloadAccounts ────────────────────────────────────────────

test('reloadAccounts: returns error when no manager', () => {
  const result = reloadAccounts(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_unavailable');
});

test('reloadAccounts: returns error when no reloadAccounts method', () => {
  const result = reloadAccounts({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reload_unsupported');
});

test('reloadAccounts: returns success result', () => {
  const manager = {
    reloadAccounts() {
      return { added: ['a1'], removed: [], updated: [] };
    },
  };
  const result = reloadAccounts(manager);
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ['a1']);
});

test('reloadAccounts: returns error result from reload', () => {
  const manager = {
    reloadAccounts() {
      return { error: 'invalid config' };
    },
  };
  const result = reloadAccounts(manager);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reload_failed');
  assert.ok(result.message.includes('invalid config'));
});

test('reloadAccounts: handles reloadAccounts() throw', () => {
  const manager = {
    reloadAccounts() { throw new Error('crash'); },
  };
  const result = reloadAccounts(manager);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'reload_failed');
});

// ─── runAccountAction ──────────────────────────────────────────

test('runAccountAction: returns error when no manager', async () => {
  const result = await runAccountAction(null, 'acc-1', 'deploy');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manager_unavailable');
});

test('runAccountAction: returns error when account not found', async () => {
  const manager = { workers: [{ account: { id: 'other' } }] };
  const result = await runAccountAction(manager, 'acc-1', 'deploy');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_not_found');
});

test('runAccountAction: deploy calls worker.create()', async () => {
  let created = false;
  const worker = {
    account: { id: 'acc-1' },
    async create() { created = true; },
    snapshot() { return { state: 'READY' }; },
  };
  const manager = { workers: [worker] };
  const result = await runAccountAction(manager, 'acc-1', 'deploy');
  assert.equal(result.ok, true);
  assert.equal(result.action, 'deploy');
  assert.ok(created);
});

test('runAccountAction: recover calls worker.recover()', async () => {
  let recovered = false;
  const worker = {
    account: { id: 'acc-1' },
    async recover() { recovered = true; },
    snapshot() { return { state: 'ACTIVE' }; },
  };
  const manager = { workers: [worker] };
  const result = await runAccountAction(manager, 'acc-1', 'recover');
  assert.equal(result.ok, true);
  assert.ok(recovered);
});

test('runAccountAction: stop calls worker.manualStop()', async () => {
  let stopped = false;
  const worker = {
    account: { id: 'acc-1' },
    async manualStop() { stopped = true; },
    snapshot() { return { state: 'MANUAL_STOPPED' }; },
  };
  const manager = { workers: [worker] };
  const result = await runAccountAction(manager, 'acc-1', 'stop');
  assert.equal(result.ok, true);
  assert.ok(stopped);
});

test('runAccountAction: destroy sets DESTROYED state', async () => {
  let destroyed = false;
  const registryState = {};
  const worker = {
    account: { id: 'acc-1', cookie: 'test-cookie' },
    instance: { status: 'RUNNING' },
    state: 'ACTIVE',
    api: { destroyInstance: async () => { destroyed = true; } },
    registry: { updateInstanceState(id, state) { Object.assign(registryState, state); } },
    snapshot() { return { state: 'DESTROYED' }; },
  };
  const manager = { workers: [worker] };
  const result = await runAccountAction(manager, 'acc-1', 'destroy');
  assert.equal(result.ok, true);
  assert.ok(destroyed);
  assert.equal(worker.state, 'DESTROYED');
  assert.equal(worker.instance, null);
  assert.equal(registryState.status, 'DESTROYED');
});

test('runAccountAction: handles action throw', async () => {
  const worker = {
    account: { id: 'acc-1' },
    async create() { throw new Error('create failed'); },
    snapshot() { return { state: 'FAILED' }; },
  };
  const manager = { workers: [worker] };
  const result = await runAccountAction(manager, 'acc-1', 'deploy');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_action_failed');
  assert.ok(result.message.includes('create failed'));
});

// ─── normalizeTags ─────────────────────────────────────────────

test('normalizeTags: array of strings', () => {
  assert.deepEqual(normalizeTags(['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('normalizeTags: trims and filters empty', () => {
  assert.deepEqual(normalizeTags([' a ', '', ' b ']), ['a', 'b']);
});

test('normalizeTags: splits comma-separated string', () => {
  assert.deepEqual(normalizeTags('tag1,tag2,tag3'), ['tag1', 'tag2', 'tag3']);
});

test('normalizeTags: returns empty for null/undefined/number', () => {
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags(undefined), []);
  assert.deepEqual(normalizeTags(42), []);
});

test('normalizeTags: handles comma string with spaces', () => {
  assert.deepEqual(normalizeTags(' a , b , c '), ['a', 'b', 'c']);
});

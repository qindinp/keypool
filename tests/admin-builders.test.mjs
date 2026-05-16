import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview, buildAgents, buildInstances, loadAccountsSummary } from '../src/gateway/admin/builders.mjs';
import { Registry } from '../src/gateway/registry.mjs';

function createRegistryWithInstances(instances = []) {
  const registry = new Registry();
  for (const inst of instances) {
    registry.updateInstanceState(inst.accountId, inst);
  }
  return registry;
}

function makeReq(host = 'localhost:9300') {
  return { headers: { host } };
}

function makeContext(managerOverride = undefined) {
  return {
    manager: managerOverride ?? null,
  };
}

// ─── buildInstances ──────────────────────────────────────────────

test('buildInstances: empty registry returns empty object', () => {
  const registry = new Registry();
  const result = buildInstances(registry);
  assert.deepEqual(result, {});
});

test('buildInstances: null patch creates entry with defaults', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', null);
  const result = buildInstances(registry);
  assert.equal(result.a1.accountId, 'a1');
  assert.equal(result.a1.status, 'NONE');
  assert.equal(result.a1.verified, false);
});

test('buildInstances: multiple instances with metadata', () => {
  const registry = createRegistryWithInstances([
    {
      accountId: 'a1', status: 'ACTIVE', verified: true, healthOk: true,
      lastVerifiedAt: '2024-01-01T00:00:00Z', deployMode: 'tunnel',
      deployStage: 'complete', deployStatus: 'ok', deployCount: 3,
      proxyUrl: 'http://localhost:8080', tunnelConnectedAt: '2024-01-01T00:00:00Z',
      tunnelRunId: 'run-123', createdAt: '2024-01-01T00:00:00Z',
      lastDeployAt: '2024-01-01T00:00:00Z', deployTimeline: [],
    },
    {
      accountId: 'a2', status: 'FAILED', verified: false, healthOk: false,
      failureType: 'deploy_error', retryable: true,
      lastDeployError: 'connection timeout',
    },
  ]);

  const result = buildInstances(registry);
  assert.equal(Object.keys(result).length, 2);

  assert.equal(result.a1.accountId, 'a1');
  assert.equal(result.a1.status, 'ACTIVE');
  assert.equal(result.a1.verified, true);
  assert.equal(result.a1.healthOk, true);
  assert.equal(result.a1.deployMode, 'tunnel');
  assert.equal(result.a1.proxyUrl, 'http://localhost:8080');
  assert.equal(result.a1.deployCount, 3);

  assert.equal(result.a2.accountId, 'a2');
  assert.equal(result.a2.status, 'FAILED');
  assert.equal(result.a2.failureType, 'deploy_error');
  assert.equal(result.a2.retryable, true);
  assert.equal(result.a2.lastDeployError, 'connection timeout');
});

test('buildInstances: defaults for missing fields', () => {
  const registry = createRegistryWithInstances([
    { accountId: 'a1' },
  ]);

  const result = buildInstances(registry);
  assert.equal(result.a1.status, 'NONE');
  assert.equal(result.a1.verified, false);
  assert.equal(result.a1.healthOk, false);
  assert.equal(result.a1.deployCount, 0);
  assert.deepEqual(result.a1.deployTimeline, []);
  assert.equal(result.a1.proxyUrl, null);
  assert.equal(result.a1.failureType, null);
  assert.equal(result.a1.retryable, false);
});

test('buildInstances: includes destroyedAt', () => {
  const registry = createRegistryWithInstances([
    { accountId: 'a1', destroyedAt: '2024-06-01T12:00:00Z' },
  ]);
  const result = buildInstances(registry);
  assert.equal(result.a1.destroyedAt, '2024-06-01T12:00:00Z');
});

// ─── buildAgents ─────────────────────────────────────────────────

test('buildAgents: returns empty array when no tunnels', () => {
  const registry = createRegistryWithInstances([
    { accountId: 'a1', status: 'ACTIVE', verified: true },
  ]);
  const result = buildAgents(registry);
  assert.deepEqual(result, []);
});

test('buildAgents: returns agents with tunnels', () => {
  const registry = new Registry();
  registry.updateInstanceState('a1', {
    status: 'ACTIVE',
    tunnel: { readyState: 1 },
    tunnelConnectedAt: '2024-01-01T00:00:00Z',
    verified: true,
    healthOk: true,
  });
  registry.updateInstanceState('a2', {
    status: 'DEPLOYING',
  });

  const result = buildAgents(registry);
  assert.equal(result.length, 1);
  assert.equal(result[0].accountId, 'a1');
  assert.equal(result[0].status, 'ACTIVE');
  assert.equal(result[0].verified, true);
  assert.equal(result[0].healthOk, true);
  assert.equal(result[0].connectedAt, '2024-01-01T00:00:00Z');
});

// ─── buildOverview ───────────────────────────────────────────────

test('buildOverview: metrics count correctly', () => {
  const registry = createRegistryWithInstances([
    { accountId: 'a1', status: 'ACTIVE', verified: true, healthOk: true },
    { accountId: 'a2', status: 'ACTIVE', verified: false, healthOk: true },
    { accountId: 'a3', status: 'DEPLOYING', verified: false, healthOk: false },
    { accountId: 'a4', status: 'FAILED', verified: false, healthOk: false, retryable: true },
    { accountId: 'a5', status: 'FAILED', verified: false, healthOk: false, retryable: false },
  ]);

  const req = makeReq();
  const overview = buildOverview(registry, req, makeContext());

  assert.equal(overview.metrics.instances, 5);
  assert.equal(overview.metrics.activeInstances, 2);
  assert.equal(overview.metrics.verifiedInstances, 2); // a1 is ACTIVE and verified
  assert.equal(overview.metrics.creatingInstances, 1); // a3 is DEPLOYING
  assert.equal(overview.metrics.failedInstances, 2);
  assert.equal(overview.metrics.retryableFailures, 1);
});

test('buildOverview: service status degraded when no verified upstreams', () => {
  const registry = createRegistryWithInstances([
    { accountId: 'a1', status: 'FAILED', verified: false },
  ]);

  const overview = buildOverview(registry, makeReq(), makeContext());
  assert.equal(overview.service.status, 'degraded');
});

test('buildOverview: service status ok when verified upstreams exist', () => {
  const registry = createRegistryWithInstances([
    { accountId: 'a1', status: 'ACTIVE', verified: true },
  ]);

  const overview = buildOverview(registry, makeReq(), makeContext());
  assert.equal(overview.service.status, 'ok');
});

test('buildOverview: uses req host for URLs', () => {
  const registry = new Registry();
  const overview = buildOverview(registry, makeReq('example.com:8080'), makeContext());

  assert.ok(overview.service.accessUrl.includes('example.com:8080'));
  assert.ok(overview.service.adminUrl.includes('example.com:8080'));
});

test('buildOverview: default host fallback', () => {
  const registry = new Registry();
  const req = { headers: {} };
  const overview = buildOverview(registry, req, makeContext());

  assert.ok(overview.service.accessUrl.includes('127.0.0.1:9300'));
});

test('buildOverview: null manager uses default status', () => {
  const registry = new Registry();
  const overview = buildOverview(registry, makeReq(), makeContext(null));

  assert.equal(overview.service.manager.running, false);
  assert.equal(overview.service.manager.enabled, false);
  assert.equal(overview.service.manager.workers, 0);
});

test('buildOverview: with manager reports status', () => {
  const registry = new Registry();
  const fakeManager = {
    workers: [{ id: 1 }, { id: 2 }],
    config: { checkInterval: 30000 },
  };
  const overview = buildOverview(registry, makeReq(), makeContext(fakeManager));

  assert.equal(overview.service.manager.running, true);
  assert.equal(overview.service.manager.enabled, true);
  assert.equal(overview.service.manager.workers, 2);
});

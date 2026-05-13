import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyHandler } from '../src/gateway/proxy.mjs';

function createMockRegistry(upstream = {}) {
  const calls = { success: 0, failure: 0, upstreamError: 0, lastUpstreamStatus: null, lastError: null };
  const base = {
    accountId: 'test-account',
    tunnel: null,
    proxyUrl: 'http://127.0.0.1:19999',
    verified: true,
    healthOk: true,
    status: 'ACTIVE',
    ...upstream,
  };
  return {
    instance: base,
    calls,
    chooseVerifiedUpstream(model, opts = {}) {
      const { excludeAccountIds = new Set() } = opts;
      if (excludeAccountIds.has(base.accountId)) return null;
      return base;
    },
    markProxySuccess(id, latency) { calls.success++; },
    markProxyFailure(id, err) { calls.failure++; calls.lastError = err; },
    markProxyUpstreamError(id, status, body) { calls.upstreamError++; calls.lastUpstreamStatus = status; },
  };
}

function createMockReqRes() {
  const req = {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', host: 'localhost' },
    on: () => {},
  };
  const res = {
    _status: null,
    _headers: null,
    _body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { this._status = status; this._headers = headers; },
    write(chunk) { this._body += chunk; },
    end(body) { if (body) this._body += body; this.writableEnded = true; },
  };
  return { req, res };
}

test('proxy: upstream 400 calls markProxyUpstreamError (not markProxyFailure)', async () => {
  const registry = createMockRegistry();
  const handler = createProxyHandler(registry, null);

  // Mock fetch to return 400
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 400,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => '{"error":"bad request"}',
    body: null,
  });

  try {
    const { req, res } = createMockReqRes();
    await handler(req, res, '{"model":"test"}');

    assert.equal(registry.calls.upstreamError, 1);
    assert.equal(registry.calls.lastUpstreamStatus, 400);
    assert.equal(registry.calls.failure, 0, 'transport failure count should be 0');
    assert.equal(registry.calls.success, 0, 'success count should be 0');
    assert.equal(res._status, 400);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('proxy: upstream 200 calls markProxySuccess', async () => {
  const registry = createMockRegistry();
  const handler = createProxyHandler(registry, null);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => '{"ok":true}',
    body: null,
  });

  try {
    const { req, res } = createMockReqRes();
    await handler(req, res, '{"model":"test"}');

    assert.equal(registry.calls.success, 1);
    assert.equal(registry.calls.failure, 0);
    assert.equal(registry.calls.upstreamError, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('proxy: fetch throws calls markProxyFailure (transport error)', async () => {
  const registry = createMockRegistry();
  const handler = createProxyHandler(registry, null);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  try {
    const { req, res } = createMockReqRes();
    await handler(req, res, '{"model":"test"}');

    assert.equal(registry.calls.failure, 1);
    assert.equal(registry.calls.lastError, 'ECONNREFUSED');
    assert.equal(registry.calls.success, 0);
    assert.equal(registry.calls.upstreamError, 0);
    assert.equal(res._status, 502);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('proxy: tunnel transport error calls markProxyFailure', async () => {
  const registry = createMockRegistry({ tunnel: { readyState: 1 }, proxyUrl: null, baseUrl: null, localUrl: null });
  const mockSend = async () => { throw new Error('tunnel connection closed'); };
  const handler = createProxyHandler(registry, mockSend);

  const { req, res } = createMockReqRes();
  await handler(req, res, '{"model":"test"}');

  assert.equal(registry.calls.failure, 1);
  assert.equal(registry.calls.lastError, 'tunnel connection closed');
  assert.equal(registry.calls.upstreamError, 0);
  assert.equal(res._status, 502);
});

test('proxy: tunnel upstream 500 calls markProxyUpstreamError', async () => {
  const registry = createMockRegistry({ tunnel: { readyState: 1 }, proxyUrl: null, baseUrl: null, localUrl: null });
  const mockSend = async () => ({ status: 500, headers: {}, body: '{"error":"internal"}' });
  const handler = createProxyHandler(registry, mockSend);

  const { req, res } = createMockReqRes();
  await handler(req, res, '{"model":"test"}');

  assert.equal(registry.calls.upstreamError, 1);
  assert.equal(registry.calls.lastUpstreamStatus, 500);
  assert.equal(registry.calls.failure, 0, 'should not mark as transport failure');
  assert.equal(res._status, 502); // 500 → upstream excluded → no more upstreams → 502
});

test('proxy: no upstream returns 503', async () => {
  const registry = { chooseVerifiedUpstream() { return null; } };
  const handler = createProxyHandler(registry, null);

  const { req, res } = createMockReqRes();
  await handler(req, res, '{"model":"test"}');

  assert.equal(res._status, 503);
});

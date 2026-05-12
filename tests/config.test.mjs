import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/manager/config.mjs';

test('validateConfig accepts a minimal valid config', () => {
  const result = validateConfig({
    port: 9300,
    host: '0.0.0.0',
    deployRepo: 'https://github.com/qindinp/keypool.git',
    publicWsUrl: 'wss://example.com/tunnel',
    publicHttpBase: 'https://example.com',
    checkInterval: 60_000,
    renewBefore: 300_000,
    maxRetries: 5,
    retryBaseDelay: 5_000,
    retryMaxDelay: 60_000,
    chatTimeout: 120_000,
    wsConnectTimeout: 30_000,
    deployTimeout: 300_000,
    readyTimeout: 180_000,
  });

  assert.equal(result.port, 9300);
  assert.equal(result.publicWsUrl, 'wss://example.com/tunnel');
});

test('validateConfig rejects invalid ports', () => {
  assert.throws(() => validateConfig({ port: 0 }), /port/);
  assert.throws(() => validateConfig({ port: 70000 }), /port/);
  assert.throws(() => validateConfig({ port: '9300' }), /port/);
});

test('validateConfig rejects non-positive timing fields', () => {
  assert.throws(() => validateConfig({ checkInterval: 0 }), /checkInterval/);
  assert.throws(() => validateConfig({ deployTimeout: -1 }), /deployTimeout/);
});

test('validateConfig validates public url schemes', () => {
  assert.throws(() => validateConfig({ publicWsUrl: 'http://example.com/tunnel' }), /publicWsUrl/);
  assert.throws(() => validateConfig({ publicHttpBase: 'ws://example.com' }), /publicHttpBase/);
});

test('validateConfig validates deployRepo scheme', () => {
  assert.doesNotThrow(() => validateConfig({ deployRepo: 'https://github.com/qindinp/keypool.git' }));
  assert.doesNotThrow(() => validateConfig({ deployRepo: 'git@github.com:qindinp/keypool.git' }));
  assert.throws(() => validateConfig({ deployRepo: 'file:///tmp/keypool.git' }), /deployRepo/);
});

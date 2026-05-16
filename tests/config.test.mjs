import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, createConfig } from '../src/manager/config.mjs';

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

// ─── createConfig ───────────────────────────────────────────────

test('createConfig: returns defaults when no env overrides', () => {
  const config = createConfig({});
  assert.equal(config.port, 9300);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.renewBefore, 300_000);
  assert.equal(config.checkInterval, 60_000);
  assert.equal(config.maxRetries, 5);
  assert.equal(config.deployRepo, 'https://github.com/qindinp/keypool.git');
  assert.equal(config.wsConnectTimeout, 30_000);
  assert.equal(config.deployTimeout, 300_000);
  assert.equal(config.chatTimeout, 120_000);
  assert.equal(config.retryBaseDelay, 5_000);
  assert.equal(config.retryMaxDelay, 60_000);
});

test('createConfig: env overrides take precedence', () => {
  const config = createConfig({
    PORT: '8080',
    HOST: '127.0.0.1',
    RENEW_BEFORE: '60',
    CHECK_INTERVAL: '10',
    MAX_RETRIES: '3',
    DEPLOY_REPO: 'https://github.com/example/repo.git',
    WS_CONNECT_TIMEOUT: '5000',
    DEPLOY_TIMEOUT: '60000',
    CHAT_TIMEOUT: '30000',
    RETRY_BASE_DELAY: '2000',
    RETRY_MAX_DELAY: '30000',
  });
  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.renewBefore, 60_000);
  assert.equal(config.checkInterval, 10_000);
  assert.equal(config.maxRetries, 3);
  assert.equal(config.deployRepo, 'https://github.com/example/repo.git');
  assert.equal(config.wsConnectTimeout, 5_000);
  assert.equal(config.deployTimeout, 60_000);
  assert.equal(config.chatTimeout, 30_000);
  assert.equal(config.retryBaseDelay, 2_000);
  assert.equal(config.retryMaxDelay, 30_000);
});

test('createConfig: rejects invalid env values', () => {
  assert.throws(() => createConfig({ PORT: '70000' }), /port/);
  assert.throws(() => createConfig({ CHECK_INTERVAL: '-1' }), /checkInterval/);
  assert.throws(() => createConfig({ KEYPOOL_PUBLIC_WS_URL: 'http://bad' }), /publicWsUrl/);
});

test('createConfig: handles NaN parseInt gracefully', () => {
  const config = createConfig({ RENEW_BEFORE: 'not-a-number' });
  assert.equal(config.renewBefore, 300_000); // falls back to default
});

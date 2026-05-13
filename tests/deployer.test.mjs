import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartPrompt, waitForTunnelRegistration } from '../src/manager/deployer.mjs';
import { spawnSync } from 'node:child_process';

const ENV_OR_TEMPLATE_SRC = [
  'function envOrTemplate(envName, templateValue) {',
  '  const value = process.env[envName];',
  '  if (value && value.trim()) return value.trim();',
  '  if (templateValue && !/^__.+__$/.test(templateValue)) return templateValue;',
  '  console.error(`[tunnel-proxy] missing required env ${envName}`);',
  '  process.exit(1);',
  '}',
].join('\n');

test('buildStartPrompt cleans old tunnel processes before starting new run', () => {
  const prompt = buildStartPrompt('STARTED_MARKER', 'wss://example.com/tunnel', 'account-1', 'account-1-run');

  assert.match(prompt, /pkill -f/);
  assert.match(prompt, /tunnel-proxy\.mjs/);
  assert.match(prompt, /KEYPOOL_GATEWAY_URL="wss:\/\/example\.com\/tunnel"/);
  assert.match(prompt, /KEYPOOL_ACCOUNT_ID="account-1"/);
  assert.match(prompt, /KEYPOOL_RUN_ID="account-1-run"/);
  assert.match(prompt, /STARTED_MARKER/);
});

test('tunnel proxy requires runtime env when template placeholders are not rendered', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `
      const process = globalThis.process;
      ${ENV_OR_TEMPLATE_SRC}
      envOrTemplate('KEYPOOL_GATEWAY_URL', '__KEYPOOL_GATEWAY_URL__');
    `,
    encoding: 'utf8',
    env: { ...process.env, KEYPOOL_GATEWAY_URL: '' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing required env KEYPOOL_GATEWAY_URL/);
});

test('tunnel proxy accepts KEYPOOL_* runtime env values', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `
      const process = globalThis.process;
      ${ENV_OR_TEMPLATE_SRC}
      console.log(envOrTemplate('KEYPOOL_GATEWAY_URL', '__KEYPOOL_GATEWAY_URL__'));
      console.log(envOrTemplate('KEYPOOL_ACCOUNT_ID', '__KEYPOOL_ACCOUNT_ID__'));
      console.log(envOrTemplate('KEYPOOL_RUN_ID', '__KEYPOOL_RUN_ID__'));
    `,
    encoding: 'utf8',
    env: {
      ...process.env,
      KEYPOOL_GATEWAY_URL: 'wss://example.com/tunnel',
      KEYPOOL_ACCOUNT_ID: 'account-1',
      KEYPOOL_RUN_ID: 'run-1',
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /wss:\/\/example\.com\/tunnel/);
  assert.match(result.stdout, /account-1/);
  assert.match(result.stdout, /run-1/);
});

test('waitForTunnelRegistration resolves matching registered tunnel', async () => {
  const registry = {
    getInstanceState(accountId) {
      assert.equal(accountId, 'account-1');
      return {
        tunnel: {},
        tunnelRunId: 'account-1-run',
        verified: true,
        healthOk: true,
      };
    },
  };

  const state = await waitForTunnelRegistration({ registry, accountId: 'account-1', runId: 'account-1-run', timeoutMs: 10, intervalMs: 1 });
  assert.equal(state.tunnelRunId, 'account-1-run');
});

test('waitForTunnelRegistration rejects mismatched runId', async () => {
  const registry = {
    getInstanceState() {
      return {
        tunnel: {},
        tunnelRunId: 'old-run',
        verified: true,
        healthOk: true,
      };
    },
  };

  await assert.rejects(
    () => waitForTunnelRegistration({ registry, accountId: 'account-1', runId: 'new-run', timeoutMs: 5, intervalMs: 1 }),
    /Timed out waiting for tunnel registration/
  );
});

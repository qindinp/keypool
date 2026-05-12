import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStartPrompt, waitForTunnelRegistration } from '../src/manager/deployer.mjs';

test('buildStartPrompt cleans old tunnel processes before starting new run', () => {
  const prompt = buildStartPrompt('STARTED_MARKER', 'wss://example.com/tunnel', 'account-1', 'account-1-run');

  assert.match(prompt, /pkill -f/);
  assert.match(prompt, /tunnel-proxy\.mjs/);
  assert.match(prompt, /KEYPOOL_GATEWAY_URL="wss:\/\/example\.com\/tunnel"/);
  assert.match(prompt, /KEYPOOL_ACCOUNT_ID="account-1"/);
  assert.match(prompt, /KEYPOOL_RUN_ID="account-1-run"/);
  assert.match(prompt, /STARTED_MARKER/);
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

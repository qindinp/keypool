import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccountsConfig } from '../src/manager/accounts.mjs';

test('validateAccountsConfig accepts accounts wrapper', () => {
  const result = validateAccountsConfig({
    accounts: [
      { id: 'account-1', enabled: true, priority: 10, cookieFile: 'cookies/account-1.txt' },
      { id: 'account-2', enabled: false, cookie: 'serviceToken=placeholder' },
    ],
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'account-1');
});

test('validateAccountsConfig accepts top-level array', () => {
  const result = validateAccountsConfig([{ id: 'account-1', cookie: 'serviceToken=placeholder' }]);
  assert.equal(result.length, 1);
});

test('validateAccountsConfig rejects invalid shape', () => {
  assert.throws(() => validateAccountsConfig({}), /accounts/);
  assert.throws(() => validateAccountsConfig({ accounts: 'bad' }), /accounts/);
});

test('validateAccountsConfig requires account object', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [null] }), /account\[0\]/);
  assert.throws(() => validateAccountsConfig({ accounts: ['bad'] }), /account\[0\]/);
});

test('validateAccountsConfig validates enabled and priority types', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', enabled: 'yes', cookie: 'x' }] }), /enabled/);
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', priority: '1', cookie: 'x' }] }), /priority/);
});

test('validateAccountsConfig requires cookie or cookieFile', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a' }] }), /cookie/);
});

test('validateAccountsConfig rejects absolute or parent cookieFile paths', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', cookieFile: '../secret.txt' }] }), /cookieFile/);
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', cookieFile: 'C:/secret.txt' }] }), /cookieFile/);
});

// ─── Extended validation ────────────────────────────────────────

test('validateAccountsConfig rejects non-string id', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 123, cookie: 'x' }] }), /id/);
});

test('validateAccountsConfig rejects non-string name', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ name: 123, cookie: 'x' }] }), /name/);
});

test('validateAccountsConfig rejects non-array tags', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', tags: 'bad', cookie: 'x' }] }), /tags/);
});

test('validateAccountsConfig rejects non-object meta', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', meta: 'bad', cookie: 'x' }] }), /meta/);
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', meta: [1, 2], cookie: 'x' }] }), /meta/);
});

test('validateAccountsConfig rejects non-finite weight', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', weight: Infinity, cookie: 'x' }] }), /weight/);
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', weight: NaN, cookie: 'x' }] }), /weight/);
});

test('validateAccountsConfig accepts valid optional fields', () => {
  const result = validateAccountsConfig({
    accounts: [{
      id: 'a',
      name: 'Account A',
      enabled: true,
      priority: 50,
      weight: 200,
      tags: ['prod'],
      meta: { region: 'us-east' },
      cookie: 'token=abc',
    }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'a');
  assert.equal(result[0].priority, 50);
  assert.equal(result[0].weight, 200);
  assert.deepEqual(result[0].tags, ['prod']);
  assert.deepEqual(result[0].meta, { region: 'us-east' });
});

test('validateAccountsConfig rejects empty cookieFile string', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', cookieFile: '' }] }), /cookie/);
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', cookieFile: '   ' }] }), /cookie/);
});

test('validateAccountsConfig rejects backslash traversal in cookieFile', () => {
  assert.throws(() => validateAccountsConfig({ accounts: [{ id: 'a', cookieFile: '..\\secret.txt' }] }), /cookieFile/);
});

test('validateAccountsConfig accepts multiple accounts', () => {
  const result = validateAccountsConfig({
    accounts: [
      { id: 'a1', cookie: 'c1' },
      { id: 'a2', cookie: 'c2' },
      { id: 'a3', cookieFile: 'cookies/a3.txt' },
    ],
  });
  assert.equal(result.length, 3);
});

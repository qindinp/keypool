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

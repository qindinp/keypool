import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/manager/scheduler.mjs';

test('scheduler leaves MANUAL_STOPPED workers untouched', async () => {
  let createCalls = 0;
  let recoverCalls = 0;

  const worker = {
    account: { id: 'account-manual' },
    snapshot() {
      return { state: 'MANUAL_STOPPED', instance: null };
    },
    async create() { createCalls += 1; },
    async recover() { recoverCalls += 1; },
  };

  const registry = {
    getInstanceState(accountId) {
      assert.equal(accountId, 'account-manual');
      return { status: 'MANUAL_STOPPED', verified: false, healthOk: false };
    },
  };

  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(createCalls, 0);
  assert.equal(recoverCalls, 0);
});

test('current DESTROYED behavior is explicit: scheduler recreates it', async () => {
  let createCalls = 0;

  const worker = {
    account: { id: 'account-destroyed' },
    snapshot() {
      return { state: 'DESTROYED', instance: null };
    },
    async create() { createCalls += 1; },
  };

  const registry = {
    getInstanceState() {
      return { status: 'DESTROYED' };
    },
  };

  const scheduler = new Scheduler([worker], registry, { checkInterval: 1 });
  await scheduler.tick();

  assert.equal(createCalls, 1);
});

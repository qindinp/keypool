import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/gateway/registry.mjs';
import { createTunnelServer } from '../src/gateway/tunnel.mjs';

function createOpenWs(sentMessages = []) {
  return {
    readyState: 1,
    send(payload) {
      sentMessages.push(JSON.parse(payload));
    },
  };
}

test('sendProxyRequest rejects callback mode mixed with res pipe mode', async () => {
  const tunnel = createTunnelServer(new Registry());
  const ws = createOpenWs();
  const res = {
    writableEnded: false,
    write() {},
    end() { this.writableEnded = true; },
  };

  await assert.rejects(
    tunnel.sendProxyRequest(ws, {
      method: 'GET',
      path: '/v1/models',
      headers: {},
    }, {
      res,
      onChunk() {},
      timeoutMs: 5,
    }),
    /cannot combine|mutually exclusive|callback/i,
  );
});

test('sendProxyRequest accepts callback mode without res', async () => {
  const tunnel = createTunnelServer(new Registry());
  const sent = [];
  const ws = createOpenWs(sent);

  const promise = tunnel.sendProxyRequest(ws, {
    method: 'GET',
    path: '/v1/models',
    headers: {},
  }, {
    onChunk() {},
    timeoutMs: 5,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'proxy_request');
  await assert.rejects(promise, /timeout/);
});

#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const rootDir = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, process.platform === 'win32' ? '' : '/'));
const relayEntry = join(rootDir, 'relay', 'server.mjs');
const tempRoot = join(tmpdir(), `keypool-relay-test-${Date.now()}`);
const registryPath = join(tempRoot, 'registry.json');
const primaryPort = 19510;
const fallbackPort = 19512;
const relayPort = 19511;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return res;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`wait timeout: ${url}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeRegistry(upstreams) {
  writeFileSync(registryPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    upstreams,
  }, null, 2) + '\n', 'utf-8');
}

function readRegistry() {
  return JSON.parse(readFileSync(registryPath, 'utf-8'));
}

function upstreamRecord({ accountId, port, priority = 1, healthy = true }) {
  return {
    accountId,
    accountName: accountId,
    baseUrl: `http://127.0.0.1:${port}`,
    localUrl: `http://127.0.0.1:${port}`,
    shareUrl: null,
    healthy,
    priority,
    inflight: 0,
    lastOkAt: Date.now(),
    failureCount: 0,
    cooldownUntil: null,
    deployCount: 0,
    instanceStatus: healthy ? 'AVAILABLE' : 'DESTROYED',
  };
}

function startFakeUpstream(port, behavior) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      if (behavior.healthStatus && behavior.healthStatus !== 200) {
        res.writeHead(behavior.healthStatus, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'health-failed' }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, upstream: behavior.name }));
    }

    if (url.pathname === '/v1/models') {
      if (behavior.modelsStatus && behavior.modelsStatus >= 500) {
        res.writeHead(behavior.modelsStatus, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: `${behavior.name}-models-failed` }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: `${behavior.name}-model` }] }));
    }

    if (url.pathname === '/v1/embeddings') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      if (behavior.embeddingsStatus && behavior.embeddingsStatus >= 500) {
        res.writeHead(behavior.embeddingsStatus, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: `${behavior.name}-embeddings-failed` }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: parsed.model || `${behavior.name}-embed-model`,
        usage: { prompt_tokens: 3, total_tokens: 3 },
        upstream: behavior.name,
      }));
    }

    if (url.pathname === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');

      if (parsed.stream) {
        if (behavior.streamStatus && behavior.streamStatus >= 500) {
          res.writeHead(behavior.streamStatus, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: `${behavior.name}-stream-failed` }));
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`data: {"id":"chatcmpl-stream-${behavior.name}","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${behavior.name}"}}]}\n\n`);
        await sleep(30);
        return res.end('data: [DONE]\n\n');
      }

      if (behavior.chatStatus && behavior.chatStatus >= 500) {
        res.writeHead(behavior.chatStatus, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: `${behavior.name}-chat-failed` }));
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        id: `chatcmpl-${behavior.name}`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `${behavior.name}-ok` } }],
        model: parsed.model || `${behavior.name}-chat-model`,
        upstream: behavior.name,
      }));
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startRelay() {
  const child = spawn(process.execPath, [relayEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: String(relayPort),
      RELAY_REGISTRY_PATH: registryPath,
      RELAY_MAX_ATTEMPTS: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk.toString());
  child.stderr.on('data', chunk => stderr += chunk.toString());

  return { child, getLogs: () => ({ stdout, stderr }) };
}

async function testNoHealthyUpstream() {
  writeRegistry([]);
  const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
  assert(res.status === 503, `expected /health 503, got ${res.status}`);

  const modelRes = await fetch(`http://127.0.0.1:${relayPort}/v1/models`);
  assert(modelRes.status === 503, `expected /v1/models 503, got ${modelRes.status}`);
}

async function testAdminPage() {
  writeRegistry([upstreamRecord({ accountId: 'primary', port: primaryPort, priority: 1 })]);
  const res = await fetch(`http://127.0.0.1:${relayPort}/admin`);
  assert(res.status === 200, `expected /admin 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes('KeyPool Relay 管理界面'), 'admin page missing title');
  assert(html.includes('/registry'), 'admin page should reference /registry');
}

async function testJsonRoutes() {
  writeRegistry([
    upstreamRecord({ accountId: 'primary', port: primaryPort, priority: 1 }),
  ]);

  const healthRes = await fetch(`http://127.0.0.1:${relayPort}/health`);
  assert(healthRes.status === 200, `expected /health 200, got ${healthRes.status}`);

  const modelsRes = await fetch(`http://127.0.0.1:${relayPort}/v1/models`);
  assert(modelsRes.status === 200, `expected /v1/models 200, got ${modelsRes.status}`);
  const models = await modelsRes.json();
  assert(models?.data?.[0]?.id === 'primary-model', 'unexpected models payload');

  const embeddingsRes = await fetch(`http://127.0.0.1:${relayPort}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embed-test', input: 'hello' }),
  });
  assert(embeddingsRes.status === 200, `expected /v1/embeddings 200, got ${embeddingsRes.status}`);
  const embeddings = await embeddingsRes.json();
  assert(Array.isArray(embeddings?.data?.[0]?.embedding), 'unexpected embeddings payload');
  assert(embeddings?.upstream === 'primary', 'embeddings should come from primary');

  const chatRes = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-test', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert(chatRes.status === 200, `expected /v1/chat/completions 200, got ${chatRes.status}`);
  const chat = await chatRes.json();
  assert(chat?.choices?.[0]?.message?.content === 'primary-ok', 'unexpected chat payload');
}

async function testStreamRoute() {
  writeRegistry([
    upstreamRecord({ accountId: 'primary', port: primaryPort, priority: 1 }),
  ]);

  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert(res.status === 200, `expected stream status 200, got ${res.status}`);
  const text = await res.text();
  assert(text.includes('primary'), 'stream output should come from primary');
  assert(text.includes('data: [DONE]'), 'stream output missing done frame');
}

async function testFailoverToFallback() {
  writeRegistry([
    upstreamRecord({ accountId: 'primary', port: primaryPort, priority: 1 }),
    upstreamRecord({ accountId: 'fallback', port: fallbackPort, priority: 2 }),
  ]);

  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-test', messages: [{ role: 'user', content: 'please failover' }] }),
  });

  assert(res.status === 200, `expected failover chat status 200, got ${res.status}`);
  const body = await res.json();
  assert(body?.upstream === 'fallback', 'chat should be served by fallback upstream');

  const registry = readRegistry();
  const primary = registry.upstreams.find(u => u.accountId === 'primary');
  const fallback = registry.upstreams.find(u => u.accountId === 'fallback');
  assert(primary, 'primary upstream missing from registry');
  assert(fallback, 'fallback upstream missing from registry');
  assert(primary.failureCount >= 1, 'primary failureCount should increase after failover');
  assert(Boolean(primary.cooldownUntil), 'primary cooldownUntil should be set after failover');
  assert(primary.lastStatusCode === 500, 'primary lastStatusCode should record 500');
  assert(fallback.lastError == null, 'fallback should not carry lastError after success');
}

async function testAllUpstreamsFailed() {
  writeRegistry([
    upstreamRecord({ accountId: 'primary', port: primaryPort, priority: 1 }),
    upstreamRecord({ accountId: 'fallback', port: fallbackPort, priority: 2 }),
  ]);

  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/models`);
  assert(res.status === 502, `expected all failed status 502, got ${res.status}`);
  const body = await res.json();
  assert(body?.error === 'all_upstreams_failed', 'expected all_upstreams_failed error');
  assert(Array.isArray(body?.attempts) && body.attempts.length >= 2, 'expected attempts for both upstreams');

  const registry = readRegistry();
  const primary = registry.upstreams.find(u => u.accountId === 'primary');
  const fallback = registry.upstreams.find(u => u.accountId === 'fallback');
  assert(primary?.failureCount >= 1, 'primary should record failure');
  assert(fallback?.failureCount >= 1, 'fallback should record failure');
}

async function main() {
  mkdirSync(tempRoot, { recursive: true });
  let primary;
  let fallback;
  let relay;

  try {
    primary = await startFakeUpstream(primaryPort, {
      name: 'primary',
    });
    fallback = await startFakeUpstream(fallbackPort, {
      name: 'fallback',
      modelsStatus: 500,
      chatStatus: 200,
    });
    relay = startRelay();
    await waitFor(`http://127.0.0.1:${relayPort}/registry`);

    await testNoHealthyUpstream();
    await testAdminPage();
    await testJsonRoutes();
    await testStreamRoute();

    await new Promise(resolve => primary.close(resolve));
    primary = await startFakeUpstream(primaryPort, {
      name: 'primary',
      chatStatus: 500,
      modelsStatus: 500,
      embeddingsStatus: 500,
      streamStatus: 500,
    });

    await testFailoverToFallback();
    await testAllUpstreamsFailed();

    console.log('OK relay integration tests passed');
  } catch (error) {
    const logs = relay?.getLogs?.() || { stdout: '', stderr: '' };
    console.error('relay integration tests failed');
    console.error(error?.stack || String(error));
    if (logs.stdout) console.error('\n[relay stdout]\n' + logs.stdout);
    if (logs.stderr) console.error('\n[relay stderr]\n' + logs.stderr);
    process.exitCode = 1;
  } finally {
    if (relay?.child && !relay.child.killed) {
      relay.child.kill();
      await sleep(150);
    }
    if (primary) {
      await new Promise(resolve => primary.close(resolve));
    }
    if (fallback) {
      await new Promise(resolve => fallback.close(resolve));
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();

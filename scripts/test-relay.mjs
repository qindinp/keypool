#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const rootDir = resolve(new URL('..', import.meta.url).pathname.replace(/^\//, process.platform === 'win32' ? '' : '/'));
const relayEntry = join(rootDir, 'relay', 'server.mjs');
const tempRoot = join(tmpdir(), `keypool-relay-test-${Date.now()}`);
const registryPath = join(tempRoot, 'registry.json');
const upstreamPort = 19510;
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

function startFakeUpstream() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }] }));
    }

    if (url.pathname === '/v1/embeddings') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: parsed.model || 'fake-embed-model',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }));
    }

    if (url.pathname === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');

      if (parsed.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n');
        await sleep(30);
        res.write('data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n');
        await sleep(30);
        return res.end('data: [DONE]\n\n');
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
        model: parsed.model || 'fake-chat-model',
      }));
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(upstreamPort, '127.0.0.1', () => resolve(server));
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
      RELAY_MAX_ATTEMPTS: '2',
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

async function testJsonRoutes() {
  writeRegistry([{
    accountId: 'test-account',
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    localUrl: `http://127.0.0.1:${upstreamPort}`,
    healthy: true,
    priority: 1,
    inflight: 0,
    lastOkAt: Date.now(),
  }]);

  const healthRes = await fetch(`http://127.0.0.1:${relayPort}/health`);
  assert(healthRes.status === 200, `expected /health 200, got ${healthRes.status}`);

  const modelsRes = await fetch(`http://127.0.0.1:${relayPort}/v1/models`);
  assert(modelsRes.status === 200, `expected /v1/models 200, got ${modelsRes.status}`);
  const models = await modelsRes.json();
  assert(models?.data?.[0]?.id === 'fake-model', 'unexpected models payload');

  const embeddingsRes = await fetch(`http://127.0.0.1:${relayPort}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embed-test', input: 'hello' }),
  });
  assert(embeddingsRes.status === 200, `expected /v1/embeddings 200, got ${embeddingsRes.status}`);
  const embeddings = await embeddingsRes.json();
  assert(Array.isArray(embeddings?.data?.[0]?.embedding), 'unexpected embeddings payload');

  const chatRes = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-test', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert(chatRes.status === 200, `expected /v1/chat/completions 200, got ${chatRes.status}`);
  const chat = await chatRes.json();
  assert(chat?.choices?.[0]?.message?.content === 'ok', 'unexpected chat payload');
}

async function testStreamRoute() {
  const res = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert(res.status === 200, `expected stream status 200, got ${res.status}`);
  const text = await res.text();
  assert(text.includes('data: {'), 'stream output missing data frame');
  assert(text.includes('data: [DONE]'), 'stream output missing done frame');
}

async function main() {
  mkdirSync(tempRoot, { recursive: true });
  let upstream;
  let relay;

  try {
    upstream = await startFakeUpstream();
    relay = startRelay();
    await waitFor(`http://127.0.0.1:${relayPort}/registry`);

    await testNoHealthyUpstream();
    await testJsonRoutes();
    await testStreamRoute();

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
    if (upstream) {
      await new Promise(resolve => upstream.close(resolve));
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();

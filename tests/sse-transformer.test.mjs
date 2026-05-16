import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSETransformer } from '../src/gateway/sse-transformer.mjs';

function makeRes() {
  const chunks = [];
  return {
    chunks,
    write(chunk) { chunks.push(chunk); },
  };
}

function makeState(overrides = {}) {
  return {
    started: false,
    blockIndex: 0,
    thinkingStarted: false,
    thinkingClosed: false,
    textStarted: false,
    textClosed: false,
    model: 'test-model',
    ...overrides,
  };
}

function oaiChunk(delta = {}, finishReason = null, id = 'chatcmpl-123', model = 'test-model') {
  const choice = { delta, index: 0 };
  if (finishReason) choice.finish_reason = finishReason;
  return { id, model, choices: [choice] };
}

function sseLine(chunk) {
  return `data: ${JSON.stringify(chunk)}\n`;
}

test('sse-transformer: simple text chunk', () => {
  const res = makeRes();
  const state = makeState();
  const transformer = createSSETransformer(state, res);

  transformer.processChunk(Buffer.from(sseLine(oaiChunk({ content: 'Hello' }))));

  assert.ok(state.started);
  assert.ok(state.textStarted);
  const events = res.chunks.map(c => c.split('\n').filter(l => l.startsWith('event: ')).map(l => l.slice(7))).flat();
  assert.ok(events.includes('message_start'));
  assert.ok(events.includes('content_block_start'));
  assert.ok(events.includes('content_block_delta'));
});

test('sse-transformer: [DONE] marker is ignored', () => {
  const res = makeRes();
  const state = makeState();
  const transformer = createSSETransformer(state, res);

  transformer.processChunk(Buffer.from('data: [DONE]\n'));

  assert.equal(res.chunks.length, 0);
});

test('sse-transformer: multiple chunks in one buffer', () => {
  const res = makeRes();
  const state = makeState();
  const transformer = createSSETransformer(state, res);

  const buf = Buffer.from(sseLine(oaiChunk({ content: 'A' })) + sseLine(oaiChunk({ content: 'B' })));
  transformer.processChunk(buf);

  const allText = res.chunks.join('');
  assert.ok(allText.includes('"text":"A"'));
  assert.ok(allText.includes('"text":"B"'));
});

test('sse-transformer: chunk split across two buffers', () => {
  const res = makeRes();
  const state = makeState();
  const transformer = createSSETransformer(state, res);

  const line = sseLine(oaiChunk({ content: 'split' }));
  const mid = Math.floor(line.length / 2);
  transformer.processChunk(Buffer.from(line.slice(0, mid)));
  assert.equal(res.chunks.length, 0, 'should not emit partial lines');

  transformer.processChunk(Buffer.from(line.slice(mid)));
  assert.ok(res.chunks.length > 0, 'should emit after second buffer');
  assert.ok(res.chunks.join('').includes('"text":"split"'));
});

test('sse-transformer: flush emits message_stop when stream started', () => {
  const res = makeRes();
  const state = makeState({ started: true, textStarted: true });
  const transformer = createSSETransformer(state, res);

  transformer.flush();

  const allText = res.chunks.join('');
  assert.ok(allText.includes('message_delta'));
  assert.ok(allText.includes('message_stop'));
  assert.ok(allText.includes('"stop_reason":"end_turn"'));
});

test('sse-transformer: flush does not double-emit when text already closed', () => {
  const res = makeRes();
  const state = makeState({ started: true, textStarted: true, textClosed: true });
  const transformer = createSSETransformer(state, res);

  transformer.flush();

  assert.equal(res.chunks.length, 0, 'should not emit when text already closed');
});

test('sse-transformer: flush processes residual lineBuf', () => {
  const res = makeRes();
  const state = makeState();
  const transformer = createSSETransformer(state, res);

  const line = sseLine(oaiChunk({ content: 'tail' }));
  // Send everything except the final newline
  transformer.processChunk(Buffer.from(line));

  // The line ends with \n so it should already be processed
  assert.ok(res.chunks.join('').includes('"text":"tail"'));
});

test('sse-transformer: reasoning_content chunk', () => {
  const res = makeRes();
  const state = makeState();
  const transformer = createSSETransformer(state, res);

  transformer.processChunk(Buffer.from(sseLine(oaiChunk({ reasoning_content: 'thinking...' }))));

  assert.ok(state.thinkingStarted);
  const allText = res.chunks.join('');
  assert.ok(allText.includes('thinking_delta'));
  assert.ok(allText.includes('"thinking":"thinking..."'));
});

test('sse-transformer: finish_reason emits message_delta and message_stop', () => {
  const res = makeRes();
  const state = makeState({ started: true, textStarted: true });
  const transformer = createSSETransformer(state, res);

  transformer.processChunk(Buffer.from(sseLine(oaiChunk({}, 'stop'))));

  assert.ok(state.textClosed);
  const allText = res.chunks.join('');
  assert.ok(allText.includes('message_delta'));
  assert.ok(allText.includes('message_stop'));
  assert.ok(allText.includes('"stop_reason":"end_turn"'));
});

test('sse-transformer: finish_reason with tool_calls emits tool_use stop', () => {
  const res = makeRes();
  const state = makeState({ started: true, textStarted: true });
  const transformer = createSSETransformer(state, res);

  transformer.processChunk(Buffer.from(sseLine(oaiChunk({}, 'tool_calls'))));

  const allText = res.chunks.join('');
  assert.ok(allText.includes('"stop_reason":"tool_use"'));
});

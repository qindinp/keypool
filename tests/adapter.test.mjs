import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  openAIChunkToAnthropicEvents,
} from '../src/gateway/adapter.mjs';

// ─── anthropicToOpenAI ────────────────────────────────────────────

test('anthropicToOpenAI: simple text message', () => {
  const result = anthropicToOpenAI({
    model: 'claude-3',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(result.model, 'claude-3');
  assert.equal(result.max_tokens, 1024);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].content, 'hello');
});

test('anthropicToOpenAI: system as string', () => {
  const result = anthropicToOpenAI({
    system: 'You are helpful',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'You are helpful');
});

test('anthropicToOpenAI: system as array of blocks', () => {
  const result = anthropicToOpenAI({
    system: [{ text: 'line 1' }, { text: 'line 2' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'line 1\nline 2');
});

test('anthropicToOpenAI: tool_use blocks become tool_calls', () => {
  const result = anthropicToOpenAI({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Beijing' } },
      ],
    }],
  });
  const msg = result.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'let me check');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].id, 'tu_1');
  assert.equal(msg.tool_calls[0].function.name, 'get_weather');
  assert.equal(msg.tool_calls[0].function.arguments, '{"city":"Beijing"}');
});

test('anthropicToOpenAI: thinking block becomes reasoning_content', () => {
  const result = anthropicToOpenAI({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think step by step...' },
        { type: 'text', text: 'The answer is 42.' },
      ],
    }],
  });
  const msg = result.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.reasoning_content, 'Let me think step by step...');
  assert.equal(msg.content, 'The answer is 42.');
});

test('anthropicToOpenAI: multiple thinking blocks are merged into reasoning_content', () => {
  const result = anthropicToOpenAI({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'First thought.' },
        { type: 'thinking', thinking: 'Second thought.' },
        { type: 'text', text: 'Final answer.' },
      ],
    }],
  });
  const msg = result.messages[0];
  assert.equal(msg.reasoning_content, 'First thought.\nSecond thought.');
  assert.equal(msg.content, 'Final answer.');
});

test('anthropicToOpenAI: tool_result becomes tool role message', () => {
  const result = anthropicToOpenAI({
    messages: [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '{"temp":20}' },
      ],
    }],
  });
  const msg = result.messages[0];
  assert.equal(msg.role, 'tool');
  assert.equal(msg.tool_call_id, 'tu_1');
  assert.equal(msg.content, '{"temp":20}');
});

test('anthropicToOpenAI: image block', () => {
  const result = anthropicToOpenAI({
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        { type: 'text', text: 'describe this' },
      ],
    }],
  });
  const msg = result.messages[0];
  assert.equal(Array.isArray(msg.content), true);
  assert.equal(msg.content[0].type, 'image_url');
  assert.match(msg.content[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(msg.content[1], 'describe this');
});

test('anthropicToOpenAI: tools mapping', () => {
  const result = anthropicToOpenAI({
    tools: [{
      name: 'search',
      description: 'Search the web',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    }],
    messages: [],
  });
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].function.name, 'search');
  assert.equal(result.tools[0].function.description, 'Search the web');
});

test('anthropicToOpenAI: stop_sequences mapped to stop', () => {
  const result = anthropicToOpenAI({
    stop_sequences: ['STOP', 'END'],
    messages: [],
  });
  assert.deepEqual(result.stop, ['STOP', 'END']);
});

test('anthropicToOpenAI: assistant tool_use preserves preceding thinking as reasoning_content', () => {
  const result = anthropicToOpenAI({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Need weather and time, so call both tools.' },
        { type: 'tool_use', id: 'call_weather', name: 'get_current_weather', input: { location: 'Beijing' } },
        { type: 'tool_use', id: 'call_time', name: 'get_time', input: { timezone: 'Asia/Shanghai' } },
      ],
    }],
  });
  const msg = result.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.reasoning_content, 'Need weather and time, so call both tools.');
  assert.equal(msg.content, undefined);
  assert.equal(msg.tool_calls.length, 2);
  assert.equal(msg.tool_calls[0].id, 'call_weather');
  assert.equal(msg.tool_calls[1].id, 'call_time');
});

test('openAIToAnthropic: reasoning_content is emitted before tool_use blocks', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-reasoning-tools',
    choices: [{
      message: {
        reasoning_content: 'Need weather and time, so call both tools.',
        content: null,
        tool_calls: [
          { id: 'call_weather', type: 'function', function: { name: 'get_current_weather', arguments: '{"location":"Beijing"}' } },
          { id: 'call_time', type: 'function', function: { name: 'get_time', arguments: '{"timezone":"Asia/Shanghai"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  }, 'mimo-v2.5-pro');

  assert.equal(result.content.length, 3);
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'Need weather and time, so call both tools.');
  assert.equal(result.content[1].type, 'tool_use');
  assert.equal(result.content[1].id, 'call_weather');
  assert.equal(result.content[2].type, 'tool_use');
  assert.equal(result.content[2].id, 'call_time');
  assert.equal(result.stop_reason, 'tool_use');
});

test('openAIToAnthropic: empty reasoning_content is preserved as an empty thinking block before tool_use', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-empty-reasoning-tools',
    choices: [{
      message: {
        reasoning_content: '',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }, 'mimo-v2.5-pro');

  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, '');
  assert.equal(result.content[1].type, 'tool_use');
});

// ─── openAIToAnthropic ────────────────────────────────────────────

test('openAIToAnthropic: text only', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-123',
    choices: [{
      message: { content: 'Hello world' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }, 'mimo-v2.5-pro');

  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, 'Hello world');
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
});

test('openAIToAnthropic: reasoning_content becomes thinking block', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-456',
    choices: [{
      message: {
        reasoning_content: 'Let me think step by step...',
        content: 'The answer is 42.',
      },
      finish_reason: 'stop',
    }],
  });

  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'Let me think step by step...');
  assert.equal(result.content[1].type, 'text');
  assert.equal(result.content[1].text, 'The answer is 42.');
});

test('openAIToAnthropic: reasoning only (content=null)', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-789',
    choices: [{
      message: {
        reasoning_content: 'Internal reasoning...',
        content: null,
      },
      finish_reason: 'length',
    }],
  }, 'mimo-v2.5-pro');

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'Internal reasoning...');
  assert.equal(result.stop_reason, 'max_tokens');
});

test('openAIToAnthropic: empty response fallback', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-empty',
    choices: [{
      message: { content: null },
      finish_reason: 'stop',
    }],
  });

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, '');
});

test('openAIToAnthropic: no choices fallback', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-none',
    choices: [],
  });

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, '');
  assert.equal(result.stop_reason, 'end_turn');
});

test('openAIToAnthropic: tool_calls', () => {
  const result = openAIToAnthropic({
    id: 'chatcmpl-tc',
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"weather"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  });

  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].id, 'call_1');
  assert.equal(result.content[0].name, 'search');
  assert.deepEqual(result.content[0].input, { q: 'weather' });
  assert.equal(result.stop_reason, 'tool_use');
});

test('openAIToAnthropic: finish_reason mapping', () => {
  const cases = [
    { input: 'stop', expected: 'end_turn' },
    { input: 'length', expected: 'max_tokens' },
    { input: 'tool_calls', expected: 'tool_use' },
    { input: 'content_filter', expected: 'end_turn' },
    { input: 'unknown', expected: 'end_turn' },
  ];
  for (const { input, expected } of cases) {
    const result = openAIToAnthropic({
      choices: [{ message: { content: 'x' }, finish_reason: input }],
    });
    assert.equal(result.stop_reason, expected, `finish_reason=${input} → ${expected}`);
  }
});

// ─── openAIChunkToAnthropicEvents: text only ──────────────────────

test('stream: text only', () => {
  const state = { model: 'mimo-v2.5-pro' };
  const allEvents = [];

  const chunks = [
    { id: 'cmpl-1', model: 'mimo-v2.5-pro', choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'cmpl-1', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
    { id: 'cmpl-1', model: 'mimo-v2.5-pro', choices: [{ delta: { content: ' world' }, finish_reason: null }] },
    { id: 'cmpl-1', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 2 } },
  ];

  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  // message_start
  assert.equal(allEvents[0].type, 'message_start');
  assert.equal(allEvents[0].message.model, 'mimo-v2.5-pro');

  // content_block_start for text
  const blockStart = allEvents.find(e => e.type === 'content_block_start' && e.content_block.type === 'text');
  assert.ok(blockStart, 'should have text content_block_start');

  // text deltas
  const textDeltas = allEvents.filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta');
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas[0].delta.text, 'Hello');
  assert.equal(textDeltas[1].delta.text, ' world');

  // content_block_stop
  const blockStop = allEvents.find(e => e.type === 'content_block_stop');
  assert.ok(blockStop, 'should have content_block_stop');

  // message_delta + message_stop
  const msgDelta = allEvents.find(e => e.type === 'message_delta');
  assert.ok(msgDelta, 'should have message_delta');
  assert.equal(msgDelta.delta.stop_reason, 'end_turn');

  const msgStop = allEvents.find(e => e.type === 'message_stop');
  assert.ok(msgStop, 'should have message_stop');
});

// ─── openAIChunkToAnthropicEvents: reasoning only ─────────────────

test('stream: reasoning only (no text content)', () => {
  const state = { model: 'mimo-v2.5-pro' };
  const allEvents = [];

  const chunks = [
    { id: 'cmpl-r1', model: 'mimo-v2.5-pro', choices: [{ delta: { reasoning_content: 'Thinking step 1...' }, finish_reason: null }] },
    { id: 'cmpl-r1', model: 'mimo-v2.5-pro', choices: [{ delta: { reasoning_content: 'Thinking step 2...' }, finish_reason: null }] },
    { id: 'cmpl-r1', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 50 } },
  ];

  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  // Should have thinking block
  const thinkingStart = allEvents.find(e => e.type === 'content_block_start' && e.content_block.type === 'thinking');
  assert.ok(thinkingStart, 'should have thinking content_block_start');

  const thinkingDeltas = allEvents.filter(e => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta');
  assert.equal(thinkingDeltas.length, 2);

  // Should have content_block_stop for thinking
  const blockStop = allEvents.find(e => e.type === 'content_block_stop');
  assert.ok(blockStop, 'should have content_block_stop for thinking');

  // stop_reason should be max_tokens
  const msgDelta = allEvents.find(e => e.type === 'message_delta');
  assert.equal(msgDelta.delta.stop_reason, 'max_tokens');
});

// ─── openAIChunkToAnthropicEvents: reasoning + text ───────────────

test('stream: reasoning then text', () => {
  const state = { model: 'mimo-v2.5-pro' };
  const allEvents = [];

  const chunks = [
    { id: 'cmpl-rt', model: 'mimo-v2.5-pro', choices: [{ delta: { reasoning_content: 'Let me think...' }, finish_reason: null }] },
    { id: 'cmpl-rt', model: 'mimo-v2.5-pro', choices: [{ delta: { reasoning_content: 'More thoughts...' }, finish_reason: null }] },
    { id: 'cmpl-rt', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'The answer is' }, finish_reason: null }] },
    { id: 'cmpl-rt', model: 'mimo-v2.5-pro', choices: [{ delta: { content: ' 42.' }, finish_reason: null }] },
    { id: 'cmpl-rt', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 10 } },
  ];

  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  // thinking block should come before text block
  const thinkingStart = allEvents.findIndex(e => e.type === 'content_block_start' && e.content_block.type === 'thinking');
  const textStart = allEvents.findIndex(e => e.type === 'content_block_start' && e.content_block.type === 'text');
  assert.ok(thinkingStart < textStart, 'thinking block should start before text block');

  // thinking block should be closed before text block opens
  const thinkingStop = allEvents.findIndex(e => e.type === 'content_block_stop' && e.index === allEvents[thinkingStart].index);
  assert.ok(thinkingStop < textStart, 'thinking block should stop before text block starts');

  // text deltas
  const textDeltas = allEvents.filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta');
  assert.equal(textDeltas.length, 2);
  assert.equal(textDeltas[0].delta.text, 'The answer is');
  assert.equal(textDeltas[1].delta.text, ' 42.');

  // final events
  const msgStop = allEvents.find(e => e.type === 'message_stop');
  assert.ok(msgStop, 'should have message_stop');
});

// ─── openAIChunkToAnthropicEvents: tool calls ─────────────────────

test('stream: tool calls', () => {
  const state = { model: 'mimo-v2.5-pro' };
  const allEvents = [];

  const chunks = [
    { id: 'cmpl-tc', model: 'mimo-v2.5-pro', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '' } }] }, finish_reason: null }] },
    { id: 'cmpl-tc', model: 'mimo-v2.5-pro', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"' } }] }, finish_reason: null }] },
    { id: 'cmpl-tc', model: 'mimo-v2.5-pro', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'weather"}' } }] }, finish_reason: null }] },
    { id: 'cmpl-tc', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 8 } },
  ];

  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  // tool_use block
  const toolStart = allEvents.find(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
  assert.ok(toolStart, 'should have tool_use content_block_start');
  assert.equal(toolStart.content_block.name, 'search');
  assert.equal(toolStart.content_block.id, 'call_1');

  // input_json deltas
  const jsonDeltas = allEvents.filter(e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta');
  assert.equal(jsonDeltas.length, 2);
  assert.equal(jsonDeltas[0].delta.partial_json, '{"q":"');
  assert.equal(jsonDeltas[1].delta.partial_json, 'weather"}');

  // stop_reason
  const msgDelta = allEvents.find(e => e.type === 'message_delta');
  assert.equal(msgDelta.delta.stop_reason, 'tool_use');
});

// ─── openAIChunkToAnthropicEvents: empty delta ────────────────────

test('stream: empty delta (no content, no reasoning, no tools)', () => {
  const state = { model: 'mimo-v2.5-pro' };
  const chunk = { id: 'cmpl-empty', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: null }] };
  const events = openAIChunkToAnthropicEvents(chunk, state);

  // Empty delta on first call still triggers message_start
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message_start');
});

// ─── openAIChunkToAnthropicEvents: [DONE] simulation ──────────────

test('stream: [DONE] is handled by finish_reason', () => {
  const state = { model: 'mimo-v2.5-pro' };
  // Simulate a stream that ends with a final chunk having finish_reason
  const chunks = [
    { id: 'cmpl-done', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
    { id: 'cmpl-done', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 1 } },
  ];

  const allEvents = [];
  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  const msgStop = allEvents.find(e => e.type === 'message_stop');
  assert.ok(msgStop, 'should have message_stop for [DONE]');
});

// ─── openAIChunkToAnthropicEvents: length stop ────────────────────

test('stream: length stop_reason', () => {
  const state = { model: 'mimo-v2.5-pro' };
  const allEvents = [];

  const chunks = [
    { id: 'cmpl-len', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
    { id: 'cmpl-len', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 32 } },
  ];

  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  const msgDelta = allEvents.find(e => e.type === 'message_delta');
  assert.equal(msgDelta.delta.stop_reason, 'max_tokens');
});

// ─── openAIChunkToAnthropicEvents: state management ───────────────

test('stream: state accumulates across chunks', () => {
  const state = { model: 'mimo-v2.5-pro' };

  // First chunk: starts message
  openAIChunkToAnthropicEvents(
    { id: 'cmpl-s1', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'a' }, finish_reason: null }] },
    state
  );
  assert.equal(state.started, true);
  assert.equal(state.textStarted, true);

  // Second chunk: continues text (no duplicate message_start)
  const events2 = openAIChunkToAnthropicEvents(
    { id: 'cmpl-s1', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'b' }, finish_reason: null }] },
    state
  );
  const msgStarts = events2.filter(e => e.type === 'message_start');
  assert.equal(msgStarts.length, 0, 'should not emit duplicate message_start');
});

test('stream: blockIndex increments correctly', () => {
  const state = { model: 'mimo-v2.5-pro' };

  // reasoning → text → finish
  const chunks = [
    { id: 'cmpl-idx', model: 'mimo-v2.5-pro', choices: [{ delta: { reasoning_content: 'think' }, finish_reason: null }] },
    { id: 'cmpl-idx', model: 'mimo-v2.5-pro', choices: [{ delta: { content: 'text' }, finish_reason: null }] },
    { id: 'cmpl-idx', model: 'mimo-v2.5-pro', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 3 } },
  ];

  const allEvents = [];
  for (const chunk of chunks) {
    allEvents.push(...openAIChunkToAnthropicEvents(chunk, state));
  }

  // thinking block at index 0, text block at index 1
  const thinkingStart = allEvents.find(e => e.type === 'content_block_start' && e.content_block.type === 'thinking');
  const textStart = allEvents.find(e => e.type === 'content_block_start' && e.content_block.type === 'text');
  assert.equal(thinkingStart.index, 0);
  assert.equal(textStart.index, 1);

  assert.equal(state.blockIndex, 2, 'blockIndex should be 2 after thinking + text');
});

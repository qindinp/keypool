import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripUnsupportedParams, fixMimoReasoningContent, getMimoTunnelTimeoutMs } from '../src/gateway/proxy.mjs';

describe('stripUnsupportedParams', () => {
  it('strips n parameter', () => {
    const result = stripUnsupportedParams('{"model":"mimo-v2.5-pro","n":2,"messages":[]}');
    assert.ok(result);
    assert.equal(JSON.parse(result.strippedBody).n, undefined);
    assert.deepEqual(result.removedParams, ['n=2']);
  });

  it('strips logprobs and top_logprobs', () => {
    const result = stripUnsupportedParams('{"model":"mimo-v2.5-pro","logprobs":true,"top_logprobs":5,"messages":[]}');
    assert.ok(result);
    const parsed = JSON.parse(result.strippedBody);
    assert.equal(parsed.logprobs, undefined);
    assert.equal(parsed.top_logprobs, undefined);
    assert.equal(parsed.model, 'mimo-v2.5-pro');
  });

  it('strips multiple unsupported params together', () => {
    const result = stripUnsupportedParams('{"model":"mimo-v2.5-pro","n":3,"logprobs":true,"top_logprobs":10,"temperature":0.7,"messages":[]}');
    assert.ok(result);
    const parsed = JSON.parse(result.strippedBody);
    assert.equal(parsed.n, undefined);
    assert.equal(parsed.logprobs, undefined);
    assert.equal(parsed.top_logprobs, undefined);
    assert.equal(parsed.temperature, 0.7); // supported param kept
    assert.equal(parsed.model, 'mimo-v2.5-pro');
  });

  it('strips OpenAI/QClaw extra params that MiMo rejects', () => {
    const result = stripUnsupportedParams(JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [],
      store: true,
      parallel_tool_calls: true,
      text_verbosity: 'medium',
      verbosity: 'low',
      reasoning_effort: 'medium',
    }));
    assert.ok(result);
    const parsed = JSON.parse(result.strippedBody);
    assert.equal(parsed.store, undefined);
    assert.equal(parsed.parallel_tool_calls, undefined);
    assert.equal(parsed.text_verbosity, undefined);
    assert.equal(parsed.verbosity, undefined);
    assert.equal(parsed.reasoning_effort, undefined);
    assert.equal(parsed.model, 'mimo-v2.5-pro');
  });

  it('maps max_completion_tokens to max_tokens for MiMo', () => {
    const result = stripUnsupportedParams(JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [],
      max_completion_tokens: 123,
    }));
    assert.ok(result);
    const parsed = JSON.parse(result.strippedBody);
    assert.equal(parsed.max_completion_tokens, undefined);
    assert.equal(parsed.max_tokens, 123);
  });

  it('drops max_completion_tokens when max_tokens is already present', () => {
    const result = stripUnsupportedParams(JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [],
      max_tokens: 50,
      max_completion_tokens: 123,
    }));
    assert.ok(result);
    const parsed = JSON.parse(result.strippedBody);
    assert.equal(parsed.max_completion_tokens, undefined);
    assert.equal(parsed.max_tokens, 50);
  });

  it('strips unknown top-level params for MiMo by default', () => {
    const result = stripUnsupportedParams(JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [],
      made_up_openai_future_param: { enabled: true },
    }));
    assert.ok(result);
    const parsed = JSON.parse(result.strippedBody);
    assert.equal(parsed.made_up_openai_future_param, undefined);
    assert.deepEqual(Object.keys(parsed).sort(), ['messages', 'model']);
    assert.equal(result.removedParams[0].startsWith('unknown:made_up_openai_future_param='), true);
  });

  it('does not strip params for non-MiMo models', () => {
    const body = JSON.stringify({
      model: 'gpt-4.1',
      messages: [],
      store: true,
      max_completion_tokens: 123,
    });
    const result = stripUnsupportedParams(body);
    assert.equal(result, null);
  });

  it('returns null when no unsupported params present', () => {
    const result = stripUnsupportedParams('{"model":"mimo-v2.5-pro","temperature":0.7,"messages":[]}');
    assert.equal(result, null);
  });

  it('returns null for null/undefined/empty body', () => {
    assert.equal(stripUnsupportedParams(null), null);
    assert.equal(stripUnsupportedParams(undefined), null);
    assert.equal(stripUnsupportedParams(''), null);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(stripUnsupportedParams('not json'), null);
  });

  it('preserves all supported params', () => {
    const body = JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 100,
      stream: true,
      stop: ['\n'],
      presence_penalty: 0.3,
      frequency_penalty: 0.2,
    });
    const result = stripUnsupportedParams(body);
    assert.equal(result, null); // nothing to strip
  });
});

describe('fixMimoReasoningContent', () => {
  it('does not inject reasoning_content:null into assistant tool_call messages', () => {
    const body = JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      ],
    });
    const result = fixMimoReasoningContent(body, 'mimo-v2.5-pro');
    assert.equal(result.patched, false);
    const parsed = JSON.parse(result.fixedBody);
    assert.equal('reasoning_content' in parsed.messages[0], false);
  });

  it('still injects reasoning_content:null into non-tool assistant messages', () => {
    const body = JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'assistant', content: 'hello' }],
    });
    const result = fixMimoReasoningContent(body, 'mimo-v2.5-pro');
    assert.equal(result.patched, true);
    const parsed = JSON.parse(result.fixedBody);
    assert.equal(parsed.messages[0].reasoning_content, null);
  });

  it('preserves existing reasoning_content', () => {
    const body = JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'think' }],
    });
    const result = fixMimoReasoningContent(body, 'mimo-v2.5-pro');
    assert.equal(result.patched, false);
    assert.equal(JSON.parse(result.fixedBody).messages[0].reasoning_content, 'think');
  });
});

describe('getMimoTunnelTimeoutMs', () => {
  it('returns 10 minutes for MiMo requests', () => {
    assert.equal(getMimoTunnelTimeoutMs('{"messages":[]}', 'mimo-v2.5-pro'), 600_000);
  });

  it('returns default timeout for non-MiMo requests', () => {
    assert.equal(getMimoTunnelTimeoutMs('{"messages":[]}', 'gpt-4'), 120_000);
  });
});

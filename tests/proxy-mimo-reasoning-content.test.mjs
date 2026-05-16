import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixMimoReasoningContent } from '../src/gateway/proxy.mjs';

const MODEL = 'mimo-v2.5-pro';

describe('fixMimoReasoningContent', () => {
  it('injects null only for assistant messages with tool_calls', () => {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'assistant', content: 'Synthetic compaction summary.' },
        { role: 'assistant', content: 'Calling tool', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
        { role: 'assistant', content: 'Already has it', reasoning_content: 'kept' },
      ],
    };

    const result = fixMimoReasoningContent(body, MODEL);
    assert.ok(result);
    assert.equal(result.patched, true);

    assert.equal('reasoning_content' in result.result.messages[1], false, 'summary-like assistant message should not be polluted');
    assert.equal(result.result.messages[2].reasoning_content, null, 'tool-call assistant should be patched');
    assert.equal(result.result.messages[3].reasoning_content, 'kept', 'existing reasoning_content should be preserved');
  });

  it('skips malformed message entries instead of failing the whole shim', () => {
    const body = {
      model: MODEL,
      messages: [
        null,
        'not an object',
        [{ role: 'assistant' }],
        { role: 'assistant', content: 'Calling tool', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      ],
    };

    const result = fixMimoReasoningContent(body, MODEL);
    assert.ok(result);
    assert.equal(result.patched, true);

    assert.equal(result.result.messages[3].reasoning_content, null);
  });

  it('does not patch non-MiMo models', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'assistant', content: 'Calling tool', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      ],
    };

    const result = fixMimoReasoningContent(body, 'gpt-4');
    assert.equal(result, null);
  });
});

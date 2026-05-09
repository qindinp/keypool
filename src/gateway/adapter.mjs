/**
 * Anthropic ↔ OpenAI 格式转换适配器
 *
 * 迁移自 server/anthropic-adapter.mjs
 * 支持：文本、图片、Tool use/result、流式 thinking → reasoning_content
 */

// ─── 请求转换 ────────────────────────────────────────────────────

/** Anthropic messages → OpenAI chat completions */
export function anthropicToOpenAI(body) {
  const messages = [];

  // system
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system.map((b) => b.text || '').join('\n');
      messages.push({ role: 'system', content: text });
    }
  }

  // messages
  for (const msg of body.messages || []) {
    const role = msg.role;
    let content;
    let toolCalls = undefined;

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts = [];
      const tcParts = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push(block.text);
        } else if (block.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: {
              url: block.source?.type === 'base64'
                ? `data:${block.source.media_type};base64,${block.source.data}`
                : block.source?.url || '',
            },
          });
        } else if (block.type === 'tool_use') {
          tcParts.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === 'tool_result') {
          let resultContent;
          if (typeof block.content === 'string') {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            const rParts = [];
            for (const b of block.content) {
              if (b.type === 'text') {
                rParts.push({ type: 'text', text: b.text });
              } else if (b.type === 'image') {
                rParts.push({
                  type: 'image_url',
                  image_url: {
                    url: b.source?.type === 'base64'
                      ? `data:${b.source.media_type};base64,${b.source.data}`
                      : b.source?.url || '',
                  },
                });
              }
            }
            if (rParts.length === 1 && rParts[0].type === 'text') {
              resultContent = rParts[0].text;
            } else if (rParts.length === 0) {
              resultContent = '';
            } else {
              resultContent = rParts;
            }
          } else {
            resultContent = JSON.stringify(block.content || '');
          }
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
          continue;
        }
      }

      if (tcParts.length > 0) {
        toolCalls = tcParts;
        content = parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts.length > 0 ? parts : undefined;
      } else {
        content = parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
      }
    }

    const oaiMsg = { role, content };
    if (toolCalls) oaiMsg.tool_calls = toolCalls;
    if (content !== undefined || toolCalls) {
      messages.push(oaiMsg);
    }
  }

  const result = {
    model: body.model || 'gpt-4',
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences) result.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    }));
  }

  return result;
}

// ─── 响应转换 ────────────────────────────────────────────────────

function randomId() {
  return Math.random().toString(36).slice(2, 14);
}

/** OpenAI response → Anthropic message format */
export function openAIToAnthropic(oaiResp, model) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: `msg_${oaiResp.id || randomId()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];

  if (choice.message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
  }

  if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const stopReason = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'end_turn',
  }[choice.finish_reason] || 'end_turn';

  return {
    id: `msg_${oaiResp.id || randomId()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ─── 流式转换 ────────────────────────────────────────────────────

/** OpenAI SSE chunk → Anthropic SSE events */
export function openAIChunkToAnthropicEvents(chunk, state) {
  const events = [];
  const choice = chunk.choices?.[0];
  if (!choice) return events;

  if (!state.started) {
    state.started = true;
    events.push({
      type: 'message_start',
      message: {
        id: `msg_${chunk.id || randomId()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model || state.model,
        stop_reason: null,
        usage: { input_tokens: chunk.usage?.prompt_tokens || 0, output_tokens: 0 },
      },
    });
  }

  if (choice.delta?.reasoning_content) {
    if (!state.thinkingStarted) {
      state.thinkingStarted = true;
      events.push({
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
    }
    events.push({
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'thinking_delta', thinking: choice.delta.reasoning_content },
    });
  }

  if (Array.isArray(choice.delta?.tool_calls)) {
    for (const tc of choice.delta.tool_calls) {
      const tcIndex = tc.index ?? 0;
      const stateKey = `tool_${tcIndex}`;

      if (!state[stateKey]) {
        if (state.thinkingStarted && !state.thinkingClosed) {
          state.thinkingClosed = true;
          events.push({ type: 'content_block_stop', index: state.blockIndex });
          state.blockIndex++;
        }
        if (state.textStarted && !state.textClosed) {
          state.textClosed = true;
          events.push({ type: 'content_block_stop', index: state.blockIndex });
          state.blockIndex++;
        }

        if (state.toolBlockStart === undefined) {
          state.toolBlockStart = state.blockIndex;
        }

        state[stateKey] = { started: true, name: tc.function?.name || '' };
        events.push({
          type: 'content_block_start',
          index: state.toolBlockStart + tcIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || '',
            input: {},
          },
        });
      }

      if (tc.function?.arguments) {
        events.push({
          type: 'content_block_delta',
          index: state.toolBlockStart + tcIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: tc.function.arguments,
          },
        });
      }
    }
  }

  if (choice.delta?.content) {
    if (!state.textStarted) {
      if (state.thinkingStarted && !state.thinkingClosed) {
        state.thinkingClosed = true;
        events.push({ type: 'content_block_stop', index: state.blockIndex });
        state.blockIndex++;
      }
      state.textStarted = true;
      events.push({
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    events.push({
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'text_delta', text: choice.delta.content },
    });
  }

  if (choice.finish_reason) {
    if (state.textStarted && !state.textClosed) {
      state.textClosed = true;
      events.push({ type: 'content_block_stop', index: state.blockIndex });
      state.blockIndex++;
    } else if (state.thinkingStarted && !state.thinkingClosed) {
      state.thinkingClosed = true;
      events.push({ type: 'content_block_stop', index: state.blockIndex });
      state.blockIndex++;
    }
    const toolStart = state.toolBlockStart ?? state.blockIndex;
    for (const key of Object.keys(state)) {
      if (key.startsWith('tool_') && state[key]?.started && !state[key]?.closed) {
        state[key].closed = true;
        const idx = parseInt(key.slice(5));
        events.push({ type: 'content_block_stop', index: toolStart + idx });
      }
    }

    const stopReason = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
    }[choice.finish_reason] || 'end_turn';

    events.push({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: chunk.usage?.completion_tokens || 0 },
    });
    events.push({ type: 'message_stop' });
  }

  return events;
}

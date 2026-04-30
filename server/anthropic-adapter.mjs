/**
 * KeyPool — Anthropic ↔ OpenAI 格式转换
 *
 * 支持：
 *   - 文本消息（system / user / assistant）
 *   - 图片（base64 / url）
 *   - Tool use (tool_use → tool_calls)
 *   - Tool result (tool_result → tool role message)
 *   - 流式 thinking → reasoning_content
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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
          // tool_use → OpenAI tool_calls 格式
          tcParts.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === 'tool_result') {
          // tool_result → tool role message
          let resultContent;
          if (typeof block.content === 'string') {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
          } else {
            resultContent = JSON.stringify(block.content || '');
          }
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
          continue; // 不走下面的 messages.push
        }
      }

      // 如果有 tool_calls，设置到 assistant 消息上
      if (tcParts.length > 0) {
        toolCalls = tcParts;
        // 如果同时有文本，也要保留
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

  // 转换 Anthropic tools → OpenAI tools
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

  // reasoning_content → thinking block
  if (choice.message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: choice.message.reasoning_content });
  }

  // tool_calls → tool_use blocks
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

  // 文本内容
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

  // 首个 chunk → message_start
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

  // reasoning_content → thinking delta
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

  // tool_calls → tool_use delta
  if (Array.isArray(choice.delta?.tool_calls)) {
    for (const tc of choice.delta.tool_calls) {
      // 关闭之前的 thinking/text block
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

      const tcIndex = tc.index ?? 0;
      const stateKey = `tool_${tcIndex}`;

      if (!state[stateKey]) {
        state[stateKey] = { started: true, name: tc.function?.name || '' };
        events.push({
          type: 'content_block_start',
          index: state.blockIndex + tcIndex,
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
          index: state.blockIndex + tcIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: tc.function.arguments,
          },
        });
      }
    }
  }

  // content → text delta
  if (choice.delta?.content) {
    if (!state.textStarted) {
      // 关闭 thinking block
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

  // finish → stop
  if (choice.finish_reason) {
    // 关闭未关的 block
    if (state.textStarted && !state.textClosed) {
      state.textClosed = true;
      events.push({ type: 'content_block_stop', index: state.blockIndex });
    } else if (state.thinkingStarted && !state.thinkingClosed) {
      state.thinkingClosed = true;
      events.push({ type: 'content_block_stop', index: state.blockIndex });
    }
    // 关闭 tool_use blocks
    for (const key of Object.keys(state)) {
      if (key.startsWith('tool_') && state[key]?.started && !state[key]?.closed) {
        state[key].closed = true;
        const idx = parseInt(key.slice(5));
        events.push({ type: 'content_block_stop', index: state.blockIndex + idx });
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

// ─── Anthropic 流式代理 ──────────────────────────────────────────

/** 同步代理：Anthropic 请求 → OpenAI 上游 → Anthropic 响应 */
export function proxyAnthropicSync(keyEntry, openaiReq, model, res, pool, log, maxRetries, retryCount = 0) {
  const target = pool.getTargetFor(keyEntry);
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${keyEntry.key}`,
  };
  const body = JSON.stringify(openaiReq);
  const requester = target.isHttps ? httpsRequest : httpRequest;

  const proxyReq = requester({
    hostname: target.hostname,
    port: target.port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: { ...headers, 'content-length': Buffer.byteLength(body) },
  }, (proxyRes) => {
    let respBody = '';
    proxyRes.on('data', (c) => (respBody += c));
    proxyRes.on('end', () => {
      if (proxyRes.statusCode >= 400) {
        pool.markError(keyEntry, proxyRes.statusCode, respBody);

        if ([401, 403, 429].includes(proxyRes.statusCode) && retryCount < maxRetries) {
          const retryKey = pool.pick();
          if (retryKey && retryKey.id !== keyEntry.id) {
            log('info', `Anthropic retry with key ${retryKey.id} (attempt ${retryCount + 1}/${maxRetries})`);
            return proxyAnthropicSync(retryKey, openaiReq, model, res, pool, log, maxRetries, retryCount + 1);
          }
        }

        res.writeHead(proxyRes.statusCode, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: respBody } }));
      }

      try {
        const oaiResp = JSON.parse(respBody);
        const anthropicResp = openAIToAnthropic(oaiResp, model);
        const tokens = oaiResp.usage?.total_tokens || 0;
        pool.markSuccess(keyEntry, tokens);
        log('info', `✓ /v1/messages [${keyEntry.id}] ${tokens} tokens (anthropic)`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthropicResp));
      } catch (e) {
        log('error', `Anthropic response conversion error: ${e.message}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
      }
    });
  });

  proxyReq.setTimeout(120_000, () => {
    proxyReq.destroy(new Error('Anthropic upstream timeout'));
  });

  proxyReq.on('error', (err) => {
    pool.markError(keyEntry, 0, err.message);
    log('error', `Anthropic proxy error [${keyEntry.id}]: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
  });

  proxyReq.write(body);
  proxyReq.end();
}

/** 流式代理：Anthropic SSE 请求 → OpenAI 流式上游 → Anthropic SSE 事件 */
export function proxyAnthropicStream(keyEntry, openaiReq, model, res, pool, log, maxRetries, retryCount = 0) {
  const target = pool.getTargetFor(keyEntry);
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${keyEntry.key}`,
  };
  const body = JSON.stringify({ ...openaiReq, stream: true });
  const requester = target.isHttps ? httpsRequest : httpRequest;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });

  const state = {
    started: false, blockIndex: 0,
    thinkingStarted: false, thinkingClosed: false,
    textStarted: false, textClosed: false,
    model,
  };

  const proxyReq = requester({
    hostname: target.hostname,
    port: target.port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: { ...headers, 'content-length': Buffer.byteLength(body) },
  }, (proxyRes) => {
    if (proxyRes.statusCode >= 400) {
      let errBody = '';
      proxyRes.on('data', (c) => (errBody += c));
      proxyRes.on('end', () => {
        pool.markError(keyEntry, proxyRes.statusCode, errBody);

        if ([401, 403, 429].includes(proxyRes.statusCode) && retryCount < maxRetries) {
          const retryKey = pool.pick();
          if (retryKey && retryKey.id !== keyEntry.id) {
            // 已经写了 200 header，只能发 error event
            const event = { type: 'error', error: { type: 'api_error', message: `Retrying with another key...` } };
            res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
            // 实际上没法重试了（header 已发），记录日志
            log('warn', `Stream error ${proxyRes.statusCode} but headers already sent, cannot retry`);
            res.end();
            return;
          }
        }

        const event = { type: 'error', error: { type: 'api_error', message: errBody } };
        res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
      return;
    }

    let buffer = '';
    let usage = null;

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const oaiChunk = JSON.parse(data);
          if (oaiChunk.usage) usage = oaiChunk.usage;
          const events = openAIChunkToAnthropicEvents(oaiChunk, state);
          for (const event of events) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        } catch {}
      }
    });

    proxyRes.on('end', () => {
      // 处理 buffer 中剩余数据
      if (buffer.startsWith('data: ') && buffer.slice(6).trim() !== '[DONE]') {
        try {
          const oaiChunk = JSON.parse(buffer.slice(6));
          if (oaiChunk.usage) usage = oaiChunk.usage;
          const events = openAIChunkToAnthropicEvents(oaiChunk, state);
          for (const event of events) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        } catch {}
      }

      // 确保 message_stop 被发送
      if (!state.textClosed && !state.thinkingClosed) {
        if (state.started) {
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        }
      }

      res.end();
      const tokens = usage?.total_tokens || 0;
      pool.markSuccess(keyEntry, tokens);
      log('info', `✓ /v1/messages [${keyEntry.id}] ${tokens} tokens (anthropic stream)`);
    });
  });

  proxyReq.setTimeout(120_000, () => {
    proxyReq.destroy(new Error('Anthropic stream upstream timeout'));
  });

  proxyReq.on('error', (err) => {
    pool.markError(keyEntry, 0, err.message);
    log('error', `Anthropic stream proxy error [${keyEntry.id}]: ${err.message}`);
    if (!res.headersSent) {
      const event = { type: 'error', error: { type: 'proxy_error', message: err.message } };
      res.write(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });

  proxyReq.write(body);
  proxyReq.end();
}

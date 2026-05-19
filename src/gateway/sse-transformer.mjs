/**
 * SSE 转换器 — OpenAI chunk → Anthropic events
 *
 * 提取自 index.mjs handleAnthropicRequest 中重复的隧道/HTTP 流式解析逻辑。
 */

import { openAIChunkToAnthropicEvents } from './adapter.mjs';

/**
 * 创建 SSE 转换器
 * @param {object} state - 转换状态（started, blockIndex, thinking*, text*, model）
 * @param {import('node:http').ServerResponse} res - HTTP 响应对象
 * @returns {{ processChunk: (buf: Buffer) => void, flush: () => void }}
 */
export function createSSETransformer(state, res) {
  const bufParts = [];
  let bufLen = 0;

  function drainLines() {
    const combined = Buffer.concat(bufParts).toString('utf8');
    bufParts.length = 0;
    bufLen = 0;

    let start = 0;
    let nlIdx;
    while ((nlIdx = combined.indexOf('\n', start)) !== -1) {
      const line = combined.slice(start, nlIdx).trim();
      start = nlIdx + 1;
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const oaiChunk = JSON.parse(payload);
        const events = openAIChunkToAnthropicEvents(oaiChunk, state);
        for (const event of events) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        console.warn(`⚠️ SSE chunk parse error: ${err.message}`);
      }
    }

    // 保留最后未完成的行
    if (start < combined.length) {
      const remaining = Buffer.from(combined.slice(start), 'utf8');
      bufParts.push(remaining);
      bufLen += remaining.length;
    }
  }

  function processChunk(buf) {
    bufParts.push(buf);
    bufLen += buf.length;
    // 仅当 buffer 包含换行时才尝试切行
    if (buf.includes(10)) {
      drainLines();
    }
  }

  function flush() {
    // 处理残留的最后一行
    if (bufLen > 0) {
      const combined = Buffer.concat(bufParts).toString('utf8').trim();
      bufParts.length = 0;
      bufLen = 0;
      if (combined && combined.startsWith('data: ')) {
        const payload = combined.slice(6).trim();
        if (payload !== '[DONE]') {
          try {
            const oaiChunk = JSON.parse(payload);
            const events = openAIChunkToAnthropicEvents(oaiChunk, state);
            for (const event of events) {
              res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
          } catch {}
        }
      }
    }
    // 确保 message_stop
    if (state.started && !state.textClosed && !state.thinkingClosed) {
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    }
  }

  return { processChunk, flush };
}

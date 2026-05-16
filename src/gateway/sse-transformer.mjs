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
  let lineBuf = '';

  function processChunk(buf) {
    lineBuf += buf.toString();
    let nlIdx;
    while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nlIdx).trim();
      lineBuf = lineBuf.slice(nlIdx + 1);
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
  }

  function flush() {
    // 处理 lineBuf 中可能残留的最后一行
    if (lineBuf.trim()) {
      const line = lineBuf.trim();
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
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

/**
 * 共享 WebSocket 帧解析/构造模块
 *
 * 消除以下文件中的重复定义：
 *   - ws-client.mjs              (wsFrame, parseFrames — 含分片支持)
 *   - controller/deploy-client.mjs (wsFrame, parseFrames, extractTextContent, collectTextCandidates)
 *   - ws-probe.mjs               (parseFrames)
 */

import { randomBytes } from 'node:crypto';

/**
 * 构造 WebSocket 帧（客户端 → 服务端，带 mask）
 *
 * @param {string|Buffer} data - 要发送的数据
 * @param {number} opcode - 帧类型 (0x01=text, 0x02=binary, 0x08=close, 0x09=ping)
 * @returns {Buffer}
 */
export function wsFrame(data, opcode = 0x01) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(header, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * 解析 WebSocket 帧，支持分片消息拼接
 *
 * WebSocket 协议中，一条消息可能被拆成多个帧：
 *   - 首帧: opcode=0x01(text)/0x02(binary), fin=0
 *   - 后续帧: opcode=0x00(continuation), fin=0
 *   - 末帧: opcode=0x00(continuation), fin=1
 *
 * @param {Buffer} buf - 待解析的缓冲区
 * @returns {{ messages: Array<{opcode: number, payload: Buffer}>, remaining: Buffer }}
 */
export function parseFrames(buf) {
  const messages = [];
  let off = 0;
  // 分片缓冲
  let fragOpcode = 0;
  let fragParts = [];

  while (off + 2 <= buf.length) {
    const byte1 = buf[off], byte2 = buf[off + 1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    let payloadLen = byte2 & 0x7f, hdrLen = 2;
    if (payloadLen === 126) {
      if (off + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(off + 2);
      hdrLen = 4;
    } else if (payloadLen === 127) {
      if (off + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(off + 2));
      hdrLen = 10;
    }
    if (off + hdrLen + payloadLen > buf.length) break;

    const payload = buf.slice(off + hdrLen, off + hdrLen + payloadLen);
    off += hdrLen + payloadLen;

    if (opcode === 0x00) {
      // continuation frame
      fragParts.push(payload);
      if (fin) {
        messages.push({ opcode: fragOpcode, payload: Buffer.concat(fragParts) });
        fragOpcode = 0;
        fragParts = [];
      }
    } else if (opcode === 0x01 || opcode === 0x02) {
      // text or binary — may be a fragment or a complete message
      if (fin) {
        messages.push({ opcode, payload });
      } else {
        fragOpcode = opcode;
        fragParts = [payload];
      }
    } else {
      // control frames (ping/pong/close) are always complete
      messages.push({ opcode, payload });
    }
  }

  return { messages, remaining: buf.slice(off) };
}

/**
 * 从消息内容中提取纯文本
 * 支持 string、content blocks array 等格式
 *
 * @param {*} content - 消息内容
 * @returns {string}
 */
export function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
  }
  return '';
}

/**
 * 从嵌套结构中递归收集所有文本候选项
 * 用于 deploy-client 从 WebSocket 事件中提取 AI 回复文本
 *
 * @param {*} value - 要遍历的对象
 * @param {Set} [seen] - 去重集合
 * @returns {string[]}
 */
export function collectTextCandidates(value, seen = new Set()) {
  const push = (text) => {
    const normalized = String(text || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
  };

  const visit = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;

    const direct = extractTextContent(node.content);
    if (direct) push(direct);
    if (typeof node.text === 'string') push(node.text);
    if (typeof node.message === 'string') push(node.message);
    if (typeof node.delta === 'string') push(node.delta);
    if (typeof node.output_text === 'string') push(node.output_text);
    if (typeof node.reasoning_text === 'string') push(node.reasoning_text);

    if (node.message && typeof node.message === 'object') visit(node.message);
    if (node.delta && typeof node.delta === 'object') visit(node.delta);
    if (node.content && typeof node.content === 'object') visit(node.content);
    if (node.parts && Array.isArray(node.parts)) visit(node.parts);
    if (node.blocks && Array.isArray(node.blocks)) visit(node.blocks);
    if (node.items && Array.isArray(node.items)) visit(node.items);
    if (node.messages && Array.isArray(node.messages)) visit(node.messages);
    if (node.events && Array.isArray(node.events)) visit(node.events);
    if (node.output && typeof node.output === 'object') visit(node.output);
    if (node.payload && typeof node.payload === 'object') visit(node.payload);
  };

  visit(value);
  return [...seen];
}

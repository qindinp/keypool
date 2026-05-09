/**
 * 共享 WebSocket 工具模块
 *
 * 提供文本内容提取函数，供 deploy-client.mjs 使用
 */

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

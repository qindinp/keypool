/**
 * 共享状态持久化模块
 *
 * 来源: controller/state-store.mjs
 * 变更: 移除默认路径（调用方必须显式传入 statePath）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 创建状态存储
 * @param {string} statePath - 状态文件的绝对路径（必填）
 * @returns {{ statePath: string, loadState: Function, saveState: Function }}
 */
export function createStateStore(statePath) {
  if (!statePath) {
    throw new Error('createStateStore: statePath is required');
  }

  function loadState() {
    try {
      return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf-8')) : {};
    } catch {
      return {};
    }
  }

  function saveState(state, log = () => {}) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    } catch (e) {
      log('error', `状态保存失败: ${e.message}`);
    }
  }

  return { statePath, loadState, saveState };
}

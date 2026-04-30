import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultStatePath = resolve(__dirname, '..', '.controller-state.json');

export function createStateStore(statePath = defaultStatePath) {
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

#!/usr/bin/env node
/**
 * KeyPool Bootstrap — 通过 Node.js fetch 从 Gateway 下载 skill 文件
 *
 * 使用 Node.js 内置 fetch（非 curl/wget），符合沙箱安全策略。
 * 总大小 < 1.5KB，完全在 WS 帧限制内。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const GATEWAY = '__KEYPOOL_GATEWAY_URL__';  // e.g. http://1.2.3.4:9300
const SKILL_DIR = '/root/.openclaw/skills/keypool-tunnel';
const ACCOUNT_ID = '__KEYPOOL_ACCOUNT_ID__';
const RUN_ID = '__KEYPOOL_RUN_ID__';

const FILES = [
  'SKILL.md',
  'scripts/tunnel-proxy.mjs',
  'scripts/lib/ws-client.mjs',
  'scripts/lib/api-handler.mjs',
];

console.log(`[bootstrap] downloading from ${GATEWAY}...`);

for (const file of FILES) {
  const url = `${GATEWAY}/files/skill/${file}`;
  console.log(`[bootstrap] GET ${file}...`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[bootstrap] failed: ${file} HTTP ${res.status}`);
    process.exit(1);
  }
  const content = await res.text();
  const target = join(SKILL_DIR, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
  console.log(`[bootstrap] wrote ${file} (${content.length} bytes)`);
}

// 验证
try {
  execSync(`node --check "${join(SKILL_DIR, 'scripts', 'tunnel-proxy.mjs')}"`);
  console.log('[bootstrap] syntax check passed');
} catch (e) {
  console.error('[bootstrap] syntax check failed:', e.stderr?.toString() || e.message);
  process.exit(1);
}

// 启动
try { execSync('pkill -f "tunnel-proxy.mjs" 2>/dev/null'); } catch {}
execSync(`nohup node "${join(SKILL_DIR, 'scripts', 'tunnel-proxy.mjs')}" > /tmp/tunnel-proxy.log 2>&1 &`);

console.log('[bootstrap] KEYPOOL_DONE');

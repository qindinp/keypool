/**
 * 共享 Cookie 与 MiMo 常量模块
 *
 * 消除以下文件中的重复定义：
 *   - controller/mimo-api.mjs   (getCookie, extractPhFromCookie, resolvePh)
 *   - controller/config.mjs     (BASE, PH)
 *   - ws-client.mjs             (getCookie, BASE, PH)
 *   - ws-probe.mjs              (getCookie, BASE, PH)
 *   - renew.mjs                 (getCookie, PH)
 *   - auto-renew.mjs            (PH)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** MiMo AI Studio 基础 URL */
export const BASE = 'https://aistudio.xiaomimimo.com';

/** 默认 PH cookie 值 */
export const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';

/**
 * 读取 Cookie
 * 优先级: MIMO_COOKIE 环境变量 > 项目根目录 .cookie 文件
 *
 * @param {string} [projectRoot] - 项目根目录，默认自动推断
 * @returns {string} cookie 字符串
 */
export function getCookie(projectRoot) {
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE;
  const root = projectRoot || resolve(__dirname, '..', '..');
  const f = resolve(root, '.cookie');
  if (existsSync(f)) return readFileSync(f, 'utf-8').trim();
  console.error('❌ 请设置 MIMO_COOKIE 环境变量或创建 .cookie 文件');
  process.exit(1);
}

/**
 * 从 cookie 字符串中提取 xiaomichatbot_ph 值
 * @param {string} cookie
 * @returns {string|null}
 */
export function extractPhFromCookie(cookie) {
  const text = String(cookie || '');
  const match = text.match(/(?:^|;\s*)xiaomichatbot_ph=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim() || null;
}

/**
 * 解析 PH 参数（优先从 cookie 中提取，否则使用默认值）
 * @param {string} cookie
 * @returns {string} URL 编码后的 PH 参数
 */
export function resolvePh(cookie) {
  const cookiePh = extractPhFromCookie(cookie);
  if (cookiePh) {
    return `xiaomichatbot_ph=${encodeURIComponent(cookiePh)}`;
  }
  return PH;
}

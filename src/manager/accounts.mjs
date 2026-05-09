import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultAccountsPath = resolve(__dirname, '..', '..', 'accounts.json');
const defaultCookiePath = resolve(__dirname, '..', '..', '.cookie');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function resolveCookiePath(accountsPath, cookieFile) {
  const accountsDir = dirname(accountsPath);
  const cookiePath = resolve(accountsDir, cookieFile);
  const relativePath = relative(accountsDir, cookiePath);
  const escapesAccountsDir = relativePath.startsWith('..') || relativePath.includes(`..${sep}`);
  if (escapesAccountsDir) {
    throw new Error(`cookieFile 超出账号配置目录: ${cookieFile}`);
  }
  return cookiePath;
}

function resolveCookie(account, accountsPath) {
  if (account.cookie && String(account.cookie).trim()) {
    return String(account.cookie).trim();
  }
  if (account.cookieFile) {
    const cookiePath = resolveCookiePath(accountsPath, String(account.cookieFile).trim());
    if (!existsSync(cookiePath)) {
      throw new Error(`账号 ${account.id || account.name || 'unknown'} 的 cookieFile 不存在: ${cookiePath}`);
    }
    return readFileSync(cookiePath, 'utf-8').trim();
  }
  throw new Error(`账号 ${account.id || account.name || 'unknown'} 缺少 cookie 或 cookieFile`);
}

function normalizeAccount(raw, index, accountsPath) {
  const id = String(raw.id || raw.name || `account-${index + 1}`);
  return {
    id,
    name: raw.name || id,
    enabled: raw.enabled !== false,
    priority: Number.isFinite(raw.priority) ? raw.priority : 100,
    cookie: resolveCookie(raw, accountsPath),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  };
}

export function loadAccounts(accountsPath = defaultAccountsPath) {
  if (!existsSync(accountsPath)) {
    // 没有 accounts.json，尝试读取 cookie
    const cookie = process.env.MIMO_COOKIE
      || (existsSync(defaultCookiePath) ? readFileSync(defaultCookiePath, 'utf-8').trim() : '');
    if (!cookie) {
      throw new Error('未找到 accounts.json，且 MIMO_COOKIE 未设置、.cookie 文件不存在');
    }
    return [{
      id: 'default',
      name: 'default',
      enabled: true,
      priority: 100,
      cookie,
      tags: ['legacy-single-account'],
      meta: {},
    }];
  }

  const data = readJson(accountsPath);
  const list = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [];
  return list.map((item, index) => normalizeAccount(item, index, accountsPath)).filter(a => a.enabled);
}

export function getAccountsPath() {
  return defaultAccountsPath;
}

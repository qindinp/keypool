import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCookie } from './mimo-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultAccountsPath = resolve(__dirname, '..', 'accounts.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function resolveCookie(account) {
  if (account.cookie && String(account.cookie).trim()) {
    return String(account.cookie).trim();
  }
  if (account.cookieFile) {
    const cookiePath = resolve(dirname(defaultAccountsPath), account.cookieFile);
    if (!existsSync(cookiePath)) {
      throw new Error(`账号 ${account.id || account.name || 'unknown'} 的 cookieFile 不存在: ${cookiePath}`);
    }
    return readFileSync(cookiePath, 'utf-8').trim();
  }
  throw new Error(`账号 ${account.id || account.name || 'unknown'} 缺少 cookie 或 cookieFile`);
}

function normalizeAccount(raw, index) {
  const id = String(raw.id || raw.name || `account-${index + 1}`);
  return {
    id,
    name: raw.name || id,
    enabled: raw.enabled !== false,
    priority: Number.isFinite(raw.priority) ? raw.priority : 100,
    cookie: resolveCookie(raw),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  };
}

export function loadAccounts(accountsPath = defaultAccountsPath) {
  if (existsSync(accountsPath)) {
    const data = readJson(accountsPath);
    const list = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [];
    return list.map(normalizeAccount).filter(a => a.enabled);
  }

  return [{
    id: 'default',
    name: 'default',
    enabled: true,
    priority: 100,
    cookie: getCookie(),
    tags: ['legacy-single-account'],
    meta: {},
  }];
}

export function getAccountsPath() {
  return defaultAccountsPath;
}

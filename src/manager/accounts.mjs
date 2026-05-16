import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path';
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
    weight: Number.isFinite(raw.weight) ? raw.weight : 100,
    cookie: resolveCookie(raw, accountsPath),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  };
}

function validateCookieFileValue(value, accountLabel) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${accountLabel}.cookieFile 必须是非空字符串`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (isAbsolute(value) || /^[a-zA-Z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${accountLabel}.cookieFile 只能是账号配置目录内的相对路径`);
  }
}

export function validateAccountsConfig(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : null;
  if (!list) {
    throw new Error('Invalid accounts config: expected array or object with accounts array');
  }

  list.forEach((account, index) => {
    const label = `account[${index}]`;
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throw new Error(`Invalid ${label}: expected object`);
    }
    if ('id' in account && typeof account.id !== 'string') {
      throw new Error(`Invalid ${label}.id: expected string`);
    }
    if ('name' in account && typeof account.name !== 'string') {
      throw new Error(`Invalid ${label}.name: expected string`);
    }
    if ('enabled' in account && typeof account.enabled !== 'boolean') {
      throw new Error(`Invalid ${label}.enabled: expected boolean`);
    }
    if ('priority' in account && !Number.isFinite(account.priority)) {
      throw new Error(`Invalid ${label}.priority: expected finite number`);
    }
    if ('weight' in account && !Number.isFinite(account.weight)) {
      throw new Error(`Invalid ${label}.weight: expected finite number`);
    }
    if ('tags' in account && !Array.isArray(account.tags)) {
      throw new Error(`Invalid ${label}.tags: expected array`);
    }
    if ('meta' in account && (!account.meta || typeof account.meta !== 'object' || Array.isArray(account.meta))) {
      throw new Error(`Invalid ${label}.meta: expected object`);
    }

    const hasCookie = typeof account.cookie === 'string' && account.cookie.trim().length > 0;
    const hasCookieFile = typeof account.cookieFile === 'string' && account.cookieFile.trim().length > 0;
    if (!hasCookie && !hasCookieFile) {
      throw new Error(`Invalid ${label}: missing cookie or cookieFile`);
    }
    if (hasCookieFile) validateCookieFileValue(account.cookieFile, label);
  });

  return list;
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
  const list = validateAccountsConfig(data);
  return list.map((item, index) => normalizeAccount(item, index, accountsPath)).filter(a => a.enabled);
}

export function getAccountsPath() {
  return defaultAccountsPath;
}

/**
 * Manager 配置
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

function readProjectConfig() {
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function assertPositiveInteger(config, key) {
  if (!(key in config)) return;
  if (!Number.isInteger(config[key]) || config[key] <= 0) {
    throw new Error(`Invalid config.${key}: expected positive integer`);
  }
}

function assertUrlScheme(config, key, allowedSchemes) {
  const value = config[key];
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid config.${key}: expected URL`);
  }
  if (!allowedSchemes.includes(parsed.protocol)) {
    throw new Error(`Invalid config.${key}: expected scheme ${allowedSchemes.join(' or ')}`);
  }
}

function assertDeployRepo(value) {
  if (!value) return;
  if (typeof value !== 'string') {
    throw new Error('Invalid config.deployRepo: expected string');
  }
  if (value.startsWith('https://') || value.startsWith('ssh://') || /^git@[^:]+:.+/.test(value)) {
    return;
  }
  throw new Error('Invalid config.deployRepo: expected https://, ssh://, or git@host:path');
}

export function validateConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid config: expected object');
  }

  const out = { ...config };

  if ('port' in out) {
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
      throw new Error('Invalid config.port: expected integer 1..65535');
    }
  }

  if ('host' in out && typeof out.host !== 'string') {
    throw new Error('Invalid config.host: expected string');
  }

  for (const key of [
    'renewBefore', 'checkInterval', 'maxRetries', 'readyTimeout', 'wsConnectTimeout',
    'deployTimeout', 'chatTimeout', 'retryBaseDelay', 'retryMaxDelay',
  ]) {
    assertPositiveInteger(out, key);
  }

  assertDeployRepo(out.deployRepo);
  assertUrlScheme(out, 'mimoApiUrl', ['http:', 'https:']);
  assertUrlScheme(out, 'publicWsUrl', ['ws:', 'wss:']);
  assertUrlScheme(out, 'publicHttpBase', ['http:', 'https:']);

  for (const key of ['localSrcDir', 'giteeToken']) {
    if (key in out && typeof out[key] !== 'string') {
      throw new Error(`Invalid config.${key}: expected string`);
    }
  }

  return out;
}

export function createConfig(env = process.env) {
  const fileConfig = readProjectConfig();

  return validateConfig({
    renewBefore: (parseInt(env.RENEW_BEFORE) || fileConfig.renewBefore || 300) * 1000,
    checkInterval: (parseInt(env.CHECK_INTERVAL) || fileConfig.checkInterval || 60) * 1000,
    maxRetries: parseInt(env.MAX_RETRIES) || fileConfig.maxRetries || 5,
    deployRepo: env.DEPLOY_REPO || fileConfig.deployRepo || 'https://github.com/qindinp/keypool.git',
    localSrcDir: env.LOCAL_SRC_DIR || fileConfig.localSrcDir || '',
    readyTimeout: fileConfig.readyTimeout || 180_000,
    wsConnectTimeout: parseInt(env.WS_CONNECT_TIMEOUT) || fileConfig.wsConnectTimeout || 30_000,
    deployTimeout: parseInt(env.DEPLOY_TIMEOUT) || fileConfig.deployTimeout || 300_000,
    chatTimeout: parseInt(env.CHAT_TIMEOUT) || fileConfig.chatTimeout || 120_000,
    retryBaseDelay: parseInt(env.RETRY_BASE_DELAY) || fileConfig.retryBaseDelay || 5_000,
    retryMaxDelay: parseInt(env.RETRY_MAX_DELAY) || fileConfig.retryMaxDelay || 60_000,
    mimoApiUrl: env.MIMO_API_URL || fileConfig.mimoApiUrl || 'https://api-oc.xiaomimimo.com/v1',
    giteeToken: env.GITEE_TOKEN || fileConfig.giteeToken || '',
    publicWsUrl: env.KEYPOOL_PUBLIC_WS_URL || env.KEYPOOL_GATEWAY_URL || fileConfig.publicWsUrl || '',
    publicHttpBase: env.KEYPOOL_PUBLIC_HTTP_BASE || env.KEYPOOL_GATEWAY_HTTP_BASE || fileConfig.publicHttpBase || '',
    port: parseInt(env.PORT) || fileConfig.port || 9300,
    host: env.HOST || fileConfig.host || '0.0.0.0',
  });
}

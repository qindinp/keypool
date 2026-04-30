#!/usr/bin/env node
/**
 * MiMo Claw 自动续期脚本 v2
 * 
 * 核心逻辑:
 *   1. 启动时读 process.env.MIMO_API_KEY → 写入 config.json
 *   2. 每 60 秒检查实例剩余时间
 *   3. 到期前 5 分钟调 /create 续期
 *   4. 检测 env key 变化 → 自动更新 KeyPool 配置
 * 
 * 用法:
 *   node renew.mjs
 *   # 后台运行:
 *   nohup node renew.mjs > renew.log 2>&1 &
 * 
 * 环境变量:
 *   MIMO_COOKIE — 登录 cookie
 *   MIMO_API_KEY — 当前 API Key (由 OpenClaw 注入)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 配置 ───────────────────────────────────────────────────────
const BASE = 'https://aistudio.xiaomimimo.com';
const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';
const CHECK_INTERVAL = 60_000;           // 每 60 秒检查
const RENEW_BEFORE = 5 * 60_000;         // 到期前 5 分钟续期
const KEYPOOL_CONFIG = resolve(__dirname, 'config.json');
const STATE_FILE = resolve(__dirname, '.renew-state.json');

// ─── Cookie ──────────────────────────────────────────────────────
function getCookie() {
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE;
  const f = resolve(__dirname, '.cookie');
  if (existsSync(f)) return readFileSync(f, 'utf-8').trim();
  console.error('❌ 请设置 MIMO_COOKIE 或创建 .cookie 文件');
  process.exit(1);
}

// ─── HTTP ────────────────────────────────────────────────────────
function api(path, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'cookie': cookie, 'user-agent': 'Mozilla/5.0', 'accept': 'application/json' },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    }).on('error', reject);
  });
}

// ─── 日志 ────────────────────────────────────────────────────────
function log(level, ...args) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const icons = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', ok: '✅' };
  console.log(`[${ts}] ${icons[level] || '  '}`, ...args);
}

// ─── 状态持久化 ──────────────────────────────────────────────────
function loadState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : {}; }
  catch { return {}; }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── KeyPool 配置更新 ────────────────────────────────────────────
function updateKeypoolKey(newKey) {
  let config;
  if (existsSync(KEYPOOL_CONFIG)) {
    try { config = JSON.parse(readFileSync(KEYPOOL_CONFIG, 'utf-8')); } catch { config = {}; }
  } else {
    // 尝试从 OpenClaw 配置读取
    config = {};
  }

  if (!config.keys || config.keys.length === 0) {
    config.keys = [{ id: 'mimo', key: newKey }];
  } else {
    const old = config.keys[0].key;
    if (old === newKey) return false;
    config.keys[0].key = newKey;
  }

  if (!config.port) config.port = 9200;
  if (!config.baseUrl) config.baseUrl = 'https://api-oc.xiaomimimo.com/v1';

  writeFileSync(KEYPOOL_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  log('ok', `KeyPool key 已更新: ${newKey.slice(0, 15)}...`);
  return true;
}

// ─── 读取当前 Key ────────────────────────────────────────────────
function getCurrentKey() {
  // 1. 环境变量
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  // 2. OpenClaw 配置
  const ocPath = resolve(process.env.HOME || '/root', '.openclaw', 'openclaw.json');
  if (existsSync(ocPath)) {
    try {
      const raw = readFileSync(ocPath, 'utf-8');
      // 简单提取 apiKey — 支持 ${ENV_VAR} 引用
      const match = raw.match(/"apiKey"\s*:\s*"([^"]+)"/);
      if (match) {
        let key = match[1];
        // 解析环境变量引用
        key = key.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
        if (key && key.startsWith('oc_')) return key;
      }
    } catch {}
  }
  // 3. KeyPool config
  if (existsSync(KEYPOOL_CONFIG)) {
    try {
      const cfg = JSON.parse(readFileSync(KEYPOOL_CONFIG, 'utf-8'));
      if (cfg.keys?.[0]?.key) return cfg.keys[0].key;
    } catch {}
  }
  return null;
}

// ─── 主循环 ──────────────────────────────────────────────────────
async function main() {
  const cookie = getCookie();
  const state = loadState();

  log('info', '🚀 MiMo 自动续期 v2 启动');
  log('info', `检查间隔 ${CHECK_INTERVAL / 1000}s, 到期前 ${RENEW_BEFORE / 60000}min 续期`);

  // 启动时同步 key 到 KeyPool
  const currentKey = getCurrentKey();
  if (currentKey) {
    log('info', `当前 Key: ${currentKey.slice(0, 15)}...`);
    updateKeypoolKey(currentKey);
  } else {
    log('warn', '未检测到 API Key，等待实例启动...');
  }

  let lastKey = currentKey;

  while (true) {
    try {
      // ── 检查 env key 变化 ──
      const envKey = process.env.MIMO_API_KEY;
      if (envKey && envKey !== lastKey) {
        log('ok', `检测到新 Key: ${envKey.slice(0, 15)}...`);
        updateKeypoolKey(envKey);
        lastKey = envKey;
      }

      // ── 获取实例状态 ──
      const resp = await api(`/open-apis/user/mimo-claw/status?${PH}`, cookie);
      if (resp.code !== 0) {
        log('error', `获取状态失败: ${resp.msg}`);
        await sleep(CHECK_INTERVAL);
        continue;
      }

      const { status, expireTime } = resp.data;
      const remaining = expireTime - Date.now();
      const remainMin = Math.round(remaining / 60_000);

      // 状态变化时记录
      if (state.lastExpireTime !== expireTime) {
        log('info', `实例 ${status}, 剩余 ${remainMin}min, 到期 ${new Date(expireTime).toLocaleTimeString()}`);
        state.lastExpireTime = expireTime;
        saveState(state);
      }

      // ── 到期前续期 ──
      if (remaining > 0 && remaining < RENEW_BEFORE) {
        log('warn', `⏰ 即将到期 (剩余 ${remainMin}min)，尝试续期...`);

        const createResp = await api(`/open-apis/user/mimo-claw/create?${PH}`, cookie);
        if (createResp.code === 0) {
          const newExpire = createResp.data.expireTime;

          if (newExpire > expireTime) {
            log('ok', `✨ 新实例! 到期 ${new Date(newExpire).toLocaleTimeString()}`);
            state.lastExpireTime = newExpire;
            state.renewCount = (state.renewCount || 0) + 1;
            state.lastRenewAt = Date.now();
            saveState(state);

            // 新实例的 key 会在 OpenClaw 重启后注入 env
            // 脚本本身也会随新实例重启，届时 getCurrentKey() 会拿到新 key
            log('info', '等待新实例启动并注入 Key...');
          } else {
            log('info', '实例未变化 (可能尚未到期)');
          }
        } else {
          log('error', `续期失败: ${createResp.msg}`);
        }
      }

      // ── 已过期 ──
      if (remaining <= 0) {
        log('error', '❌ 实例已过期!');

        const createResp = await api(`/open-apis/user/mimo-claw/create?${PH}`, cookie);
        if (createResp.code === 0 && createResp.data.status === 'AVAILABLE') {
          log('ok', `新实例已创建: ${new Date(createResp.data.expireTime).toLocaleTimeString()}`);
          state.lastExpireTime = createResp.data.expireTime;
          state.renewCount = (state.renewCount || 0) + 1;
          saveState(state);
        } else {
          log('error', `恢复失败: ${createResp.msg || 'unknown'}`);
          log('info', '30 秒后重试...');
          await sleep(30_000);
        }
      }

    } catch (e) {
      log('error', `异常: ${e.message}`);
    }

    await sleep(CHECK_INTERVAL);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => {
  log('error', `致命错误: ${e.message}`);
  process.exit(1);
});

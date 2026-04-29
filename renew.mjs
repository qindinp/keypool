#!/usr/bin/env node
/**
 * MiMo Claw 自动续期脚本 (简化版)
 * 
 * 核心逻辑:
 *   1. 定期检查实例状态
 *   2. 到期前调用 create 接口续命
 *   3. 如果 key 变了，自动更新 keypool 配置
 * 
 * 用法:
 *   node renew.mjs
 *   # 或后台运行:
 *   nohup node renew.mjs > renew.log 2>&1 &
 * 
 * 环境变量:
 *   MIMO_COOKIE — 登录 cookie (serviceToken=xxx; userId=xxx; xiaomichatbot_ph=xxx)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 配置 ───────────────────────────────────────────────────────
const BASE = 'https://aistudio.xiaomimimo.com';
const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';
const CHECK_INTERVAL = 60_000;           // 每 60 秒检查一次
const RENEW_BEFORE = 5 * 60_000;         // 到期前 5 分钟触发续期
const KEYPOOL_CONFIG = resolve(__dirname, 'config.json');
const STATE_FILE = resolve(__dirname, '.renew-state.json');

// ─── Cookie ──────────────────────────────────────────────────────
function getCookie() {
  // 优先从环境变量读
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE;
  
  // 从文件读
  const cookieFile = resolve(__dirname, '.cookie');
  if (existsSync(cookieFile)) return readFileSync(cookieFile, 'utf-8').trim();
  
  console.error('❌ 请设置 cookie:');
  console.error('   方式一: export MIMO_COOKIE="serviceToken=xxx; userId=xxx; xiaomichatbot_ph=xxx"');
  console.error('   方式二: echo "serviceToken=xxx; ..." > keypool/.cookie');
  process.exit(1);
}

// ─── HTTP ────────────────────────────────────────────────────────
function api(path, cookie, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = {
      'cookie': cookie,
      'user-agent': 'Mozilla/5.0',
      'accept': 'application/json',
    };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = httpsRequest({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
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
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : {};
  } catch { return {}; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── 更新 keypool key ────────────────────────────────────────────
function updateKey(newKey) {
  if (!existsSync(KEYPOOL_CONFIG)) return false;
  const cfg = JSON.parse(readFileSync(KEYPOOL_CONFIG, 'utf-8'));
  const old = cfg.keys?.[0]?.key;
  if (old === newKey) return false;
  if (cfg.keys?.[0]) cfg.keys[0].key = newKey;
  writeFileSync(KEYPOOL_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  log('ok', `Key 已更新: ${old?.slice(0, 12)}... → ${newKey.slice(0, 12)}...`);
  return true;
}

// ─── 主循环 ──────────────────────────────────────────────────────
async function main() {
  const cookie = getCookie();
  const state = loadState();
  
  log('info', '🚀 MiMo Claw 自动续期启动');
  log('info', `检查间隔 ${CHECK_INTERVAL / 1000}s, 到期前 ${RENEW_BEFORE / 60000}min 续期`);
  
  // 读取当前 key
  const currentKey = process.env.MIMO_API_KEY
    || (existsSync(KEYPOOL_CONFIG) ? JSON.parse(readFileSync(KEYPOOL_CONFIG, 'utf-8')).keys?.[0]?.key : null);
  if (currentKey) log('info', `当前 Key: ${currentKey.slice(0, 15)}...`);
  
  while (true) {
    try {
      // 获取实例状态
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
        
        const createResp = await api(`/open-apis/user/mimo-claw/create?${PH}`, cookie, 'POST', '{}');
        if (createResp.code === 0) {
          const newExpire = createResp.data.expireTime;
          
          if (newExpire > expireTime) {
            // 新实例创建成功
            log('ok', `✨ 新实例! 到期时间 ${new Date(newExpire).toLocaleTimeString()}`);
            state.lastExpireTime = newExpire;
            state.renewCount = (state.renewCount || 0) + 1;
            state.lastRenewAt = Date.now();
            saveState(state);
            
            // 检查 key 是否变化 (通过尝试读取新 env var)
            // 注意: 如果进程在新实例中重启，env var 会自动更新
            // 这里我们无法直接获取新实例的 env var
            log('info', '新实例已就绪。如 key 变化，需重启 OpenClaw 读取新 env var');
          } else {
            log('info', `实例未变化 (expireTime 相同), 可能尚未到期`);
          }
        } else {
          log('error', `创建实例失败: ${createResp.msg}`);
        }
      }
      
      // ── 已过期 ──
      if (remaining <= 0) {
        log('error', '❌ 实例已过期!');
        
        const createResp = await api(`/open-apis/user/mimo-claw/create?${PH}`, cookie, 'POST', '{}');
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

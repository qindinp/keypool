#!/usr/bin/env node
/**
 * MiMo Claw 实例自动续期脚本
 * 
 * 功能:
 *   1. 监控当前实例过期时间
 *   2. 到期前自动创建新实例
 *   3. 获取新 API Key 并更新 keypool 配置
 * 
 * 用法:
 *   node auto-renew.mjs --cookie "serviceToken=xxx; userId=xxx; xiaomichatbot_ph=xxx"
 *   node auto-renew.mjs --cookie-file cookie.txt
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 配置 ───────────────────────────────────────────────────────
const BASE_URL = 'https://aistudio.xiaomimimo.com';
const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';
const RENEW_BEFORE_MS = 5 * 60 * 1000;  // 到期前 5 分钟续期
const CHECK_INTERVAL_MS = 60 * 1000;     // 每分钟检查一次
const KEYPOOL_CONFIG = resolve(__dirname, 'config.json');

// ─── 参数解析 ────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let cookie = '';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cookie' && args[i + 1]) {
      cookie = args[++i];
    } else if (args[i] === '--cookie-file' && args[i + 1]) {
      cookie = readFileSync(resolve(args[++i]), 'utf-8').trim();
    }
  }

  // 也尝试从环境变量读取
  if (!cookie && process.env.MIMO_COOKIE) {
    cookie = process.env.MIMO_COOKIE;
  }

  if (!cookie) {
    console.error('用法: node auto-renew.mjs --cookie "serviceToken=xxx; userId=xxx; xiaomichatbot_ph=xxx"');
    console.error('  或: node auto-renew.mjs --cookie-file cookie.txt');
    console.error('  或: MIMO_COOKIE="..." node auto-renew.mjs');
    process.exit(1);
  }

  return cookie;
}

// ─── HTTP 工具 ───────────────────────────────────────────────────
function apiRequest(path, cookie, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const requester = isHttps ? httpsRequest : httpRequest;
    
    const headers = {
      'cookie': cookie,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'accept': 'application/json',
    };
    
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = requester(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── 日志 ────────────────────────────────────────────────────────
function log(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = { info: 'ℹ️ ', warn: '⚠️ ', error: '❌', success: '✅' }[level] || '  ';
  console.log(`[${ts}] ${prefix}`, ...args);
}

// ─── 核心逻辑 ────────────────────────────────────────────────────

/** 获取实例状态 */
async function getStatus(cookie) {
  const resp = await apiRequest(`/open-apis/user/mimo-claw/status?${PH}`, cookie);
  if (resp.code !== 0) {
    throw new Error(`获取状态失败: ${resp.msg}`);
  }
  return resp.data;
}

/** 创建新实例 */
async function createInstance(cookie) {
  const resp = await apiRequest(`/open-apis/user/mimo-claw/create?${PH}`, cookie, 'POST', '{}');
  if (resp.code !== 0) {
    throw new Error(`创建实例失败: ${resp.msg}`);
  }
  return resp.data;
}

/** 获取 WebSocket ticket */
async function getTicket(cookie) {
  const resp = await apiRequest(`/open-apis/user/ws/ticket?${PH}`, cookie);
  if (resp.code !== 0) {
    throw new Error(`获取 ticket 失败: ${resp.msg}`);
  }
  return resp.data.ticket;
}

/** 更新 keypool 配置中的 API key */
function updateKeypoolKey(newKey) {
  if (!existsSync(KEYPOOL_CONFIG)) {
    log('warn', `keypool 配置不存在: ${KEYPOOL_CONFIG}`);
    return false;
  }
  
  try {
    const config = JSON.parse(readFileSync(KEYPOOL_CONFIG, 'utf-8'));
    const oldKey = config.keys?.[0]?.key;
    
    if (oldKey === newKey) {
      log('info', 'Key 未变化，跳过更新');
      return false;
    }
    
    if (config.keys && config.keys.length > 0) {
      config.keys[0].key = newKey;
    }
    
    writeFileSync(KEYPOOL_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    log('success', `Keypool 配置已更新: ${oldKey?.slice(0, 10)}... → ${newKey.slice(0, 10)}...`);
    return true;
  } catch (e) {
    log('error', `更新 keypool 配置失败: ${e.message}`);
    return false;
  }
}

/** 通过 WebSocket 尝试获取新实例的 API Key */
async function tryGetKeyFromWS(cookie) {
  try {
    const ticket = await getTicket(cookie);
    log('info', `获取到 WebSocket ticket: ${ticket}`);
    
    // 尝试通过 WebSocket 获取环境变量中的 key
    // 这需要 WebSocket 客户端支持
    return null; // 暂时无法实现
  } catch (e) {
    log('warn', `WebSocket 方式获取 key 失败: ${e.message}`);
    return null;
  }
}

// ─── 主循环 ──────────────────────────────────────────────────────
async function main() {
  const cookie = parseArgs();
  
  log('info', '🚀 MiMo Claw 自动续期脚本启动');
  log('info', `检查间隔: ${CHECK_INTERVAL_MS / 1000}s, 续期阈值: 到期前 ${RENEW_BEFORE_MS / 60000}min`);
  
  let lastStatus = null;
  
  while (true) {
    try {
      const status = await getStatus(cookie);
      const now = Date.now();
      const remaining = status.expireTime - now;
      const remainingMin = Math.round(remaining / 60000);
      
      // 状态变化时输出日志
      if (!lastStatus || lastStatus.expireTime !== status.expireTime) {
        log('info', `实例状态: ${status.status}, 剩余时间: ${remainingMin}min`);
        log('info', `过期时间: ${new Date(status.expireTime).toLocaleString()}`);
        lastStatus = status;
      }
      
      // 检查是否需要续期
      if (remaining < RENEW_BEFORE_MS && remaining > 0) {
        log('warn', `⏰ 实例即将到期 (剩余 ${remainingMin}min)，开始续期...`);
        
        // 创建新实例
        const newStatus = await createInstance(cookie);
        log('info', `创建实例返回: status=${newStatus.status}, expireTime=${new Date(newStatus.expireTime).toLocaleString()}`);
        
        if (newStatus.expireTime > status.expireTime) {
          log('success', `✨ 新实例已创建！过期时间: ${new Date(newStatus.expireTime).toLocaleString()}`);
          
          // 尝试获取新 key
          const newKey = await tryGetKeyFromWS(cookie);
          if (newKey) {
            updateKeypoolKey(newKey);
          } else {
            log('warn', '无法自动获取新 API Key，需要手动更新');
            log('info', '新实例的 API Key 在沙箱环境变量中，需要通过其他方式获取');
          }
          
          lastStatus = newStatus;
        } else {
          log('info', '实例未变化（可能尚未到期，create 返回了当前实例）');
        }
      }
      
      // 实例已过期
      if (remaining <= 0) {
        log('error', '❌ 实例已过期！尝试创建新实例...');
        try {
          const newStatus = await createInstance(cookie);
          if (newStatus.status === 'AVAILABLE') {
            log('success', `新实例已创建: ${new Date(newStatus.expireTime).toLocaleString()}`);
            lastStatus = newStatus;
          }
        } catch (e) {
          log('error', `创建新实例失败: ${e.message}`);
        }
      }
      
    } catch (e) {
      log('error', `检查失败: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch(e => {
  log('error', `致命错误: ${e.message}`);
  process.exit(1);
});

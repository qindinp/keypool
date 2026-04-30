#!/usr/bin/env node
/**
 * Key Exchange Server
 * 
 * 运行在当前 MiMo Claw 实例上，监听新实例推送过来的 API Key。
 * 新实例启动时，bootstrap 脚本会把 MIMO_API_KEY POST 到这里。
 * 
 * 用法: node key-exchange.mjs [--port 9201]
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '9201');
const KEYPOOL_CONFIG = resolve(__dirname, 'config.json');
const STATE_FILE = resolve(__dirname, '.key-exchange-state.json');

// ─── 状态管理 ────────────────────────────────────────────────────
let latestKey = null;
let latestKeyTime = null;

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      latestKey = state.latestKey;
      latestKeyTime = state.latestKeyTime;
    }
  } catch {}
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ latestKey, latestKeyTime }, null, 2), 'utf-8');
  } catch {}
}

// ─── 更新 Keypool 配置 ──────────────────────────────────────────
function updateKeypoolConfig(newKey) {
  if (!existsSync(KEYPOOL_CONFIG)) {
    console.log(`⚠️  keypool 配置不存在: ${KEYPOOL_CONFIG}`);
    return false;
  }
  
  try {
    const config = JSON.parse(readFileSync(KEYPOOL_CONFIG, 'utf-8'));
    const oldKey = config.keys?.[0]?.key;
    
    if (oldKey === newKey) {
      console.log(`ℹ️  Key 未变化，跳过更新`);
      return false;
    }
    
    if (config.keys && config.keys.length > 0) {
      config.keys[0].key = newKey;
    }
    
    writeFileSync(KEYPOOL_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`✅ Keypool 配置已更新: ${oldKey?.slice(0, 10)}... → ${newKey.slice(0, 10)}...`);
    return true;
  } catch (e) {
    console.log(`❌ 更新 keypool 配置失败: ${e.message}`);
    return false;
  }
}

// ─── HTTP 服务器 ─────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  
  // POST /key — 接收新实例的 API Key
  if (url.pathname === '/key' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { key, source, timestamp } = JSON.parse(body);
        
        if (!key || typeof key !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing key field' }));
        }
        
        console.log(`\n🔑 收到新 API Key!`);
        console.log(`   来源: ${source || 'unknown'}`);
        console.log(`   Key: ${key.slice(0, 15)}...`);
        console.log(`   时间: ${timestamp || new Date().toISOString()}`);
        
        latestKey = key;
        latestKeyTime = Date.now();
        saveState();
        
        // 自动更新 keypool 配置
        const updated = updateKeypoolConfig(key);
        
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ 
          ok: true, 
          updated,
          message: updated ? 'Key received and config updated' : 'Key received (same as current)'
        }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  
  // GET /key — 查询当前最新的 Key
  if (url.pathname === '/key' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      key: latestKey,
      time: latestKeyTime,
      age: latestKeyTime ? Date.now() - latestKeyTime : null,
    }));
  }
  
  // GET /health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }
  
  // 帮助页面
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    name: 'KeyPool Key Exchange Server',
    endpoints: {
      'POST /key': '接收新实例的 API Key { key, source?, timestamp? }',
      'GET /key': '查询当前最新 Key',
      'GET /health': '健康检查',
    },
    latestKey: latestKey ? `${latestKey.slice(0, 10)}...` : null,
  }, null, 2));
});

loadState();

server.listen(PORT, () => {
  console.log(`🔑 Key Exchange Server 运行在 http://127.0.0.1:${PORT}`);
  console.log(`   POST /key — 新实例推送 API Key`);
  console.log(`   GET  /key — 查询最新 Key`);
  if (latestKey) {
    console.log(`   当前已知 Key: ${latestKey.slice(0, 15)}...`);
  }
});

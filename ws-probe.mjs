#!/usr/bin/env node
/**
 * WebSocket 探测脚本
 * 监听 MiMo WebSocket 消息，寻找 API Key 相关推送
 */

import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://aistudio.xiaomimimo.com';
const PH = 'xiaomichatbot_ph=1QnWBfzrObf9yoM6im9JTg==';

// ─── Cookie ──────────────────────────────────────────────────────
function getCookie() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cookie' && args[i + 1]) return args[++i];
    if (args[i] === '--cookie-file' && args[i + 1]) return readFileSync(resolve(args[++i]), 'utf-8').trim();
  }
  if (process.env.MIMO_COOKIE) return process.env.MIMO_COOKIE;
  const f = resolve(__dirname, '.cookie');
  if (existsSync(f)) return readFileSync(f, 'utf-8').trim();
  console.error('❌ 请设置 cookie');
  process.exit(1);
}

// ─── HTTP ────────────────────────────────────────────────────────
function api(path, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'cookie': cookie, 'user-agent': 'Mozilla/5.0', 'accept': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── WebSocket 帧解析 ───────────────────────────────────────────
function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let headerLen = 2;
    
    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    
    let maskKey = null;
    if (masked) {
      maskKey = buffer.slice(offset + headerLen, offset + headerLen + 4);
      headerLen += 4;
    }
    
    const totalLen = headerLen + payloadLen;
    if (buffer.length - offset < totalLen) break;
    
    const payload = buffer.slice(offset + headerLen, offset + totalLen);
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    
    frames.push({ opcode, payload: Buffer.from(payload), fin });
    offset += totalLen;
  }
  
  return { frames, remaining: buffer.slice(offset) };
}

function buildFrame(opcode, data, mask = false) {
  const payload = Buffer.from(data);
  let header;
  
  if (payload.length < 126) {
    header = Buffer.alloc(2 + (mask ? 4 : 0));
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0x00) | payload.length;
    if (mask) randomBytes(4).copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4 + (mask ? 4 : 0));
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0x00) | 126;
    header.writeUInt16BE(payload.length, 2);
    if (mask) randomBytes(4).copy(header, 4);
  } else {
    header = Buffer.alloc(10 + (mask ? 4 : 0));
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0x00) | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    if (mask) randomBytes(4).copy(header, 10);
  }
  
  // Apply mask to payload if needed
  let outPayload = Buffer.from(payload);
  if (mask) {
    const maskKey = header.slice(-4);
    for (let i = 0; i < outPayload.length; i++) outPayload[i] ^= maskKey[i % 4];
  }
  
  return Buffer.concat([header, outPayload]);
}

// ─── 主流程 ──────────────────────────────────────────────────────
async function main() {
  const cookie = getCookie();
  
  console.log('🔍 MiMo WebSocket 探测脚本');
  console.log('═'.repeat(60));
  
  // 1. 获取 ticket
  console.log('1️⃣  获取 ticket...');
  const ticketResp = await api(`/open-apis/user/ws/ticket?${PH}`, cookie);
  if (ticketResp.code !== 0) {
    console.error('❌ 获取 ticket 失败:', ticketResp);
    process.exit(1);
  }
  const ticket = ticketResp.data.ticket;
  console.log(`   Ticket: ${ticket}`);
  
  // 2. 实例状态
  console.log('2️⃣  获取实例状态...');
  const statusResp = await api(`/open-apis/user/mimo-claw/status?${PH}`, cookie);
  if (statusResp.code === 0) {
    const { status, expireTime } = statusResp.data;
    console.log(`   状态: ${status}, 剩余: ${Math.round((expireTime - Date.now()) / 60000)}min`);
  }
  
  // 3. WebSocket 连接
  console.log('3️⃣  连接 WebSocket...');
  const wsPath = `/ws/proxy?ticket=${ticket}`;
  
  await new Promise((resolve, reject) => {
    const socket = tlsConnect({
      hostname: 'aistudio.xiaomimimo.com',
      port: 443,
      servername: 'aistudio.xiaomimimo.com',
    }, () => {
      console.log('   TLS 已连接, 发送 WebSocket 握手...');
      
      const wsKey = randomBytes(16).toString('base64');
      const handshake = [
        `GET ${wsPath} HTTP/1.1`,
        `Host: aistudio.xiaomimimo.com`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${wsKey}`,
        `Sec-WebSocket-Version: 13`,
        `Cookie: ${cookie}`,
        `Origin: https://aistudio.xiaomimimo.com`,
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`,
        '', ''
      ].join('\r\n');
      
      socket.write(handshake);
    });

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let msgCount = 0;

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        
        const resp = buf.slice(0, idx).toString();
        const code = resp.match(/HTTP\/1\.1 (\d+)/)?.[1];
        console.log(`   握手响应: HTTP ${code}`);
        
        if (code !== '101') {
          console.log('   响应头:', resp);
          socket.destroy();
          reject(new Error(`WebSocket handshake failed: ${code}`));
          return;
        }
        
        handshakeDone = true;
        console.log('   ✅ WebSocket 连接成功!\n');
        console.log('─'.repeat(60));
        console.log('📡 监听中... (Ctrl+C 退出)');
        console.log('─'.repeat(60));
        
        buf = buf.slice(idx + 4);
        if (buf.length > 0) processBuffer(buf);
        resolve();
      } else {
        processBuffer(chunk);
      }
    });

    function processBuffer(chunk) {
      buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
      const { frames, remaining } = parseFrames(buf);
      buf = remaining;
      
      for (const frame of frames) {
        const now = new Date().toISOString().slice(11, 23);
        msgCount++;
        
        if (frame.opcode === 0x01) {
          // Text
          const text = frame.payload.toString('utf-8');
          console.log(`\n[${now}] 📨 #${msgCount} 文本 (${frame.payload.length}b):`);
          try {
            const json = JSON.parse(text);
            console.log(JSON.stringify(json, null, 2));
            
            // Key 检测
            const str = JSON.stringify(json).toLowerCase();
            if (str.includes('api_key') || str.includes('apikey') || str.includes('oc_') ||
                str.includes('mimo_api') || str.includes('secret') || str.includes('credential')) {
              console.log('\n🔑🔑🔑 >>> 可能包含 API Key 信息! <<< 🔑🔑🔑\n');
            }
          } catch {
            console.log(text.slice(0, 500));
          }
        } else if (frame.opcode === 0x02) {
          // Binary
          console.log(`\n[${now}] 📦 #${msgCount} 二进制 (${frame.payload.length}b)`);
          try {
            console.log('文本解析:', frame.payload.toString('utf-8').slice(0, 300));
          } catch {}
        } else if (frame.opcode === 0x08) {
          console.log(`\n[${now}] 🔌 收到关闭帧`);
          socket.end();
        } else if (frame.opcode === 0x09) {
          console.log(`[${now}] 💓 Ping → Pong`);
          socket.write(buildFrame(0x0A, '', false));
        } else if (frame.opcode === 0x0A) {
          console.log(`[${now}] 💓 Pong`);
        } else {
          console.log(`\n[${now}] ❓ 帧 0x${frame.opcode.toString(16)} (${frame.payload.length}b)`);
        }
      }
    }

    socket.on('error', (err) => {
      console.error('❌ Socket 错误:', err.message);
      reject(err);
    });
    
    socket.on('close', () => {
      console.log('\n🔌 连接关闭');
    });

    // 定期 ping
    const ping = setInterval(() => {
      try { socket.write(buildFrame(0x09, '', false)); } catch {}
    }, 30000);

    // 45 秒后触发 create
    setTimeout(async () => {
      console.log('\n\n⏰ 45 秒后触发 create API...');
      try {
        const r = await api(`/open-apis/user/mimo-claw/create?${PH}`, cookie);
        console.log('Create 响应:', JSON.stringify(r, null, 2));
      } catch (e) {
        console.log('Create 失败:', e.message);
      }
    }, 45000);

    process.on('SIGINT', () => {
      clearInterval(ping);
      socket.end();
      process.exit(0);
    });
  });
}

main().catch(e => {
  console.error('致命错误:', e.message);
  process.exit(1);
});

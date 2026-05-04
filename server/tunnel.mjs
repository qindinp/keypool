/**
 * KeyPool — SSH 隧道管理
 *
 * 支持 localhost.run 和 serveo.net
 * 改进的 URL 提取（不再硬编码域名后缀）
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let tunnelProcess = null;

/**
 * 从 SSH 隧道输出中提取公网 URL
 * 只接受真实转发地址，显式过滤 localhost.run 的说明/管理页链接
 */
function extractPublicUrl(text) {
  const rawUrls = Array.from(String(text || '').matchAll(/https?:\/\/[^\s"'<>`\]]+/g)).map(m => m[0]);
  const candidates = rawUrls
    .map(url => normalizeTunnelUrl(url))
    .filter(Boolean)
    .sort((a, b) => getTunnelUrlPriority(a) - getTunnelUrlPriority(b));
  return candidates[0] || null;
}

function normalizeTunnelUrl(url) {
  if (!isValidTunnelUrl(url)) return null;
  return url.replace(/\/+$/, '');
}

function getTunnelUrlPriority(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.lhr.life')) return 1;
    if (host.endsWith('.serveo.net')) return 2;
    if (host.endsWith('.localhost.run')) return 3;
    return 99;
  } catch {
    return 99;
  }
}

function isValidTunnelUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'admin.localhost.run') return false;
    if (host === 'localhost.run') return false;
    if (host === 'twitter.com') return false;
    if (url.includes('/docs/')) return false;
    if (host.endsWith('.lhr.life')) return true;
    if (host.endsWith('.serveo.net')) return true;
    if (host.endsWith('.localhost.run')) return true;
    return false;
  } catch {
    return false;
  }
}


/**
 * 启动 SSH 隧道
 * @param {number} port - 本地代理端口
 * @param {object} opts
 * @param {string} opts.service - 'localhost.run' | 'serveo.net'
 * @param {Function} opts.log - 日志函数
 * @param {Function} opts.onUrl - 获取到公网 URL 时回调
 */
export function startTunnel(port, opts = {}) {
  const service = opts.service || 'localhost.run';
  const log = opts.log || console.log;
  const onUrl = opts.onUrl || (() => {});

  let cmd, args;
  if (service === 'serveo.net') {
    cmd = 'ssh';
    args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=60', '-R', `80:localhost:${port}`, 'serveo.net'];
  } else {
    cmd = 'ssh';
    args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=60', '-R', `80:localhost:${port}`, 'nokey@localhost.run'];
  }

  log('info', `🌐 正在建立 SSH 隧道 (${service})...`);

  tunnelProcess = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let urlFound = false;

  const handleOutput = (data) => {
    const text = data.toString();
    const publicUrl = extractPublicUrl(text);

    if (publicUrl && !urlFound) {
      urlFound = true;

      console.log('');
      console.log('╔══════════════════════════════════════════════════════════╗');
      console.log('║  🌐 公网地址已就绪                                       ║');
      console.log('╠══════════════════════════════════════════════════════════╣');
      console.log(`║  ${publicUrl.padEnd(55)}║`);
      console.log('║                                                          ║');
      const cleanUrl = publicUrl.replace(/\/+$/, '');
      console.log(`║  API:  ${`${cleanUrl}/v1/chat/completions`.padEnd(48)}║`);
      console.log(`║  统计:  ${`${cleanUrl}/pool/stats`.padEnd(47)}║`);
      console.log(`║  健康:  ${`${cleanUrl}/health`.padEnd(47)}║`);
      console.log('╚══════════════════════════════════════════════════════════╝');
      console.log('');

      // 写入文件方便其他服务读取
      try {
        writeFileSync(resolve(__dirname, '..', '.tunnel-url'), cleanUrl + '\n', 'utf-8');
      } catch {}

      onUrl(cleanUrl);
    }

    if (!publicUrl && text.trim() && !text.includes('Warning')) {
      log('debug', `[tunnel] ${text.trim()}`);
    }
  };

  tunnelProcess.stdout.on('data', handleOutput);
  tunnelProcess.stderr.on('data', handleOutput);

  tunnelProcess.on('error', (err) => {
    log('warn', `SSH 隧道启动失败: ${err.message}`);
    log('info', '提示: 确保已安装 ssh 客户端，或在 config.json 中设置 "tunnel": false 关闭');
  });

  tunnelProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      log('warn', `SSH 隧道断开 (code ${code})，30 秒后重连...`);
      setTimeout(() => startTunnel(port, opts), 30000);
    }
  });

  return tunnelProcess;
}

/** 停止隧道 */
export function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
}

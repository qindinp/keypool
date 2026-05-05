/**
 * KeyPool — SSH 隧道管理
 *
 * 支持 localhost.run 和 serveo.net
 * 改进的 URL 提取（不再硬编码域名后缀）
 */

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TUNNEL_URL_PATH = resolve(__dirname, '..', '.tunnel-url');
const URL_DISCOVERY_TIMEOUT_MS = 25_000;
const HEALTH_RECHECK_INTERVAL_MS = 120_000;
const HEALTH_VERIFY_ATTEMPTS = 5;
const HEALTH_VERIFY_DELAY_MS = 3_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

let tunnelProcess = null;
let tunnelWatchTimer = null;
let tunnelDiscoveryTimer = null;
let tunnelCurrentUrl = null;
let tunnelRestartTimer = null;
let restartPlanned = false;
let consecutiveHealthFailures = 0;

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


function clearTunnelUrlFile() {
  tunnelCurrentUrl = null;
  try {
    if (existsSync(TUNNEL_URL_PATH)) unlinkSync(TUNNEL_URL_PATH);
  } catch {}
}

function clearTimers() {
  if (tunnelWatchTimer) {
    clearInterval(tunnelWatchTimer);
    tunnelWatchTimer = null;
  }
  if (tunnelDiscoveryTimer) {
    clearTimeout(tunnelDiscoveryTimer);
    tunnelDiscoveryTimer = null;
  }
  if (tunnelRestartTimer) {
    clearTimeout(tunnelRestartTimer);
    tunnelRestartTimer = null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function probePublicHealth(baseUrl, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealthyPublicUrl(publicUrl, log) {
  for (let attempt = 1; attempt <= HEALTH_VERIFY_ATTEMPTS; attempt += 1) {
    const result = await probePublicHealth(publicUrl, 10_000);
    if (result.ok) return true;
    log('warn', `tunnel 地址健康检查失败 (${publicUrl})，第 ${attempt}/${HEALTH_VERIFY_ATTEMPTS} 次: ${result.status || result.text}`);
    if (attempt < HEALTH_VERIFY_ATTEMPTS) await sleep(HEALTH_VERIFY_DELAY_MS);
  }
  return false;
}

function scheduleRestart(opts, log, reason, delayMs = 3_000) {
  // 如果已有重启计划，取消旧的，重新调度（避免静默丢弃后续失败）
  if (tunnelRestartTimer) {
    clearTimeout(tunnelRestartTimer);
    tunnelRestartTimer = null;
  }
  restartPlanned = true;
  clearTunnelUrlFile();
  clearTimers();
  log('warn', `${reason}，${Math.round(delayMs / 1000)} 秒后重建 SSH 隧道...`);
  tunnelRestartTimer = setTimeout(() => {
    restartPlanned = false;
    tunnelRestartTimer = null;
    startTunnel(opts.port, opts);
  }, delayMs);
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
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
  const runtimeOpts = { ...opts, port, service, log, onUrl };

  clearTimers();
  clearTunnelUrlFile();
  restartPlanned = false;  // 确保启动时状态干净
  consecutiveHealthFailures = 0;

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

  tunnelDiscoveryTimer = setTimeout(() => {
    if (!urlFound) {
      scheduleRestart(runtimeOpts, log, 'SSH 隧道长时间未产出公网地址', 5_000);
    }
  }, URL_DISCOVERY_TIMEOUT_MS);

  const handleOutput = (data) => {
    const text = data.toString();
    const publicUrl = extractPublicUrl(text);

    if (publicUrl && !urlFound) {
      urlFound = true;
      clearTimeout(tunnelDiscoveryTimer);
      tunnelDiscoveryTimer = null;

      (async () => {
        const healthy = await waitForHealthyPublicUrl(publicUrl, log);
        if (!healthy) {
          scheduleRestart(runtimeOpts, log, `SSH 隧道返回了失效地址 ${publicUrl}`);
          return;
        }

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

        tunnelCurrentUrl = cleanUrl;
        consecutiveHealthFailures = 0;
        try {
          writeFileSync(TUNNEL_URL_PATH, cleanUrl + '\n', 'utf-8');
        } catch {}

        tunnelWatchTimer = setInterval(async () => {
          if (!tunnelCurrentUrl || restartPlanned) return;
          const result = await probePublicHealth(tunnelCurrentUrl, 15_000);
          if (!result.ok) {
            consecutiveHealthFailures++;
            if (consecutiveHealthFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
              consecutiveHealthFailures = 0;
              scheduleRestart(runtimeOpts, log, `SSH 隧道健康检查连续 ${CONSECUTIVE_FAILURES_THRESHOLD} 次失败 (${result.status || result.text})`, 5_000);
            } else {
              log('warn', `SSH 隧道健康检查失败 (${result.status || result.text})，连续 ${consecutiveHealthFailures}/${CONSECUTIVE_FAILURES_THRESHOLD} 次，跳过重建`);
            }
          } else {
            consecutiveHealthFailures = 0;
          }
        }, HEALTH_RECHECK_INTERVAL_MS);

        onUrl(cleanUrl);
      })().catch((err) => {
        scheduleRestart(runtimeOpts, log, `SSH 隧道验证异常: ${err.message}`);
      });
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
    clearTimers();
    tunnelProcess = null;
    if (restartPlanned) return;
    clearTunnelUrlFile();
    consecutiveHealthFailures = 0;
    if (code !== 0 && code !== null) {
      log('warn', `SSH 隧道断开 (code ${code})，30 秒后重连...`);
      tunnelRestartTimer = setTimeout(() => {
        restartPlanned = false;
        tunnelRestartTimer = null;
        startTunnel(port, runtimeOpts);
      }, 30000);
    }
  });

  return tunnelProcess;
}

/** 停止隧道 */
export function stopTunnel() {
  restartPlanned = true;
  clearTimers();
  clearTunnelUrlFile();
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
}

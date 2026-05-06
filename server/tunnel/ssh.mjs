/**
 * SSH 隧道模式（回退）
 * localhost.run / serveo.net
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// ─── 内部工具 ─────────────────────────────────────────────────────
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

async function waitForHealthyPublicUrl(publicUrl, log, maxAttempts = 5, delayMs = 3_000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await probePublicHealth(publicUrl, 10_000);
    if (result.ok) return true;
    log('warn', `隧道地址健康检查失败 (${publicUrl})，第 ${attempt}/${maxAttempts} 次: ${result.status || result.text}`);
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return false;
}

// ─── SSH 隧道函数 ─────────────────────────────────────────────────
let tunnelProcess = null;

export function getSSHtunnelProcess() {
  return tunnelProcess;
}

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
 * @param {number} port
 * @param {object} opts
 * @param {object} state - { tunnelUrlPath, setCurrentUrl, getCurrentUrl, clearTunnelUrlFile, getRestartPlanned }
 */
export function startSSHtunnel(port, opts, state) {
  const service = opts.sshService || 'localhost.run';
  const log = opts.log || console.log;
  const onUrl = opts.onUrl || (() => {});
  const URL_DISCOVERY_TIMEOUT_MS = 25_000;
  const HEALTH_VERIFY_ATTEMPTS = 5;
  const HEALTH_VERIFY_DELAY_MS = 3_000;

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
  let discoveryTimer = setTimeout(() => {
    if (!urlFound) {
      log('warn', 'SSH 隧道长时间未产出公网地址，3 秒后重建...');
      stopSSHtunnel();
      setTimeout(() => startSSHtunnel(port, opts, state), 3_000);
    }
  }, URL_DISCOVERY_TIMEOUT_MS);

  const handleOutput = (data) => {
    const text = data.toString();
    const publicUrl = extractPublicUrl(text);
    if (publicUrl && !urlFound) {
      urlFound = true;
      clearTimeout(discoveryTimer);
      (async () => {
        const healthy = await waitForHealthyPublicUrl(publicUrl, log, HEALTH_VERIFY_ATTEMPTS, HEALTH_VERIFY_DELAY_MS);
        if (!healthy) {
          log('warn', `SSH 隧道返回了失效地址 ${publicUrl}，3 秒后重建...`);
          stopSSHtunnel();
          setTimeout(() => startSSHtunnel(port, opts, state), 3_000);
          return;
        }
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║  🌐 公网地址已就绪 (SSH 隧道)                              ║');
        console.log('╠══════════════════════════════════════════════════════════╣');
        console.log(`║  ${publicUrl.padEnd(55)}║`);
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log('');
        const cleanUrl = publicUrl.replace(/\/+$/, '');
        state.setCurrentUrl(cleanUrl);
        try { writeFileSync(state.tunnelUrlPath, cleanUrl + '\n', 'utf-8'); } catch {}
        onUrl(cleanUrl);
      })().catch((err) => {
        log('warn', `SSH 隧道验证异常: ${err.message}`);
      });
    }
  };

  tunnelProcess.stdout.on('data', handleOutput);
  tunnelProcess.stderr.on('data', handleOutput);
  tunnelProcess.on('error', (err) => {
    log('warn', `SSH 隧道启动失败: ${err.message}`);
  });
  tunnelProcess.on('close', (code) => {
    tunnelProcess = null;
    if (state.getRestartPlanned()) return;
    state.clearTunnelUrlFile();
    if (code !== 0 && code !== null) {
      log('warn', `SSH 隧道断开 (code ${code})，30 秒后重连...`);
      setTimeout(() => startSSHtunnel(port, opts, state), 30_000);
    }
  });
}

export function stopSSHtunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
    tunnelProcess = null;
  }
}

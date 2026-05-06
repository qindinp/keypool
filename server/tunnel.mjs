/**
 * KeyPool — 隧道管理（Tailscale Funnel / SSH 回退）
 *
 * Tailscale Funnel 模式：
 *   - 通过 tailscale serve + funnel 暴露本地端口到公网
 *   - 固定 URL，商业级稳定性
 *   - 支持 Auth Key 免交互登录
 *
 * SSH 隧道模式（回退）：
 *   - localhost.run / serveo.net
 */

import { spawn, execSync } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TUNNEL_URL_PATH = resolve(__dirname, '..', '.tunnel-url');

// ─── 状态 ────────────────────────────────────────────────────────
let tunnelProcess = null;
let tunnelWatchTimer = null;
let tunnelCurrentUrl = null;
let tunnelRestartTimer = null;
let restartPlanned = false;
let consecutiveHealthFailures = 0;

const HEALTH_RECHECK_INTERVAL_MS = 120_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

// ─── 工具函数 ─────────────────────────────────────────────────────
function clearTunnelUrlFile() {
  tunnelCurrentUrl = null;
  try {
    if (existsSync(TUNNEL_URL_PATH)) unlinkSync(TUNNEL_URL_PATH);
  } catch {}
}

function clearTimers() {
  if (tunnelWatchTimer) { clearInterval(tunnelWatchTimer); tunnelWatchTimer = null; }
  if (tunnelRestartTimer) { clearTimeout(tunnelRestartTimer); tunnelRestartTimer = null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(cmd, args = [], opts = {}) {
  try {
    const result = execSync(`${cmd} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: opts.timeout || 15_000,
      ...opts,
    });
    return { ok: true, stdout: result.trim(), stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout?.trim() || '', stderr: e.stderr?.trim() || e.message };
  }
}

// ─── 健康检查 ─────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════
//  Tailscale Funnel 模式
// ══════════════════════════════════════════════════════════════════

function isTailscaleInstalled() {
  return run('which', ['tailscale']).ok;
}

function isTailscaleLoggedIn() {
  const result = run('tailscale', ['status', '--json'], { timeout: 5_000 });
  if (!result.ok) return false;
  try {
    const status = JSON.parse(result.stdout);
    return !!status.BackendState && status.BackendState !== 'NeedsLogin';
  } catch {
    return false;
  }
}

function tailscaleLogin(authKey, hostname, log) {
  const args = ['up'];
  if (authKey) args.push(`--authkey=${authKey}`);
  if (hostname) args.push(`--hostname=${hostname}`);
  log('info', `🔐 Tailscale 登录中 (hostname: ${hostname || 'default'})...`);
  const result = run('tailscale', args, { timeout: 30_000 });
  if (!result.ok) {
    log('error', `Tailscale 登录失败: ${result.stderr || result.stdout}`);
    return false;
  }
  log('info', '✅ Tailscale 登录成功');
  return true;
}

function getTailscaleFqdn(log) {
  const result = run('tailscale', ['status', '--json'], { timeout: 5_000 });
  if (!result.ok) return null;
  try {
    const status = JSON.parse(result.stdout);
    const self = status.Self;
    if (self?.DNSName) return self.DNSName.replace(/\.$/, '');
    // fallback: 从 Health 字段获取
    if (status.CurrentTailnet?.MagicDNSSuffix) {
      const host = self?.HostName || 'keypool';
      return `${host}.${status.CurrentTailnet.MagicDNSSuffix}`;
    }
  } catch {}
  return null;
}

function enableTailscaleServe(port, log) {
  log('info', `🌐 启用 Tailscale Serve (localhost:${port})...`);
  const result = run('tailscale', ['serve', '--bg', String(port)], { timeout: 15_000 });
  if (!result.ok) {
    // 如果已经启用，不算失败
    if (result.stdout.includes('already') || result.stderr.includes('already')) {
      log('info', 'Tailscale Serve 已启用');
      return true;
    }
    log('error', `Tailscale Serve 启用失败: ${result.stderr || result.stdout}`);
    return false;
  }
  log('info', '✅ Tailscale Serve 已启用');
  return true;
}

function enableTailscaleFunnel(port, log) {
  log('info', `🌍 启用 Tailscale Funnel (公网暴露)...`);
  const result = run('tailscale', ['funnel', '--bg', String(port)], { timeout: 15_000 });
  if (!result.ok) {
    if (result.stdout.includes('already') || result.stderr.includes('already')) {
      log('info', 'Tailscale Funnel 已启用');
      return true;
    }
    log('error', `Tailscale Funnel 启用失败: ${result.stderr || result.stdout}`);
    return false;
  }
  log('info', '✅ Tailscale Funnel 已启用');
  return true;
}

function stopTailscaleServe(port) {
  run('tailscale', ['serve', '--bg', '--remove', String(port)], { timeout: 5_000 });
}

function stopTailscaleFunnel(port) {
  run('tailscale', ['funnel', '--bg', '--remove', String(port)], { timeout: 5_000 });
}

/**
 * 启动 Tailscale Funnel 隧道
 */
async function startTailscaleFunnel(port, opts) {
  const { log, tailscaleConfig = {} } = opts;
  const onUrl = opts.onUrl || (() => {});
  const authKey = tailscaleConfig.authKey || process.env.TAILSCALE_AUTHKEY || '';
  const hostname = tailscaleConfig.hostname || 'keypool';
  const enableFunnel = tailscaleConfig.funnel !== false;

  // 1. 检查安装
  if (!isTailscaleInstalled()) {
    log('error', '❌ Tailscale 未安装，请先运行: curl -fsSL https://tailscale.com/install.sh | sh');
    return null;
  }

  // 2. 检查登录状态
  if (!isTailscaleLoggedIn()) {
    if (!authKey) {
      log('error', '❌ Tailscale 未登录，请提供 authKey 或运行 tailscale up 手动登录');
      return null;
    }
    if (!tailscaleLogin(authKey, hostname, log)) return null;
  }

  // 3. 获取 FQDN
  const fqdn = getTailscaleFqdn(log);
  if (!fqdn) {
    log('error', '❌ 无法获取 Tailscale FQDN，请检查 tailscale status');
    return null;
  }
  log('info', `📡 Tailscale FQDN: ${fqdn}`);

  // 4. 启用 Serve
  if (!enableTailscaleServe(port, log)) return null;

  // 5. 启用 Funnel（如果配置开启）
  if (enableFunnel) {
    if (!enableTailscaleFunnel(port, log)) return null;
  }

  // 6. 构造 URL 并验证
  const publicUrl = `https://${fqdn}`;
  log('info', `🔍 验证隧道地址: ${publicUrl}`);

  const healthy = await waitForHealthyPublicUrl(publicUrl, log);
  if (!healthy) {
    log('warn', '⚠️  隧道地址健康检查未通过，但 URL 已生成（服务可能尚未启动）');
  }

  // 7. 输出信息
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🌐 Tailscale Funnel 已就绪                              ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  ${publicUrl.padEnd(55)}║`);
  console.log('║                                                          ║');
  const cleanUrl = publicUrl.replace(/\/+$/, '');
  console.log(`║  API:  ${`${cleanUrl}/v1/chat/completions`.padEnd(48)}║`);
  console.log(`║  统计:  ${`${cleanUrl}/pool/stats`.padEnd(47)}║`);
  console.log(`║  健康:  ${`${cleanUrl}/health`.padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // 8. 写入 URL 文件
  tunnelCurrentUrl = cleanUrl;
  consecutiveHealthFailures = 0;
  try {
    writeFileSync(TUNNEL_URL_PATH, cleanUrl + '\n', 'utf-8');
  } catch {}

  // 9. 定期健康检查
  tunnelWatchTimer = setInterval(async () => {
    if (!tunnelCurrentUrl || restartPlanned) return;
    const result = await probePublicHealth(tunnelCurrentUrl, 15_000);
    if (!result.ok) {
      consecutiveHealthFailures++;
      if (consecutiveHealthFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
        consecutiveHealthFailures = 0;
        log('warn', `隧道健康检查连续 ${CONSECUTIVE_FAILURES_THRESHOLD} 次失败，尝试重建...`);
        stopTailscaleFunnel(port);
        stopTailscaleServe(port);
        await sleep(2_000);
        startTailscaleFunnel(port, opts);
      } else {
        log('warn', `隧道健康检查失败 (${result.status || result.text})，连续 ${consecutiveHealthFailures}/${CONSECUTIVE_FAILURES_THRESHOLD} 次`);
      }
    } else {
      consecutiveHealthFailures = 0;
    }
  }, HEALTH_RECHECK_INTERVAL_MS);

  onUrl(cleanUrl);
  return cleanUrl;
}

// ══════════════════════════════════════════════════════════════════
//  SSH 隧道模式（回退）
// ══════════════════════════════════════════════════════════════════

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

function startSSHtunnel(port, opts) {
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
      setTimeout(() => startSSHtunnel(port, opts), 3_000);
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
          setTimeout(() => startSSHtunnel(port, opts), 3_000);
          return;
        }
        console.log('');
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║  🌐 公网地址已就绪 (SSH 隧道)                              ║');
        console.log('╠══════════════════════════════════════════════════════════╣');
        console.log(`║  ${publicUrl.padEnd(55)}║`);
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log('');
        tunnelCurrentUrl = publicUrl.replace(/\/+$/, '');
        try { writeFileSync(TUNNEL_URL_PATH, tunnelCurrentUrl + '\n', 'utf-8'); } catch {}
        onUrl(tunnelCurrentUrl);
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
    if (restartPlanned) return;
    clearTunnelUrlFile();
    if (code !== 0 && code !== null) {
      log('warn', `SSH 隧道断开 (code ${code})，30 秒后重连...`);
      setTimeout(() => startSSHtunnel(port, opts), 30_000);
    }
  });
}

function stopSSHtunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
    tunnelProcess = null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  公共接口
// ══════════════════════════════════════════════════════════════════

/**
 * 启动隧道
 * @param {number} port - 本地代理端口
 * @param {object} opts
 * @param {string} opts.tunnelType - 'tailscale' | 'ssh'（默认 tailscale）
 * @param {string} opts.sshService - SSH 模式下的服务（localhost.run | serveo.net）
 * @param {object} opts.tailscaleConfig - Tailscale 配置 { authKey, hostname, funnel }
 * @param {Function} opts.log - 日志函数
 * @param {Function} opts.onUrl - 获取到 URL 时回调
 */
export function startTunnel(port, opts = {}) {
  const tunnelType = opts.tunnelType || 'tailscale';
  const log = opts.log || console.log;

  clearTimers();
  clearTunnelUrlFile();
  restartPlanned = false;
  consecutiveHealthFailures = 0;

  if (tunnelType === 'tailscale') {
    startTailscaleFunnel(port, opts).catch(err => {
      log('error', `Tailscale Funnel 启动异常: ${err.message}`);
      log('info', '回退到 SSH 隧道模式...');
      startSSHtunnel(port, { ...opts, sshService: opts.sshService || 'localhost.run' });
    });
  } else {
    startSSHtunnel(port, opts);
  }
}

/** 停止隧道 */
export function stopTunnel() {
  restartPlanned = true;
  clearTimers();
  clearTunnelUrlFile();
  stopSSHtunnel();
  // Tailscale serve/funnel 是后台守护进程，不需要 kill
  // 如果需要清理：tailscale serve --bg --remove <port>
}

/**
 * KeyPool — 隧道管理（统一入口）
 *
 * Tailscale Funnel 模式 → ./tailscale.mjs
 * SSH 隧道模式（回退）  → ./ssh.mjs
 */

import { existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTailscaleFunnel, stopTailscaleServe, stopTailscaleFunnel } from './tailscale.mjs';
import { startSSHtunnel, stopSSHtunnel } from './ssh.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TUNNEL_URL_PATH = resolve(__dirname, '..', '..', '.tunnel-url');

// ─── 状态 ────────────────────────────────────────────────────────
let tunnelCurrentUrl = null;
let tunnelWatchTimer = null;
let tunnelRestartTimer = null;
let restartPlanned = false;
let consecutiveHealthFailures = 0;

// ─── 状态访问器（传递给子模块） ─────────────────────────────────
const state = {
  tunnelUrlPath: TUNNEL_URL_PATH,

  getCurrentUrl: () => tunnelCurrentUrl,
  setCurrentUrl: (url) => { tunnelCurrentUrl = url; },

  getRestartPlanned: () => restartPlanned,

  getHealthFailures: () => consecutiveHealthFailures,
  incHealthFailures: () => { consecutiveHealthFailures++; },
  resetHealthFailures: () => { consecutiveHealthFailures = 0; },

  setWatchTimer: (timer) => {
    if (tunnelWatchTimer) clearInterval(tunnelWatchTimer);
    tunnelWatchTimer = timer;
  },

  clearTunnelUrlFile: () => {
    tunnelCurrentUrl = null;
    try {
      if (existsSync(TUNNEL_URL_PATH)) unlinkSync(TUNNEL_URL_PATH);
    } catch {}
  },
};

// ─── 公共工具 ─────────────────────────────────────────────────────
function clearTimers() {
  if (tunnelWatchTimer) { clearInterval(tunnelWatchTimer); tunnelWatchTimer = null; }
  if (tunnelRestartTimer) { clearTimeout(tunnelRestartTimer); tunnelRestartTimer = null; }
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
  state.clearTunnelUrlFile();
  restartPlanned = false;
  consecutiveHealthFailures = 0;

  if (tunnelType === 'tailscale') {
    startTailscaleFunnel(port, opts, state).catch(err => {
      log('error', `Tailscale Funnel 启动异常: ${err.message}`);
      log('info', '回退到 SSH 隧道模式...');
      startSSHtunnel(port, { ...opts, sshService: opts.sshService || 'localhost.run' }, state);
    });
  } else {
    startSSHtunnel(port, opts, state);
  }
}

/** 停止隧道 */
export function stopTunnel() {
  restartPlanned = true;
  clearTimers();
  state.clearTunnelUrlFile();
  stopSSHtunnel();
  // Tailscale serve/funnel 是后台守护进程，不需要 kill
  // 如果需要清理：tailscale serve --bg --remove <port>
}

/**
 * Tailscale Funnel 模式
 * 通过 tailscale serve + funnel 暴露本地端口到公网
 */

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const HEALTH_RECHECK_INTERVAL_MS = 120_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

// ─── 内部工具 ─────────────────────────────────────────────────────
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

// ─── Tailscale 函数 ───────────────────────────────────────────────
function isTailscaleInstalled() {
  return run('which', ['tailscale']).ok;
}

function canAutoInstallTailscale(tailscaleConfig = {}) {
  return tailscaleConfig.autoInstall !== false;
}

function installTailscale(log) {
  log('info', '检测到未安装 Tailscale，尝试自动安装...');

  // 策略 1: 直接从 Tailscale 官方源安装（跳过全量 apt-get update，避免第三方镜像不可达导致失败）
  const repoScript = `
    set -e
    . /etc/os-release 2>/dev/null || true
    DISTRO=\${ID:-ubuntu}
    CODENAME=\${VERSION_CODENAME:-noble}
    ARCH=\$(dpkg --print-architecture 2>/dev/null || echo amd64)

    mkdir -p /usr/share/keyrings
    curl -fsSL "https://pkgs.tailscale.com/stable/\${DISTRO}/\${CODENAME}.noarmor.gpg" | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    chmod 0644 /usr/share/keyrings/tailscale-archive-keyring.gpg

    curl -fsSL "https://pkgs.tailscale.com/stable/\${DISTRO}/\${CODENAME}.tailscale-keyring.list" | tee /etc/apt/sources.list.d/tailscale.list >/dev/null
    chmod 0644 /etc/apt/sources.list.d/tailscale.list

    # 只更新 Tailscale 源，忽略其他源的错误
    apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/tailscale.list -o Dir::Etc::sourceparts=/dev/null 2>/dev/null || true

    apt-get install -y tailscale
  `.trim();

  try {
    execFileSync('sh', ['-c', repoScript], { encoding: 'utf-8', timeout: 180_000, stdio: 'pipe' });
    log('info', '✅ Tailscale 自动安装完成 (apt)');
    return true;
  } catch (e) {
    log('warn', `apt 安装失败: ${e.message}，尝试二进制安装...`);
  }

  // 策略 2: 直接下载二进制
  const binScript = `
    set -e
    ARCH=\$(uname -m)
    case "\$ARCH" in
      x86_64|amd64) TARCH="amd64" ;;
      aarch64|arm64) TARCH="arm64" ;;
      armv7l|armhf) TARCH="arm" ;;
      *) echo "Unsupported arch: \$ARCH" >&2; exit 1 ;;
    esac
    TMPDIR=\$(mktemp -d)
    curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_latest_\${TARCH}.tgz" | tar xzf - -C "\$TMPDIR"
    INSTALL_DIR=\$(ls -d "\$TMPDIR"/tailscale_* 2>/dev/null | head -1)
    if [ -z "\$INSTALL_DIR" ]; then echo "No tailscale binary found" >&2; exit 1; fi
    cp "\$INSTALL_DIR/tailscale" /usr/local/bin/tailscale
    cp "\$INSTALL_DIR/tailscaled" /usr/local/bin/tailscaled
    chmod +x /usr/local/bin/tailscale /usr/local/bin/tailscaled
    rm -rf "\$TMPDIR"
  `.trim();

  try {
    execFileSync('sh', ['-c', binScript], { encoding: 'utf-8', timeout: 180_000, stdio: 'pipe' });
    log('info', '✅ Tailscale 自动安装完成 (binary)');
    return true;
  } catch (e) {
    log('error', `Tailscale 自动安装失败: ${e.message}`);
    return false;
  }
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

export function stopTailscaleServe(port) {
  run('tailscale', ['serve', '--bg', '--remove', String(port)], { timeout: 5_000 });
}

export function stopTailscaleFunnel(port) {
  run('tailscale', ['funnel', '--bg', '--remove', String(port)], { timeout: 5_000 });
}

/**
 * 启动 Tailscale Funnel 隧道
 * @param {number} port
 * @param {object} opts
 * @param {object} state - { tunnelUrlPath, setCurrentUrl, resetHealthFailures, getHealthFailures, incHealthFailures, setWatchTimer, getWatchTimer, getRestartPlanned }
 */
export async function startTailscaleFunnel(port, opts, state) {
  const { log, tailscaleConfig = {} } = opts;
  const onUrl = opts.onUrl || (() => {});
  const authKey = tailscaleConfig.authKey || process.env.TAILSCALE_AUTHKEY || '';
  const hostname = tailscaleConfig.hostname || 'keypool';
  const enableFunnel = tailscaleConfig.funnel !== false;

  // 1. 检查安装
  if (!isTailscaleInstalled()) {
    if (canAutoInstallTailscale(tailscaleConfig)) {
      const installed = installTailscale(log);
      if (!installed) {
        log('error', '❌ Tailscale 自动安装失败，将回退到 SSH 隧道');
        throw new Error('tailscale auto install failed');
      }
    } else {
      log('error', '❌ Tailscale 未安装，且已禁用自动安装');
      throw new Error('tailscale not installed');
    }
  }

  // 2. 检查登录状态
  if (!isTailscaleLoggedIn()) {
    if (!authKey) {
      log('error', '❌ Tailscale 未登录，且未提供 authKey，无法免交互登录');
      throw new Error('tailscale auth key missing');
    }
    if (!tailscaleLogin(authKey, hostname, log)) {
      throw new Error('tailscale login failed');
    }
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
  state.setCurrentUrl(cleanUrl);
  state.resetHealthFailures();
  try {
    writeFileSync(state.tunnelUrlPath, cleanUrl + '\n', 'utf-8');
  } catch {}

  // 9. 定期健康检查
  const timer = setInterval(async () => {
    const currentUrl = state.getCurrentUrl();
    if (!currentUrl || state.getRestartPlanned()) return;
    const result = await probePublicHealth(currentUrl, 15_000);
    if (!result.ok) {
      state.incHealthFailures();
      if (state.getHealthFailures() >= CONSECUTIVE_FAILURES_THRESHOLD) {
        state.resetHealthFailures();
        log('warn', `隧道健康检查连续 ${CONSECUTIVE_FAILURES_THRESHOLD} 次失败，尝试重建...`);
        stopTailscaleFunnel(port);
        stopTailscaleServe(port);
        await sleep(2_000);
        startTailscaleFunnel(port, opts, state);
      } else {
        log('warn', `隧道健康检查失败 (${result.status || result.text})，连续 ${state.getHealthFailures()}/${CONSECUTIVE_FAILURES_THRESHOLD} 次`);
      }
    } else {
      state.resetHealthFailures();
    }
  }, HEALTH_RECHECK_INTERVAL_MS);
  state.setWatchTimer(timer);

  onUrl(cleanUrl);
  return cleanUrl;
}

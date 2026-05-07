#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const RUNTIME_DIR = resolve(ROOT, '.manager');
const PID_FILE = resolve(RUNTIME_DIR, 'app-bg.json');
const LOG_FILE = resolve(RUNTIME_DIR, 'app-bg.log');
const ERR_FILE = resolve(RUNTIME_DIR, 'app-bg.err.log');
const ENTRY = resolve(ROOT, 'app.mjs');
const ENV_KEYS_TO_HYDRATE = [
  'TAILSCALE_AUTHKEY',
  'TAILSCALE_HOSTNAME',
  'TAILSCALE_FUNNEL',
  'TAILSCALE_AUTO_INSTALL',
  'TUNNEL_TYPE',
  'TUNNEL_SERVICE',
];

function readWindowsUserEnvVar(name) {
  if (process.platform !== 'win32' || !name) return '';
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.status !== 0) return '';
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = output.match(new RegExp(`\\b${name}\\b\\s+REG_\\w+\\s+(.+)$`, 'mi'));
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function buildChildEnv() {
  const env = { ...process.env };
  for (const key of ENV_KEYS_TO_HYDRATE) {
    if (typeof env[key] === 'string' && env[key].length > 0) continue;
    const persisted = readWindowsUserEnvVar(key);
    if (persisted) env[key] = persisted;
  }
  return env;
}

function ensureRuntimeDir() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readMeta() {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  ensureRuntimeDir();
  writeFileSync(PID_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

function clearMeta() {
  try { rmSync(PID_FILE, { force: true }); } catch {}
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function getStatus() {
  const meta = readMeta();
  if (!meta) {
    return { running: false, pid: null, startedAt: null, logFile: LOG_FILE, errFile: ERR_FILE };
  }
  const alive = isPidAlive(meta.pid);
  if (!alive) {
    clearMeta();
    return { running: false, pid: meta.pid ?? null, startedAt: meta.startedAt ?? null, logFile: LOG_FILE, errFile: ERR_FILE };
  }
  return {
    running: true,
    pid: meta.pid,
    startedAt: meta.startedAt ?? null,
    logFile: meta.logFile || LOG_FILE,
    errFile: meta.errFile || ERR_FILE,
  };
}

function start() {
  const status = getStatus();
  if (status.running) {
    console.log(JSON.stringify({ ok: true, alreadyRunning: true, ...status }, null, 2));
    return;
  }

  ensureRuntimeDir();
  const outFd = openSync(LOG_FILE, 'a');
  const errFd = openSync(ERR_FILE, 'a');

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: buildChildEnv(),
  });

  child.unref();

  const meta = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logFile: LOG_FILE,
    errFile: ERR_FILE,
    entry: ENTRY,
  };
  writeMeta(meta);

  console.log(JSON.stringify({ ok: true, alreadyRunning: false, ...meta }, null, 2));
}

function stop() {
  const meta = readMeta();
  if (!meta || !isPidAlive(meta.pid)) {
    clearMeta();
    console.log(JSON.stringify({ ok: true, alreadyStopped: true }, null, 2));
    return;
  }

  const pid = Number(meta.pid);
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  // 延迟清理 PID 文件，给进程退出留时间
  // 避免 status 查询在进程实际退出前误报 "未运行"
  setTimeout(() => {
    try { if (!isPidAlive(pid)) clearMeta(); } catch {}
  }, 2000);

  console.log(JSON.stringify({ ok: true, alreadyStopped: false, pid }, null, 2));
}

const cmd = process.argv[2] || 'status';
if (cmd === 'start') {
  start();
} else if (cmd === 'stop') {
  stop();
} else if (cmd === 'status') {
  console.log(JSON.stringify({ ok: true, ...getStatus() }, null, 2));
} else {
  console.error('Usage: node scripts/app-bg.mjs <start|stop|status>');
  process.exit(1);
}

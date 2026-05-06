/**
 * 进程控制 API（/api/control/*）
 *
 * 从 relay/server.mjs 中提取，负责 manager 进程和后台 App 的启停管理。
 * 使用工厂函数 createControlApi(deps) 注入依赖，返回 handler 和进程控制函数。
 */

import { spawn, spawnSync } from 'node:child_process';
import { safeJsonParse, sendJson } from './utils.mjs';
import { sleep } from '../shared/utils.mjs';

export function createControlApi({ rootDir, appBgScriptPath }) {
  const managerControl = {
    child: null,
    lastExit: null,
  };

  function managerStatus() {
    return {
      running: Boolean(managerControl.child && managerControl.child.exitCode === null && !managerControl.child.killed),
      pid: managerControl.child?.pid || null,
      lastExit: managerControl.lastExit,
    };
  }

  function startManagerProcess() {
    const status = managerStatus();
    if (status.running) {
      return { ok: true, alreadyRunning: true, ...status };
    }

    const child = spawn(process.execPath, ['manager.mjs'], {
      cwd: rootDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(`[manager-control] ${chunk}`);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[manager-control] ${chunk}`);
    });

    child.on('exit', (code, signal) => {
      managerControl.lastExit = {
        code: code ?? null,
        signal: signal ?? null,
        at: new Date().toISOString(),
      };
      if (managerControl.child === child) {
        managerControl.child = null;
      }
    });

    managerControl.child = child;
    return { ok: true, alreadyRunning: false, ...managerStatus() };
  }

  function stopManagerProcess() {
    const child = managerControl.child;
    if (!child || child.exitCode !== null || child.killed) {
      managerControl.child = null;
      return Promise.resolve({ ok: true, alreadyStopped: true, ...managerStatus() });
    }

    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve({ ok: true, alreadyStopped: false, ...managerStatus() });
      };

      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!finished) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 1500);
      setTimeout(done, 2200);
    });
  }

  async function restartManagerProcess() {
    await stopManagerProcess();
    return startManagerProcess();
  }

  function runAppBgCommand(command) {
    const result = spawnSync(process.execPath, [appBgScriptPath, command], {
      cwd: rootDir,
      env: { ...process.env },
      encoding: 'utf-8',
      windowsHide: true,
    });

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const body = safeJsonParse(stdout, null);
    if (result.status !== 0 || !body) {
      throw new Error((stderr || stdout || `app-bg ${command} 执行失败`).trim());
    }
    return body;
  }

  function appStatus() {
    return runAppBgCommand('status');
  }

  function startAppProcess() {
    return runAppBgCommand('start');
  }

  function stopAppProcess() {
    return runAppBgCommand('stop');
  }

  async function startAllServices() {
    const app = startAppProcess();
    await sleep(1200);
    const manager = managerStatus().running ? managerStatus() : startManagerProcess();
    let appStatusAfter = app;
    try {
      appStatusAfter = appStatus();
    } catch {
    }
    return {
      ok: true,
      app: appStatusAfter,
      manager,
      note: '已尝试一键启动后台 App 与同步服务；若当前页面来自现有 relay，则会优先复用它。',
    };
  }

  async function handleControlApi(req, res, url) {
    if (url.pathname === '/api/control/status' && req.method === 'GET') {
      return sendJson(res, 200, managerStatus());
    }

    if (url.pathname === '/api/control/start' && req.method === 'POST') {
      return sendJson(res, 200, startManagerProcess());
    }

    if (url.pathname === '/api/control/stop' && req.method === 'POST') {
      return sendJson(res, 200, await stopManagerProcess());
    }

    if (url.pathname === '/api/control/restart' && req.method === 'POST') {
      return sendJson(res, 200, await restartManagerProcess());
    }

    if (url.pathname === '/api/control/app/status' && req.method === 'GET') {
      try {
        return sendJson(res, 200, appStatus());
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'app_bg_status_failed', message: e.message });
      }
    }

    if (url.pathname === '/api/control/app/start' && req.method === 'POST') {
      try {
        return sendJson(res, 200, startAppProcess());
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'app_bg_start_failed', message: e.message });
      }
    }

    if (url.pathname === '/api/control/app/stop' && req.method === 'POST') {
      try {
        return sendJson(res, 200, stopAppProcess());
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'app_bg_stop_failed', message: e.message });
      }
    }

    if (url.pathname === '/api/control/all/start' && req.method === 'POST') {
      try {
        return sendJson(res, 200, await startAllServices());
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'start_all_failed', message: e.message });
      }
    }

    return sendJson(res, 404, {
      error: 'not_found',
      message: '支持的控制路径: /api/control/status /api/control/start /api/control/stop /api/control/restart /api/control/app/status /api/control/app/start /api/control/app/stop /api/control/all/start',
    });
  }

  return {
    handleControlApi,
    managerStatus,
    startManagerProcess,
    stopManagerProcess,
    restartManagerProcess,
    appStatus,
    startAppProcess,
    stopAppProcess,
    startAllServices,
  };
}

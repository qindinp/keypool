/**
 * Admin 业务逻辑
 * - Manager 启停控制
 * - 账号 CRUD（cookie / create / update / delete）
 * - mutateAccountsConfig（文件读写 + 审计 + 重启联动）
 * - 辅助函数（normalizeTags / readJsonBody）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { accountsPath, logAudit } from './audit.mjs';

export function buildManagerStatus(manager) {
  if (!manager) {
    return { running: false, workers: 0, enabled: false, note: 'Manager 未挂载到 Gateway' };
  }

  return {
    running: true,
    workers: Array.isArray(manager.workers) ? manager.workers.length : 0,
    enabled: true,
    config: sanitizeManagerConfig(manager.config || null),
  };
}

export function sanitizeManagerConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const clone = { ...config };
  if (typeof clone.tailscaleAuthKey === 'string' && clone.tailscaleAuthKey) {
    clone.tailscaleAuthKey = '<redacted>';
  }
  return clone;
}

export async function startManager(manager) {
  if (!manager) {
    logAudit('manager.start', '-', 'Manager 未挂载', false);
    return { ok: false, error: 'manager_unavailable', message: 'Manager 未挂载到 Gateway' };
  }
  try {
    manager.start();
    logAudit('manager.start', '-', 'ok', true);
    return { ok: true, message: 'Manager 已启动', manager: buildManagerStatus(manager) };
  } catch (error) {
    logAudit('manager.start', '-', error?.message || String(error), false);
    return { ok: false, error: 'manager_start_failed', message: error?.message || String(error) };
  }
}

export async function stopManager(manager) {
  if (!manager) {
    logAudit('manager.stop', '-', 'Manager 未挂载', false);
    return { ok: false, error: 'manager_unavailable', message: 'Manager 未挂载到 Gateway' };
  }
  try {
    await manager.stop();
    logAudit('manager.stop', '-', 'ok', true);
    return {
      ok: true,
      message: 'Manager 已停止',
      manager: { running: false, workers: Array.isArray(manager.workers) ? manager.workers.length : 0 },
    };
  } catch (error) {
    logAudit('manager.stop', '-', error?.message || String(error), false);
    return { ok: false, error: 'manager_stop_failed', message: error?.message || String(error) };
  }
}

export async function restartManager(manager) {
  const stopped = await stopManager(manager);
  if (!stopped.ok) return stopped;
  const started = await startManager(manager);
  if (!started.ok) return started;
  return { ...started, message: 'Manager 已重启' };
}

export async function runAccountAction(manager, accountId, action) {
  if (!manager) {
    return { ok: false, error: 'manager_unavailable', message: 'Manager 未挂载到 Gateway' };
  }

  const worker = Array.isArray(manager.workers)
    ? manager.workers.find(item => String(item.account?.id) === String(accountId))
    : null;

  if (!worker) {
    return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
  }

  try {
    if (action === 'deploy') {
      await worker.create();
    } else if (action === 'recover') {
      await worker.recover();
    } else if (action === 'destroy') {
      await worker.api.destroyInstance(worker.account.cookie);
      worker.instance = null;
      worker.state = 'DESTROYED';
      worker.registry.updateInstanceState(worker.account.id, {
        status: 'DESTROYED',
        destroyedAt: new Date().toISOString(),
        tunnel: null,
        tunnelAccountId: null,
        tunnelRunId: null,
        tunnelConnectedAt: null,
        verified: false,
        healthOk: false,
      });
    } else if (action === 'stop') {
      await worker.manualStop();
    }

    logAudit(`account.${action}`, accountId, 'ok', true);
    return {
      ok: true,
      action,
      accountId: worker.account.id,
      state: worker.snapshot(),
    };
  } catch (error) {
    logAudit(`account.${action}`, accountId, error?.message || String(error), false);
    return {
      ok: false,
      error: 'account_action_failed',
      action,
      accountId: worker.account.id,
      message: error?.message || String(error),
    };
  }
}

export async function updateAccountCookie(manager, accountId, req) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return { ok: false, error: 'invalid_json', message: error?.message || '请求体不是合法 JSON' };
  }

  const cookie = String(payload?.cookie || '').trim();
  if (!cookie) {
    return { ok: false, error: 'cookie_required', message: 'cookie 不能为空' };
  }

  return mutateAccountsConfig(async ({ raw, list }) => {
    const target = list.find((item, index) => String(item?.id || item?.name || `account-${index + 1}`) === String(accountId));
    if (!target) {
      return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
    }

    target.cookie = cookie;
    delete target.cookieFile;

    if (manager && Array.isArray(manager.workers)) {
      const worker = manager.workers.find(item => String(item.account?.id) === String(accountId));
      if (worker?.account) worker.account.cookie = cookie;
    }

    return {
      ok: true,
      accountId,
      message: `账号 ${accountId} 的 cookie 已更新`,
      raw,
      list,
      restartManagerAfterSave: false,
    };
  }, undefined, 'account.cookie', accountId);
}

export async function createAccount(manager, req) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return { ok: false, error: 'invalid_json', message: error?.message || '请求体不是合法 JSON' };
  }

  const id = String(payload?.id || '').trim();
  const name = String(payload?.name || id).trim();
  const cookie = String(payload?.cookie || '').trim();
  const enabled = payload?.enabled !== false;
  const priority = Number.isFinite(Number(payload?.priority)) ? Number(payload.priority) : 100;
  const weight = Number.isFinite(Number(payload?.weight)) ? Math.max(0, Math.round(Number(payload.weight))) : 100;
  const tags = normalizeTags(payload?.tags);

  if (!id) return { ok: false, error: 'id_required', message: '账号 ID 不能为空' };
  if (!cookie) return { ok: false, error: 'cookie_required', message: 'cookie 不能为空' };

  return mutateAccountsConfig(async ({ raw, list }) => {
    const exists = list.some((item, index) => String(item?.id || item?.name || `account-${index + 1}`) === id);
    if (exists) {
      return { ok: false, error: 'account_exists', message: `账号 ${id} 已存在` };
    }

    list.push({ id, name, enabled, priority, weight, tags, cookie });
    return {
      ok: true,
      accountId: id,
      message: `账号 ${id} 已创建，并已重载 Manager`,
      raw,
      list,
      restartManagerAfterSave: true,
    };
  }, manager, 'account.create', id);
}

export async function updateAccount(manager, accountId, req) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return { ok: false, error: 'invalid_json', message: error?.message || '请求体不是合法 JSON' };
  }

  return mutateAccountsConfig(async ({ raw, list }) => {
    const target = list.find((item, index) => String(item?.id || item?.name || `account-${index + 1}`) === String(accountId));
    if (!target) {
      return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
    }

    const nextId = String(payload?.id || target.id || accountId).trim();
    const nextName = String(payload?.name || target.name || nextId).trim();
    const nextCookie = typeof payload?.cookie === 'string' ? payload.cookie.trim() : '';
    const nextEnabled = payload?.enabled !== undefined ? payload.enabled !== false : target.enabled !== false;
    const nextPriority = payload?.priority !== undefined ? (Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 100) : (Number.isFinite(Number(target.priority)) ? Number(target.priority) : 100);
    const nextWeight = payload?.weight !== undefined ? (Number.isFinite(Number(payload.weight)) ? Math.max(0, Math.round(Number(payload.weight))) : 100) : (Number.isFinite(Number(target.weight)) ? Math.max(0, Math.round(Number(target.weight))) : 100);
    const nextTags = payload?.tags !== undefined ? normalizeTags(payload.tags) : (Array.isArray(target.tags) ? target.tags : []);

    if (!nextId) return { ok: false, error: 'id_required', message: '账号 ID 不能为空' };
    const conflict = list.some((item, index) => item !== target && String(item?.id || item?.name || `account-${index + 1}`) === nextId);
    if (conflict) return { ok: false, error: 'account_exists', message: `账号 ${nextId} 已存在` };

    target.id = nextId;
    target.name = nextName || nextId;
    target.enabled = nextEnabled;
    target.priority = nextPriority;
    target.weight = nextWeight;
    target.tags = nextTags;
    if (nextCookie) {
      target.cookie = nextCookie;
      delete target.cookieFile;
    }

    return {
      ok: true,
      accountId: nextId,
      message: `账号 ${accountId} 已更新，并已重载 Manager`,
      raw,
      list,
      restartManagerAfterSave: true,
    };
  }, manager, 'account.update', accountId);
}

export async function deleteAccount(manager, accountId) {
  return mutateAccountsConfig(async ({ raw, list }) => {
    const index = list.findIndex((item, idx) => String(item?.id || item?.name || `account-${idx + 1}`) === String(accountId));
    if (index < 0) {
      return { ok: false, error: 'account_not_found', message: `未找到账号 ${accountId}` };
    }

    list.splice(index, 1);
    return {
      ok: true,
      accountId,
      message: `账号 ${accountId} 已删除，并已重载 Manager`,
      raw,
      list,
      restartManagerAfterSave: true,
    };
  }, manager, 'account.delete', accountId);
}

export async function mutateAccountsConfig(mutator, manager, auditAction, auditTarget) {
  if (!existsSync(accountsPath)) {
    return { ok: false, error: 'accounts_missing', message: 'accounts.json 不存在，无法在界面中管理账号' };
  }

  try {
    const raw = JSON.parse(readFileSync(accountsPath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : null;
    if (!Array.isArray(list)) {
      return { ok: false, error: 'accounts_invalid', message: 'accounts.json 结构不受支持' };
    }

    const result = await mutator({ raw, list });
    if (!result?.ok) {
      if (auditAction) logAudit(auditAction, auditTarget || '-', result.message || 'failed', false);
      return result;
    }

    writeFileSync(accountsPath, JSON.stringify(Array.isArray(raw) ? list : { ...raw, accounts: list }, null, 2), 'utf-8');

    if (result.restartManagerAfterSave && manager) {
      const restarted = await restartManager(manager);
      if (!restarted.ok) {
        if (auditAction) logAudit(auditAction, auditTarget || '-', `配置已保存，但 Manager 重载失败：${restarted.message || restarted.error || 'unknown'}`, false);
        return {
          ok: false,
          error: 'manager_restart_failed',
          message: `账号配置已保存，但 Manager 重载失败：${restarted.message || restarted.error || 'unknown error'}`,
        };
      }
    }

    const { raw: _raw, list: _list, ...sanitized } = result;
    if (auditAction) logAudit(auditAction, auditTarget || '-', sanitized.message || 'ok', true);
    return sanitized;
  } catch (error) {
    if (auditAction) logAudit(auditAction, auditTarget || '-', error?.message || String(error), false);
    return {
      ok: false,
      error: 'accounts_mutation_failed',
      message: error?.message || String(error),
    };
  }
}

export function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

const MAX_BODY_BYTES = 512 * 1024; // 512KB

export async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`请求体超过大小限制 (${MAX_BODY_BYTES / 1024}KB)`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/**
 * 审计日志基础设施
 * - 内存环形缓冲 (AUDIT_MAX=200)
 * - .keypool-audit.json 文件持久化
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// audit.mjs 位于 src/gateway/admin/，需要向上 3 级到达仓库根目录
export const workspaceRoot = resolve(__dirname, '..', '..', '..');
export const accountsPath = resolve(workspaceRoot, 'accounts.json');

const auditPath = resolve(workspaceRoot, '.keypool-audit.json');
const AUDIT_MAX = 200;

let auditLog = [];
try {
  if (existsSync(auditPath)) auditLog = JSON.parse(readFileSync(auditPath, 'utf-8')).slice(-AUDIT_MAX);
} catch { auditLog = []; }

export { auditLog };

export function logAudit(action, target, detail, ok) {
  const entry = { at: new Date().toISOString(), action, target, detail: String(detail || ''), ok: !!ok };
  auditLog.push(entry);
  if (auditLog.length > AUDIT_MAX) auditLog = auditLog.slice(-AUDIT_MAX);
  try { writeFileSync(auditPath, JSON.stringify(auditLog, null, 2), 'utf-8'); } catch {}
}

#!/usr/bin/env node
/**
 * @deprecated 此文件已废弃，请使用 manager.mjs
 *
 * controller.mjs 是旧版的单账号控制器。
 * 新版 manager.mjs 支持多账号、registry 同步、健康感知等完整功能。
 *
 * 迁移方式：
 *   旧: node controller.mjs
 *   新: node manager.mjs
 *
 * 如需保留旧逻辑用于参考，此文件不做删除。
 */

console.warn('⚠️  controller.mjs 已废弃，请使用 manager.mjs 代替');
console.warn('   运行: node manager.mjs');
console.warn('   文档: 参见 ARCHITECTURE.md');
process.exit(1);

/**
 * Gateway 路由策略
 *
 * 按 model 字段选择 verified upstream
 * 无 model 时选择第一个可用 upstream
 */

/**
 * 选择目标 upstream
 * @param {import('./registry.mjs').Registry} registry
 * @param {string} [model]
 * @returns {object|null}
 */
export function chooseUpstream(registry, model) {
  return registry.chooseVerifiedUpstream(model);
}

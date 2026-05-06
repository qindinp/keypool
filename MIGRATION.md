# 迁移指南 — v0.4.0 重构

> **Phase 1-5 更新 (2026-05-06)**: 项目已完成模块化拆分，详见下方"模块化拆分"章节。

## 模块化拆分 (Phase 1-5)

原根目录散落的单文件已拆分为三层架构：

| 新路径 | 职责 |
|--------|------|
| `src/shared/` | 公共工具 (http, ws, cookie, logger, state-store, utils) |
| `src/manager/` | 管理器 (accounts, account-worker, deploy-client, registry, mimo-api) |
| `src/relay/` | 中继层 (server, admin-api, control-api, proxy, router) |
| `bin/` | 入口点 (server, manager, relay, app, key-exchange, ws-client) |

根目录 `app.mjs`、`manager.mjs`、`server.mjs` 保留为向后兼容入口。

已删除：`controller.mjs`、`controller-deprecated.mjs`、`auto-renew.mjs`、`renew.mjs`

---

## server.mjs 拆分

原 `server.mjs` (35KB 单文件) 已拆分为 `server/` 目录下的独立模块：

| 新文件 | 职责 | 行数 |
|--------|------|------|
| `server/config.mjs` | 配置加载 & OpenClaw 自动检测 | ~120 |
| `server/key-pool.mjs` | KeyPool 类（轮转、健康、恢复） | ~100 |
| `server/proxy.mjs` | HTTP 代理核心（有限重试 + 超时 + body 限制） | ~140 |
| `server/anthropic-adapter.mjs` | Anthropic ↔ OpenAI 双向转换（含 tool_use） | ~350 |
| `server/tunnel.mjs` | SSH 隧道管理（改进 URL 提取） | ~100 |
| `server/index.mjs` | 主入口 & 路由 | ~220 |

`server.mjs` 保留为向后兼容入口，直接 `import './server/index.mjs'`。

## 关键修复

### 1. 无限递归重试 → 有限重试

**旧代码**：`proxyRequest()` 和 `proxyAnthropicSync()` 在 429/401/403 时递归调用自身，无退出条件。

**新代码**：增加 `retryCount` 和 `maxRetries` 参数，默认最多重试 `pool.keys.length - 1` 次。

```js
// server/proxy.mjs
export function proxyRequest(opts) {
  const { retryCount = 0, maxRetries, ... } = opts;
  // ...
  if (retryCount < maxRetries) {
    return proxyRequest({ ...opts, retryCount: retryCount + 1 });
  }
}
```

配置项：`config.json` 中 `"maxRetries": 3`（默认值）。

### 2. 请求超时

所有上游请求增加 120 秒超时：

```js
proxyReq.setTimeout(120_000, () => {
  proxyReq.destroy(new Error('Upstream request timeout'));
});
```

### 3. 请求体大小限制

限制请求体最大 10MB，超限直接返回 413：

```js
// server/proxy.mjs
const MAX_BODY_BYTES = 10 * 1024 * 1024;
```

### 4. Anthropic 适配完善

**旧代码**：`tool_use` block 被当作纯文本 `[tool_use: name]` 处理。

**新代码**：
- 请求转换：`tool_use` → OpenAI `tool_calls` 格式，`tool_result` → `tool` role message
- 响应转换：OpenAI `tool_calls` → Anthropic `tool_use` block
- 流式转换：支持 `input_json_delta` 事件
- 工具定义：`tools[].input_schema` → OpenAI `tools[].function.parameters`

### 5. Tunnel URL 正则

**旧代码**：只匹配 `.lhr.life` 和 `.serveo.net`。

**新代码**：两层匹配策略 — 先匹配已知服务域名，再 fallback 到通用 URL 提取。

### 6. parseJsonLike → parseJsonc

**旧代码**：用正则处理单引号、无引号 key 等，容易误伤。

**新代码**：只处理注释和尾逗号（标准 JSONC），不尝试处理非标准 JSON。如果需要更复杂的格式，建议用 JSON5 库。

## 废弃文件

| 文件 | 状态 | 替代方案 |
|------|------|----------|
| `controller.mjs` | ⚠️ 废弃 | `manager.mjs` |
| `auto-renew.mjs` | ⚠️ 废弃 | `manager.mjs` (内置续期) |
| `renew.mjs` | ⚠️ 废弃 | `manager.mjs` (内置续期) |

建议在这些文件顶部添加废弃提示，或直接删除。

## 新增配置项

`config.json` 新增字段：

```json
{
  "maxRetries": 3
}
```

其他字段不变。

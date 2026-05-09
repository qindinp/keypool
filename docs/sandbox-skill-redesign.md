# AI Studio 沙箱实例侧 Skill 重构设计文档

> 版本：v3.0 | 日期：2026-05-09 | 状态：待确认
> 基于沙箱实例真实环境验证
>
> v3.0 核心变更：**不注入 API Key**。Tunnel proxy 直接读取沙箱 OpenClaw 的 `openclaw.json` 配置（`models.providers.xiaomi.apiKey` + `baseUrl`），deployer 只注入 Gateway URL 等非敏感配置。

## 一、真实环境约束

以下信息来自对当前沙箱实例的实际探测：

| 项目 | 实际情况 | 影响 |
|------|----------|------|
| Node.js | v22.22.1 | 支持 ESM、顶层 await |
| npm | 10.9.4 | 可用但不应自动调用 |
| ws 模块 | **未安装在项目中**，但 OpenClaw 依赖中有（`/usr/lib/node_modules/openclaw/node_modules/ws`） | 需通过 `require.resolve` 定位 |
| OpenClaw 配置 | `openclaw.json` → `models.providers.xiaomi` 含 `baseUrl`、`apiKey`、`models` | **直接复用，不需要额外注入 Key** |
| 环境变量 | `MIMO_API_KEY`、`MIMO_API_ENDPOINT` 已存在 | 可作为兜底读取 |
| .env | 空文件 | 不使用 |
| 用户 | root | 无权限限制 |
| 磁盘 | 40G，已用 7.9G | 充足 |
| 内存 | 3.4G，可用 ~1.7G | 充足 |
| OpenClaw | 2026.3.12 | 已全局安装 |

### 配置探测详情

```
openclaw.json → models.providers.xiaomi:
  baseUrl:  https://api-oc.xiaomimimo.com/v1
  api:      openai-completions
  apiKey:   (已配置)
  models:   [{ id: "mimo-v2.5-pro", name: "MiMo V2 Pro", reasoning: true, ... }]

环境变量:
  MIMO_API_KEY:       (已配置)
  MIMO_API_ENDPOINT:  https://api-oc.xiaomimimo.com/v1/chat/completions
```

## 二、核心设计决策

### 决策 1：复用 OpenClaw 配置，不注入 API Key

**关键发现**：沙箱实例的 OpenClaw 已经配置了 MiMo API 的 baseUrl 和 apiKey。Tunnel proxy 直接读取即可，不需要 deployer 注入。

**配置读取优先级**：
1. `process.env.MIMO_API_KEY`（环境变量，最直接）
2. `/root/.openclaw/openclaw.json` → `models.providers.xiaomi.apiKey`（兜底）

**安全收益**：
- deployer 不需要获取、传输、注入 API Key
- Key 不存在于 deployer 日志、chat prompt、或任何中间环节
- Key 仅在沙箱进程内存中，由沙箱自己的 OpenClaw 管理

### 决策 2：ws 模块定位

**问题**：沙箱中 `ws` 不在项目 `node_modules` 里，`import 'ws'` 会失败。

**方案**：使用 `createRequire` + `require.resolve` 定位 OpenClaw 自带的 ws 模块：

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let WebSocket;
try {
  WebSocket = (await import('ws')).default;
} catch {
  const wsPath = require.resolve('ws', { paths: ['/usr/lib/node_modules/openclaw'] });
  WebSocket = (await import(wsPath)).default;
}
```

**不自动安装任何包。** 两处都找不到则报错退出。

### 决策 3：Gateway URL 配置

**方案**：
- skill 代码中使用占位符 `__KEYPOOL_GATEWAY_URL__`
- deployer 从 `KEYPOOL_GATEWAY_URL` 环境变量或配置中读取实际值注入
- 用户**必须**配置自己控制的公网地址
- 默认值 `ws://127.0.0.1:9300/tunnel`（仅本地测试用）

## 三、目录结构

```
keypool/
├── skill/                                  # 新增：沙箱实例侧 skill
│   ├── SKILL.md                            # skill 元数据
│   └── scripts/
│       ├── tunnel-proxy.mjs                # 主入口（含健康检查 HTTP 服务）
│       └── lib/
│           ├── ws-client.mjs               # WebSocket 连接管理 + 重连
│           └── api-handler.mjs             # MiMo API 代理
├── skill-proxy/                            # 保留（旧版参考，不改动）
├── src/
│   ├── gateway/                            # 不动
│   └── manager/
│       ├── deployer.mjs                    # 修改：读取 skill/ 静态文件
│       └── ...                             # 其余不动
└── docs/
    └── sandbox-skill-redesign.md           # 本文档
```

## 四、模块详细设计

### 4.1 主入口 `tunnel-proxy.mjs`

#### 完整启动流程

```
1. 定位 ws 模块
   ├─ try import('ws')              → 项目本地
   ├─ catch require.resolve('ws', { paths: ['/usr/lib/node_modules/openclaw'] })
   └─ 都失败 → console.error + process.exit(1)

2. 加载配置（从沙箱 OpenClaw 环境读取，不读文件注入）
   ├─ API_KEY    = process.env.MIMO_API_KEY
   │            || readOpenClawConfig().models.providers.xiaomi.apiKey
   ├─ BASE_URL   = process.env.MIMO_API_ENDPOINT?.replace(/\/chat\/completions$/, '')
   │            || readOpenClawConfig().models.providers.xiaomi.baseUrl
   │            || 'https://api-oc.xiaomimimo.com/v1'
   ├─ GATEWAY_WS_URL = '__KEYPOOL_GATEWAY_URL__'  // deployer 模板注入（唯一的注入项）
   ├─ ACCOUNT_ID     = '__KEYPOOL_ACCOUNT_ID__'
   ├─ RUN_ID         = '__KEYPOOL_RUN_ID__'
   └─ HEALTH_PORT    = 9201

3. 创建 ApiHandler（传入 API_KEY, BASE_URL）

4. 启动 HTTP 健康检查服务（127.0.0.1:9201）

5. 创建 WsClient 并连接 Gateway
   ├─ wsClient = new WsClient({ gatewayWsUrl, accountId, runId, apiHandler })
   └─ wsClient.connect()

6. 注册信号处理
   ├─ SIGINT  → wsClient.close() → httpServer.close() → exit(0)
   └─ SIGTERM → wsClient.close() → httpServer.close() → exit(0)
```

#### readOpenClawConfig()

读取 `/root/.openclaw/openclaw.json`，提取 `models.providers.xiaomi` 配置。仅在环境变量缺失时作为兜底。

```js
function readOpenClawConfig() {
  try {
    const raw = readFileSync('/root/.openclaw/openclaw.json', 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
```

#### 运行时状态（供健康检查使用）

```js
const stats = {
  startedAt: Date.now(),
  requestCount: 0,
  lastRequestAt: null,
  lastError: null,
  lastErrorAt: null,
  consecutiveErrors: 0,
};
```

### 4.2 WebSocket 连接管理 `ws-client.mjs`

#### 导出接口

```js
export class WsClient {
  constructor({ gatewayWsUrl, accountId, runId, apiHandler, stats })
  connect()                    // 发起连接
  close()                      // 主动关闭（不再重连）
  get status()                 // 'connecting' | 'connected' | 'disconnected' | 'exhausted'
  get reconnectAttempt()       // 当前重连次数
}
```

#### ws 模块定位

WsClient 构造函数接收已解析的 `WebSocket` 类，不由模块自己定位。定位逻辑在主入口 `tunnel-proxy.mjs` 中完成，传入 `WsClient`。

#### 连接 URL

```
{gatewayWsUrl}?accountId={accountId}&runId={runId}
```

#### 协议消息

| 方向 | type | 载荷 | 说明 |
|------|------|------|------|
| → Gateway | `register` | `{ type:'register', accountId, runId }` | 注册 |
| ← Gateway | `registered` | `{ type:'registered', accountId }` | 注册确认 |
| ← Gateway | `ping` | `{ type:'ping' }` | 心跳探测 |
| → Gateway | `pong` | `{ type:'pong' }` | 心跳响应 |
| ← Gateway | `proxy_request` | `{ type:'proxy_request', id, method, path, headers, body }` | API 请求 |
| → Gateway | `proxy_response` | `{ type:'proxy_response', id, status, headers, body }` | API 响应 |
| → Gateway | `proxy_error` | `{ type:'proxy_error', id, error }` | API 错误 |

#### 重连策略

```
参数：
  INITIAL_DELAY     = 1_000       // 初始 1s
  MAX_DELAY         = 30_000      // 上限 30s
  BACKOFF_FACTOR    = 2           // 倍数
  JITTER            = 0.2         // 抖动 ±20%
  MAX_ATTEMPTS      = 50          // 最大重试（~25 分钟耗尽）

算法：
  delay = min(INITIAL_DELAY × BACKOFF_FACTOR^attempt, MAX_DELAY)
  jittered = delay × (1 + random(-JITTER, +JITTER))
  actual = max(jittered, 500)

触发条件：
  - ws 'close' 事件（非主动关闭）
  - ws 'error' 事件
  - pong 超时（距上次 pong 超过 35s）

流程：
  1. 状态 → 'disconnected'
  2. 清理所有 pending requests（reject with 'connection lost'）
  3. setTimeout(actual) 等待
  4. 调用 connect()
  5. 成功 → attempt = 0, 状态 → 'connected'
  6. 失败 → attempt++
     ├─ attempt < MAX_ATTEMPTS → 回到步骤 3
     └─ attempt >= MAX_ATTEMPTS → 状态 → 'exhausted'，不重试
```

#### 心跳

```
主动 ping：
  - 间隔 25s，仅在 connected 状态
  - 发送 { type: 'ping' }

pong 超时检测：
  - 记录 lastPongAt
  - 每次 ping 时检查：Date.now() - lastPongAt > 35000
    → 判定断连 → 触发重连
```

#### pending requests

```js
// Map<string, { resolve, reject, timeout }>
const pending = new Map();

// 生命周期：
//   发送 proxy_request → pending.set(id, { resolve, reject, timeout: 120s })
//   收到 proxy_response → pending.get(id).resolve(msg); pending.delete(id)
//   收到 proxy_error → pending.get(id).reject(err); pending.delete(id)
//   超时 → pending.get(id).reject('timeout'); pending.delete(id)
//   重连 → 遍历 pending 全部 reject('connection lost'); pending.clear()
```

### 4.3 API 代理 `api-handler.mjs`

#### 导出接口

```js
export class ApiHandler {
  constructor({ apiKey, baseUrl })
  async handleRequest(req)    // → { status, headers, body }
}
```

#### 支持的端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | 聊天补全（流式 + 非流式） |
| GET  | `/v1/models` | 模型列表 |

其他路径 → `404 { error: { message: 'Not supported by tunnel proxy', type: 'not_found' } }`

#### 代理流程

```
输入：{ method, path, headers, body }

1. 验证路径
   └─ 不支持 → 返回 { status: 404, headers: {}, body: JSON error }

2. 构造目标
   target = new URL(path, BASE_URL)

3. 构造请求头
   ├─ 保留：content-type, accept（从原始 headers）
   ├─ 注入：authorization: Bearer {API_KEY}
   ├─ 强制：accept-encoding: identity
   └─ 移除：host, content-length

4. 发起 HTTPS 请求
   ├─ 连接超时：10s
   └─ 读取超时：120s

5. 收集响应
   ├─ 流式（content-type 含 text/event-stream）：
   │   逐 chunk 收集 → Buffer.concat → UTF-8 字符串
   └─ 非流式：
       直接收集完整 body

6. 返回 { status, headers, body }

7. 错误处理
   ├─ 网络错误 → { status: 502, body: '{"error":{"message":"...","type":"proxy_error"}}' }
   └─ 超时 → { status: 504, body: '{"error":{"message":"upstream timeout","type":"proxy_error"}}' }
```

### 4.4 健康检查 HTTP 服务

内置于 `tunnel-proxy.mjs`，不单独成模块。

```
监听：127.0.0.1:9201（仅本地，不暴露公网）
方法：仅 GET
路径：仅 /health

响应 200：
{
  "status": "ok" | "degraded",
  "accountId": "__KEYPOOL_ACCOUNT_ID__",
  "runId": "__KEYPOOL_RUN_ID__",
  "tunnel": "connected" | "disconnected" | "exhausted",
  "uptimeMs": 3600000,
  "requestCount": 42,
  "lastRequestAt": "2026-05-09T06:30:00Z",
  "lastError": null,
  "lastErrorAt": null,
  "consecutiveErrors": 0,
  "reconnectAttempt": 0,
  "gateway": "__KEYPOOL_GATEWAY_URL__",
  "mimoApi": "__MIMO_BASE_URL__"
}

status 判定：
  tunnel === 'connected' && consecutiveErrors < 5 → "ok"
  其他 → "degraded"

安全：
  - 不返回 API_KEY
  - 不返回任何敏感配置
  - 仅监听 127.0.0.1，外部无法直接访问
```

### 4.5 SKILL.md

```yaml
---
name: keypool-tunnel
version: 0.3.0
description: >
  KeyPool Tunnel Proxy — WebSocket 反连到 Gateway，
  接收 API 请求并代理到 MiMo API。
  支持 chat completions（流式）、models 列表、健康检查。
---

# KeyPool Tunnel Proxy

沙箱实例侧的 Tunnel Proxy，通过 WebSocket 反连到本地 Gateway 服务器。

## 工作原理

1. 启动后主动连接 Gateway（ws://你的公网IP:9300/tunnel）
2. 注册为可用的 API 代理节点
3. Gateway 转发客户端请求到本 proxy
4. Proxy 调用 MiMo API 并返回结果

## 端点

- `POST /v1/chat/completions` — 聊天补全
- `GET /v1/models` — 模型列表
- `GET localhost:9201/health` — 健康检查（仅本地）

## 依赖

- Node.js ≥ 18
- ws 模块（OpenClaw 自带，无需额外安装）

## 配置

API 配置（Key、Base URL）自动从沙箱 OpenClaw 环境读取，无需手动设置。
Gateway 地址由 deployer 部署时注入。
```

## 五、Deployer 适配

### 改动范围

仅修改 `src/manager/deployer.mjs`。

### 删除

- `generateTunnelProxyCode()` 函数（~200 行模板字符串）

### 新增

```js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..', '..', 'skill');

const SKILL_FILES = [
  'SKILL.md',
  'scripts/tunnel-proxy.mjs',
  'scripts/lib/ws-client.mjs',
  'scripts/lib/api-handler.mjs',
];

/**
 * 读取 skill 文件并替换模板变量
 */
function readSkillFiles(vars) {
  return SKILL_FILES.map(relPath => {
    let content = readFileSync(resolve(SKILL_ROOT, relPath), 'utf-8');
    for (const [key, value] of Object.entries(vars)) {
      content = content.replaceAll(`__${key}__`, value);
    }
    return { path: relPath, content };
  });
}

/**
 * 构建创建 skill 的 prompt
 * 每个文件用独立的 heredoc 分隔符（避免内容截断）
 */
function buildCreateSkillPrompt(files, marker, skillDir, scriptDir) {
  const lines = [
    '请帮我在本机创建一个 OpenClaw skill。',
    '',
    '请严格按顺序执行以下步骤：',
    '',
    '步骤 1：创建目录',
    '```bash',
    `mkdir -p ${scriptDir}/lib`,
    '```',
  ];

  files.forEach((file, i) => {
    const targetPath = `${skillDir}/${file.path}`;
    const delimiter = `KEYPOOL_EOF_${i}_${Date.now().toString(36)}`;
    lines.push(
      '',
      `步骤 ${i + 2}：写入 ${file.path}`,
      '```bash',
      `cat > ${targetPath} << '${delimiter}'`,
      file.content,
      delimiter,
      '```',
    );
  });

  const verifyStep = files.length + 2;
  lines.push(
    '',
    `步骤 ${verifyStep}：验证`,
    '```bash',
    ...files.map(f => `test -f ${skillDir}/${f.path}`),
    `node --check ${scriptDir}/tunnel-proxy.mjs`,
    `echo ${marker}`,
    '```',
    '',
    `成功只回复 ${marker}。失败回复实际错误。`,
  );

  return lines.join('\n');
}
```

### 变量注入表

| 占位符 | 来源 | 说明 |
|--------|------|------|
| `__KEYPOOL_GATEWAY_URL__` | `config.gatewayUrl` / 环境变量 | 必须是用户自己控制的地址 |
| `__KEYPOOL_ACCOUNT_ID__` | `account.id` | 账号标识 |
| `__KEYPOOL_RUN_ID__` | `markers.runId` | 本次部署运行 ID |

**注意**：`MIMO_API_KEY` 和 `MIMO_BASE_URL` **不由 deployer 注入**。Tunnel proxy 启动时从沙箱 OpenClaw 环境读取（`process.env` 或 `openclaw.json`）。

## 六、部署时序

```
Deployer                    沙箱 OpenClaw               Tunnel Proxy
   │                            │                            │
   │  1. 读取 skill/ 文件        │                            │
   │  2. 替换模板变量            │                            │
   │     (仅 Gateway URL 等)    │                            │
   │                            │                            │
   │── 3. WS 连接 ─────────────→│                            │
   │── 4. chat: 创建 skill ────→│                            │
   │                            │── 5. mkdir -p              │
   │                            │── 6. cat 写入各文件         │
   │                            │── 7. node --check 验证     │
   │←── 8. 确认 marker ────────│                            │
   │                            │                            │
   │── 9. chat: 启动 proxy ────→│                            │
   │                            │── 10. pkill 旧进程          │
   │                            │── 11. nohup node tunnel-proxy.mjs &
   │                            │                            │
   │                            │                            │── 12. 定位 ws 模块
   │                            │                            │── 13. 读取 OpenClaw 配置
   │                            │                            │     (获取 API Key + Base URL)
   │                            │                            │── 14. 连接 Gateway WS
   │                            │                            │── 15. register
   │                            │                            │
   │  16. Gateway 收到注册       │                            │
   │  17. 实例 → ACTIVE          │                            │
```

## 七、变更清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `skill/SKILL.md` | **新增** | skill 元数据 |
| `skill/scripts/tunnel-proxy.mjs` | **新增** | 主入口 + 健康检查 |
| `skill/scripts/lib/ws-client.mjs` | **新增** | WS 连接管理 |
| `skill/scripts/lib/api-handler.mjs` | **新增** | API 代理 |
| `src/manager/deployer.mjs` | **修改** | 删除 generateTunnelProxyCode，改为读取 skill/ |
| 其余所有文件 | **不动** | |

## 八、测试要点

| 场景 | 验证 |
|------|------|
| ws 模块定位 | `require.resolve('ws', { paths: ['/usr/lib/node_modules/openclaw'] })` 在沙箱中能找到 |
| 启动 | tunnel-proxy.mjs 读取内嵌配置、连接 Gateway、register 成功 |
| Gateway 不可达 | 重连 50 次后 exhausted，进程仍在（不自动退出，但不再重连） |
| Gateway 重启 | WS 断开 → 自动重连 → 重新 register |
| API 代理 | POST /v1/chat/completions 正确转发，SSE 流式响应完整 |
| Models | GET /v1/models 正确透传 |
| 健康检查 | GET localhost:9201/health 返回正确状态 |
| 安全 | /health 不返回 API_KEY；console 不打印 API_KEY |
| 模板替换 | deployer 读取文件后占位符全部替换 |
| heredoc 安全 | 文件内容含特殊字符时不截断 |

## 九、待确认事项

| # | 问题 | 影响 |
|---|------|------|
| 1 | 沙箱实例中 ws 模块路径是否固定为 `/usr/lib/node_modules/openclaw/node_modules/ws`？不同版本 OpenClaw 是否会变？ | ws 定位策略的可靠性 |
| 2 | `openclaw.json` 中 `models.providers.xiaomi.apiKey` 是否始终存在？沙箱是否可能用其他 provider？ | 配置读取的健壮性 |

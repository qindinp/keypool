# 🔑 KeyPool

**OpenAI API Key Pool Proxy** — 把多个 API Key 聚合成一个端点，自动轮转、故障转移、用量追踪。

专为小米 AI Studio 限时实例设计 — **自动续期 + 自动部署**。

## 架构

```
┌─────────────────────────────────┐
│  外部持久服务器 (manager.mjs)     │  ← Part 2: 监控、续期、部署
│  自动创建新实例 + 下发部署指令     │
└──────────────┬──────────────────┘
               │ WebSocket
               ▼
┌─────────────────────────────────┐
│  AI Studio 限时实例 (server.mjs) │  ← Part 1: KeyPool 代理
│  每小时轮换，自动部署             │
│  MIMO_API_KEY → OpenAI 兼容 API  │
└─────────────────────────────────┘
```

> 📖 详细部署指南: [DEPLOY.md](./DEPLOY.md)

## 快速开始

### Part 1: 实例内 (自动部署，无需手动)

```bash
# 由 Part 2 自动部署，或手动:
npm start                # node bin/server.mjs
# KeyPool 运行在 http://127.0.0.1:9200
```

### Part 2: 外部持久服务器

```bash
# 1. 克隆
git clone https://github.com/qindinp/keypool.git
cd keypool

# 2. 设置 Cookie (从浏览器 F12 获取)
echo "serviceToken=xxx; userId=xxx" > .cookie

# 3. 启动管理器
npm run manager          # node bin/manager.mjs

# 它会自动: 监控实例 → 到期前创建新实例 → 部署 KeyPool → 获取新 Key
```

### 一键启动 (Manager + Relay)

```bash
npm run app              # node bin/app.mjs
# 管理界面: http://127.0.0.1:9300/admin
```

### 使用 KeyPool

```bash
export OPENAI_BASE_URL=http://127.0.0.1:9200/v1
```

> **智能配置检测**：KeyPool 启动时会自动查找 `~/.openclaw/openclaw.json`，
> 从中提取所有 provider 的 API Key 和模型信息，无需手动配置。
> 如果需要手动指定 key，编辑 `config.json` 即可覆盖。

## 工作原理

```
你的应用 / OpenClaw
       │
       ▼  OpenAI 兼容 API
┌──────────────┐
│   KeyPool    │  ← 自动选 key、故障转移、流式透传
│   Proxy      │
└──────┬───────┘
       │
  ┌────┼────┬────┐
  ▼    ▼    ▼    ▼
Key1 Key2 Key3 KeyN
```

### 核心特性

- **零依赖** — 纯 Node.js，无需 npm install
- **OpenAI 兼容** — 无缝替换，你的应用无需改动
- **Anthropic 兼容** — 自动转换 Anthropic ↔ OpenAI 格式（含 tool_use）
- **自动配置检测** — 启动时自动读取 `~/.openclaw/openclaw.json`，提取所有 provider 的 key 和模型
- **智能轮转** — Round-robin 分发请求到不同 key
- **故障转移** — 429/401/403 自动切换到下一个可用 key（有限重试，不会无限递归）
- **自动恢复** — 被禁用的 key 定期重试恢复
- **流式支持** — 完整 SSE streaming 透传
- **用量追踪** — 每个 key 的请求数、token 用量统计
- **多 provider 支持** — 不同 key 可指向不同的上游 API（如 OpenAI + MiMo）
- **请求保护** — 10MB body 限制 + 120s 超时，防 OOM 和挂起

### 支持的端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | Chat Completions API |
| `/v1/models` | GET | 列出可用模型（优先返回本地配置） |
| `/v1/embeddings` | POST | Embeddings API |
| `/v1/messages` | POST | Anthropic Messages API（自动转换） |
| `/pool/stats` | GET | 查看各 key 用量统计 |
| `/pool/models` | GET | 查看所有已知模型详情 |
| `/health` | GET | 健康检查 |

## 配置

```json
{
  "port": 9200,
  "baseUrl": "https://api.openai.com",
  "logLevel": "info",
  "healthCheckIntervalMs": 300000,
  "keyRetryDelayMs": 60000,
  "maxRetries": 3,
  "keys": [
    { "id": "alice",  "key": "sk-..." },
    { "id": "bob",    "key": "sk-..." },
    { "id": "charlie","key": "sk-..." }
  ]
}
```

> **兼容任意 OpenAI API 兼容服务**，只需修改 `baseUrl`。
> 例如小米 MiMo：`"baseUrl": "https://api-oc.xiaomimimo.com/v1"`

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | 9200 | 代理监听端口 |
| `baseUrl` | `https://api.openai.com` | 上游 API 地址（支持任意 OpenAI 兼容服务） |
| `logLevel` | `info` | 日志级别: debug / info / warn / error |
| `healthCheckIntervalMs` | 300000 | 自动恢复检查间隔（毫秒） |
| `keyRetryDelayMs` | 60000 | key 禁用后重试延迟（毫秒） |
| `maxRetries` | 3 | 单请求最大重试次数（防无限递归） |

## 使用示例

### 配合 OpenClaw

在 OpenClaw 配置中设置模型 provider 指向 KeyPool：

```json
{
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://127.0.0.1:9200/v1"
      }
    }
  }
}
```

### 配合 Python (openai 库)

```python
from openai import OpenAI

# OpenAI
client = OpenAI(base_url="http://127.0.0.1:9200/v1")
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)

# 小米 MiMo
client = OpenAI(base_url="http://127.0.0.1:9200/v1")
resp = client.chat.completions.create(
    model="mimo-v2.5-pro",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(resp.choices[0].message.content)
```

### 配合 curl

```bash
curl http://127.0.0.1:9200/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hi"}]
  }'
```

## 查看用量

```bash
# 各 key 使用情况
curl http://127.0.0.1:9200/pool/stats

# 健康状态
curl http://127.0.0.1:9200/health
```

## 项目结构

```
keypool/
├── bin/                        # 入口点（thin wrappers）
│   ├── server.mjs              #   → server/index.mjs (KeyPool 代理)
│   ├── manager.mjs             #   → src/manager/index.mjs (多账号管理)
│   ├── relay.mjs               #   → src/relay/server.mjs (中继服务)
│   ├── app.mjs                 #   Manager + Relay 联合启动器
│   ├── key-exchange.mjs        #   Key 交换服务器
│   └── ws-client.mjs           #   MiMo WebSocket 客户端
├── src/                        # 核心业务模块（重构后）
│   ├── shared/                 #   公共工具
│   │   ├── http.mjs            #     HTTP 请求 & 健康检查
│   │   ├── ws.mjs              #     WebSocket 帧解析
│   │   ├── cookie.mjs          #     Cookie 管理
│   │   ├── logger.mjs          #     日志工具
│   │   ├── state-store.mjs     #     状态持久化
│   │   └── utils.mjs           #     通用工具函数
│   ├── manager/                #   管理器模块
│   │   ├── index.mjs           #     主入口 & 调度循环
│   │   ├── account-worker.mjs  #     单账号生命周期管理
│   │   ├── accounts.mjs        #     多账号配置加载
│   │   ├── deploy-client.mjs   #     WebSocket 部署客户端
│   │   ├── registry.mjs        #     实例注册表
│   │   ├── mimo-api.mjs        #     MiMo API 调用
│   │   └── config.mjs          #     管理器配置
│   └── relay/                  #   中继层
│       ├── server.mjs          #     HTTP 服务器 & 路由分发
│       ├── admin-api.mjs       #     Admin 管理 API
│       ├── control-api.mjs     #     Control 控制 API
│       ├── proxy.mjs           #     上游代理转发
│       ├── router.mjs          #     路由选择策略
│       └── utils.mjs           #     中继工具函数
├── server/                     # KeyPool 代理模块
│   ├── index.mjs               #   主入口 & 路由
│   ├── config.mjs              #   配置加载 & OpenClaw 检测
│   ├── key-pool.mjs            #   KeyPool 类（轮转、健康、恢复）
│   ├── proxy.mjs               #   HTTP 代理（有限重试 + 超时 + body 限制）
│   ├── anthropic-adapter.mjs   #   Anthropic ↔ OpenAI 转换（含 tool_use）
│   └── tunnel/                 #   隧道管理
│       ├── index.mjs           #     隧道入口 & 类型选择
│       ├── ssh.mjs             #     SSH 隧道 (localhost.run)
│       └── tailscale.mjs       #     Tailscale Funnel
├── scripts/                    # 工具脚本
│   ├── app-bg.mjs              #   后台运行管理
│   ├── test-relay.mjs          #   Relay 测试
│   └── ws-probe.mjs            #   WebSocket 探测
├── app.mjs                     # 向后兼容 → bin/app.mjs
├── manager.mjs                 # 向后兼容 → src/manager/index.mjs
├── server.mjs                  # 向后兼容 → server/index.mjs
├── key-exchange.mjs            # 独立 Key 交换服务
├── ws-client.mjs               # 独立 WebSocket 客户端
├── config.example.json         # 配置示例
└── accounts.example.json       # 多账号配置示例
```

## 迁移指南

从 v0.3.x 升级到 v0.4.0？参见 [MIGRATION.md](./MIGRATION.md)。

## License

MIT

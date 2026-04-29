# 🔑 KeyPool

**OpenAI API Key Pool Proxy** — 把多个 API Key 聚合成一个端点，自动轮转、故障转移、用量追踪。

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/YOUR_USER/keypool.git
cd keypool

# 2. 配置 API Keys
cp config.example.json config.json
# 编辑 config.json，填入你的 API Keys

# 3. 启动
node server.mjs

# 4. 使用
# 将你的应用的 OpenAI base URL 指向 KeyPool：
export OPENAI_BASE_URL=http://127.0.0.1:9200/v1
```

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
- **智能轮转** — Round-robin 分发请求到不同 key
- **故障转移** — 429/401/403 自动切换到下一个可用 key
- **自动恢复** — 被禁用的 key 定期重试恢复
- **流式支持** — 完整 SSE streaming 透传
- **用量追踪** — 每个 key 的请求数、token 用量统计

### 支持的端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | Chat Completions API |
| `/v1/models` | GET | 列出可用模型 |
| `/v1/embeddings` | POST | Embeddings API |
| `/pool/stats` | GET | 查看各 key 用量统计 |
| `/health` | GET | 健康检查 |

## 配置

```json
{
  "port": 9200,
  "baseUrl": "https://api.openai.com",
  "logLevel": "info",
  "healthCheckIntervalMs": 300000,
  "keyRetryDelayMs": 60000,
  "keys": [
    { "id": "alice",  "key": "sk-..." },
    { "id": "bob",    "key": "sk-..." },
    { "id": "charlie","key": "sk-..." }
  ]
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | 9200 | 代理监听端口 |
| `baseUrl` | `https://api.openai.com` | 上游 API 地址（支持任意 OpenAI 兼容服务） |
| `logLevel` | `info` | 日志级别: debug / info / warn / error |
| `healthCheckIntervalMs` | 300000 | 自动恢复检查间隔（毫秒） |
| `keyRetryDelayMs` | 60000 | key 禁用后重试延迟（毫秒） |

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

client = OpenAI(base_url="http://127.0.0.1:9200/v1")
resp = client.chat.completions.create(
    model="gpt-4o",
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

## 架构

```
请求 → 路由 → 选择 Key → 代理到 OpenAI → 流式/非流式响应
                  │                              │
                  ▼                              ▼
            Round-robin                    记录用量
            + 健康感知                    + 错误计数
```

- **Key 选择**: Round-robin，仅选 enabled 的 key
- **错误处理**: 429/401/403 → 自动禁用 key 并尝试下一个
- **恢复机制**: 每 5 分钟检查被禁用的 key，超过 1 分钟后重试
- **流式代理**: SSE 逐 chunk 透传，从最后一个 chunk 提取 usage

## License

MIT

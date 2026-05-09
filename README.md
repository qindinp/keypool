# 🔑 KeyPool

**多小米账号 AI Studio 实例编排器 + 统一 API 网关**

N 个小米账号 → N 个限时实例 → 1 个本地端点。

## 架构

```
你的应用 (OpenClaw / Python / curl)
        │
        ▼  http://127.0.0.1:9300/v1/chat/completions
  ┌─────────────────┐
  │  Gateway :9300  │  HTTP 服务 + Anthropic↔OpenAI 转换
  │  (src/gateway/) │
  └────────┬────────┘
           │  HTTP 转发
           ▼
  ┌─────────────────┐
  │  Manager        │  多账号编排 + 实例生命周期
  │  (src/manager/) │
  └────────┬────────┘
           │  DeployClient (小米平台 WS + AI 对话)
           ▼
  ┌──────────────────────────────┐
  │  AI Studio 沙箱实例 (~1h)    │
  │  skill-proxy/server.mjs      │
  │  localhost:9200 → MiMo API   │
  └──────────────────────────────┘
```

## 快速开始

```bash
# 1. 配置账号
cp accounts.example.json accounts.json
# 编辑 accounts.json，填入小米账号 cookie

# 2. 启动
npm start
```

## 目录结构

```
keypool/
├── bin/
│   └── app.mjs              # 启动入口
├── src/
│   ├── gateway/             # 统一 API 网关
│   │   ├── index.mjs        #   HTTP 服务器
│   │   ├── proxy.mjs        #   请求代理（HTTP 转发到 skill-proxy）
│   │   ├── adapter.mjs      #   Anthropic ↔ OpenAI 格式转换
│   │   ├── router.mjs       #   路由策略
│   │   ├── registry.mjs     #   实例注册表
│   │   └── admin.mjs        #   Admin API + Web UI
│   ├── manager/             # 多账号编排
│   │   ├── index.mjs        #   主入口
│   │   ├── scheduler.mjs    #   调度器
│   │   ├── account-worker.mjs # 单账号状态机
│   │   ├── accounts.mjs     #   账号配置加载
│   │   ├── instance.mjs     #   MiMo API (create/destroy/status)
│   │   ├── deployer.mjs     #   部署流程（通过 AI 对话部署 skill-proxy）
│   │   ├── deploy-client.mjs #  WS 客户端（连小米平台）
│   │   └── config.mjs       #   配置
│   └── shared/              # 公共工具
│       ├── ws.mjs           #   WebSocket 文本提取
│       └── cookie.mjs       #   Cookie 与 MiMo 常量
├── skill-proxy/             # 远端实例内运行的代理
│   ├── server.mjs           #   主代理（读 .env）
│   └── proxy-standalone.mjs #   独立代理（环境变量）
├── accounts.example.json    # 账号配置模板
├── package.json
└── README.md
```

## 实例状态机

```
NONE → CREATING → READY → DEPLOYING → DEPLOYED_UNVERIFIED → ACTIVE
                                                  │
ACTIVE → CREATING (续期，零停机)                    │ 部署失败
                                                  ▼
                                                FAILED → CREATING (冷却重试)
```

| 状态 | 含义 | Gateway 行为 |
|------|------|-------------|
| NONE | 无实例 | 不路由 |
| CREATING | 实例创建中 | 不路由 |
| READY | 实例可用，未部署 | 不路由 |
| DEPLOYING | 正在部署 skill-proxy | 不路由 |
| DEPLOYED_UNVERIFIED | 部署完成，未验证 | 不路由 |
| ACTIVE | 已验证，正常服务 | ✅ 路由请求 |
| FAILED | 出错 | 不路由 |
| RECOVERING | 恢复中 | 暂停路由 |

## API

### OpenAI 兼容

```bash
curl http://127.0.0.1:9300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-pro","messages":[{"role":"user","content":"hello"}]}'
```

### Anthropic 兼容

```bash
curl http://127.0.0.1:9300/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-pro","messages":[{"role":"user","content":"hello"}]}'
```

### Admin

- Web UI: http://localhost:9300/admin
- API: http://localhost:9300/admin/api/overview
- Health: http://localhost:9300/health

## 配置

### accounts.json

```json
{
  "accounts": [
    {
      "id": "mimo-a",
      "name": "主力账号",
      "cookie": "serviceToken=xxx; userId=yyy",
      "priority": 10,
      "enabled": true
    }
  ]
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 9300 | Gateway 端口 |
| HOST | 0.0.0.0 | 监听地址 |
| ACCOUNTS_PATH | accounts.json | 账号配置路径 |
| CHECK_INTERVAL | 60 | 调度间隔 (秒) |
| RENEW_BEFORE | 300 | 续期阈值 (秒) |
| MIMO_API_URL | https://api-oc.xiaomimimo.com/v1 | MiMo API 地址 |

## License

MIT

# 🔑 KeyPool

**多小米账号 AI Studio 实例编排器 + 统一 API 网关**

N 个小米账号 → N 个限时实例 → 1 个本地端点。

## 架构

```
你的应用 (OpenClaw / Python / curl)
        │
        ▼  http://127.0.0.1:9300/v1/chat/completions
  ┌─────────────────────┐
  │  Gateway :9300      │  HTTP + WS (/tunnel)
  │  Anthropic↔OpenAI   │  请求路由 + 格式转换
  └────────┬────────────┘
           │  WS 双向通道（远端主动反连）
           ▼
  ┌──────────────────────────────────────┐
  │  AI Studio 沙箱实例 (~1h)            │
  │  Tunnel Proxy (WS client)            │
  │  主动 ws://你的IP:9300/tunnel 连回    │
  │  收到请求 → MiMo API → 结果回传      │
  └──────────────────────────────────────┘
```

**关键设计**：远端实例主动连接本地 Gateway（WS 反连），无需隧道工具，无需公网暴露远端端口。

## 快速开始

```bash
# 1. 配置账号
cp accounts.example.json accounts.json
# 编辑 accounts.json，填入小米账号 cookie

# 2. 开放端口（阿里云安全组需额外放行 9300）
sudo ufw allow 9300/tcp 2>/dev/null

# 3. 启动
npm start
```

## 目录结构

```
keypool/
├── bin/
│   └── app.mjs                  # 启动入口
├── src/
│   ├── gateway/                 # 统一 API 网关
│   │   ├── index.mjs            #   HTTP 服务器 + WS upgrade
│   │   ├── tunnel.mjs           #   Tunnel WS server（接收远端反连）
│   │   ├── proxy.mjs            #   请求代理（tunnel 优先，HTTP 回退）
│   │   ├── adapter.mjs          #   Anthropic ↔ OpenAI 格式转换
│   │   ├── router.mjs           #   路由策略
│   │   ├── registry.mjs         #   实例注册表
│   │   └── admin.mjs            #   Admin API + Web UI
│   ├── manager/                 # 多账号编排
│   │   ├── index.mjs            #   主入口
│   │   ├── scheduler.mjs        #   调度器（状态机驱动）
│   │   ├── account-worker.mjs   #   单账号生命周期
│   │   ├── accounts.mjs         #   账号配置加载
│   │   ├── instance.mjs         #   MiMo API (create/destroy/status)
│   │   ├── deployer.mjs         #   部署 Tunnel Proxy 到沙箱
│   │   ├── deploy-client.mjs    #   WS 客户端（连小米平台）
│   │   └── config.mjs           #   配置
│   └── shared/                  # 公共工具
│       ├── ws.mjs               #   WebSocket 文本提取
│       └── cookie.mjs           #   Cookie 与 MiMo 常量
├── skill-proxy/                 # 旧版 HTTP proxy（保留参考）
│   ├── server.mjs
│   └── proxy-standalone.mjs
├── accounts.example.json
├── package.json
└── README.md
```

## 请求流程

```
1. 客户端 → POST http://你的IP:9300/v1/chat/completions
2. Gateway 解析 model，选择最优 upstream
3. 检查 upstream 是否有 tunnel 连接
   ├─ 有 → 通过 WS tunnel 推送请求到远端 proxy
   │       远端 proxy 调 MiMo API → 结果通过 WS 回传
   └─ 无 → 回退 HTTP 直连（proxyUrl/baseUrl）
4. Gateway 将响应返回客户端（支持流式 SSE）
```

## 实例状态机

```
NONE → CREATING → READY → DEPLOYING → DEPLOYED_UNVERIFIED ─┐
                                                │            │
                                    tunnel 连接到达          │
                                                ▼            │
                                             ACTIVE          │
                                                │            │
                                    tunnel 断开 / 超时       │
                                                ▼            │
                                             RECOVERING ◄────┘
                                                │
                                    恢复失败 → FAILED → CREATING (冷却重试)
```

| 状态 | 含义 | Gateway 行为 |
|------|------|-------------|
| NONE | 无实例 | 不路由 |
| CREATING | 实例创建中 | 不路由 |
| READY | 实例可用，未部署 | 不路由 |
| DEPLOYING | 正在部署 Tunnel Proxy | 不路由 |
| DEPLOYED_UNVERIFIED | Proxy 已部署，等待 tunnel 连接 | 不路由 |
| ACTIVE | Tunnel 已连接，正常服务 | ✅ 路由请求 |
| FAILED | 出错 | 不路由 |
| RECOVERING | 恢复中 | 暂停路由 |

## 部署流程

```
Deployer                    沙箱 OpenClaw               Tunnel Proxy
   │                            │                            │
   │── WS 连接 ────────────────→│                            │
   │── chat: 创建 skill ───────→│                            │
   │                            │── 写入 tunnel-proxy.mjs    │
   │── chat: 启动 proxy ───────→│                            │
   │                            │── node tunnel-proxy.mjs ──→│
   │                            │                            │── ws://IP:9300/tunnel
   │                            │                            │──→ Gateway
   │                            │                            │
   │  Gateway 收到 tunnel 注册   │                            │
   │  实例状态 → ACTIVE          │                            │
```

## API

### OpenAI 兼容

```bash
curl http://你的IP:9300/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-pro","messages":[{"role":"user","content":"hello"}]}'
```

### Anthropic 兼容

```bash
curl http://你的IP:9300/v1/messages \
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
| KEYPOOL_GATEWAY_URL | ws://127.0.0.1:9300/tunnel | Tunnel 连接地址（公网需改为实际 IP） |

### 网络要求

- **Gateway 服务器**：9300 端口需对公网开放（远端沙箱要连上来）
- **阿里云 ECS**：需在安全组入方向放行 TCP 9300
- **远端沙箱**：需能访问公网（连小米 API + 连你的 Gateway）

## License

MIT

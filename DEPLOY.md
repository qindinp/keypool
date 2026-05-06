# KeyPool 部署指南 — 两部分架构

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│              外部持久服务器 (Part 2)                       │
│              bin/manager.mjs — 永远在线                   │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐ │
│  │ 监控状态  │→ │ 创建实例   │→ │ WS 部署   │→ │ Key 推送│ │
│  └──────────┘  └───────────┘  └──────────┘  └────────┘ │
└──────────────────────────┬──────────────────────────────┘
                           │ WebSocket (出站)
                           ▼
┌─────────────────────────────────────────────────────────┐
│           AI Studio 限时实例 (Part 1)                     │
│           server/index.mjs — 每小时轮换                    │
│                                                          │
│  ┌───────────┐  ┌─────────────┐  ┌──────────────────┐  │
│  │ KeyPool   │  │ MIMO_API_KEY│  │ Key Exchange     │  │
│  │ :9200 代理 │← │ (环境变量)   │  │ :9201 (可选)      │  │
│  └─────┬─────┘  └─────────────┘  └──────────────────┘  │
└────────┼────────────────────────────────────────────────┘
         │
    ┌────┼────┬────┐
    ▼    ▼    ▼    ▼
  消费者 (OpenClaw / Python / curl / ...)
```

## Part 1: AI Studio 实例内 (server.mjs)

### 做什么

- 把 `MIMO_API_KEY` 通过 OpenAI 兼容 API 对外暴露
- 自动轮转 key、故障转移、流式透传
- 可选: Key Exchange 服务接收外部推送的 key

### 部署方式

由 Part 2 通过 WebSocket 自动下发，无需手动操作。

Part 2 发送的部署指令：
```bash
cd /root/.openclaw/workspace
rm -rf keypool
git clone https://github.com/qindinp/keypool.git
cp keypool/SOUL.md SOUL.md
cd keypool
nohup node bin/server.mjs > /tmp/keypool.log 2>&1 &
```

### 验证

```bash
# 在实例内
curl http://127.0.0.1:9200/health
curl http://127.0.0.1:9200/pool/stats
```

## Part 2: 外部持久服务器 (Manager)

### 做什么

- 每 60s 检查实例状态
- 到期前 5 分钟自动创建新实例
- 等待新实例就绪
- 通过 WebSocket 连接新实例，下发部署指令
- 验证部署成功
- 获取新 API Key
- 推送 Key 给消费者 (可选)

### 环境要求

- Node.js 18+
- 小米 AI Studio Cookie
- 网络能访问 aistudio.xiaomimimo.com

### 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/qindinp/keypool.git
cd keypool

# 2. 设置 Cookie
echo "serviceToken=xxx; userId=xxx; xiaomichatbot_ph=xxx" > .cookie

# 3. 验证 Cookie
npm run manager:status           # node bin/manager.mjs --status

# 4. 单次测试
npm run manager:once             # node bin/manager.mjs --once

# 5. 持续运行
npm run manager                  # node bin/manager.mjs

# 或用 systemd
bash controller-setup.sh
systemctl start keypool-controller
```

### 命令

```bash
npm run manager                  # 持续运行
npm run manager:once             # 单次检查后退出
npm run manager:status           # 查看当前状态
npm run manager:deploy           # 强制重新部署
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MIMO_COOKIE` | 从 `.cookie` 读取 | 小米登录 Cookie |
| `CHECK_INTERVAL` | 60 | 检查间隔 (秒) |
| `RENEW_BEFORE` | 300 | 到期前多少秒续期 |
| `DEPLOY_REPO` | keypool github | 部署仓库地址 |
| `KEY_EXCHANGE_URL` | 无 | Key 推送地址 |
| `MAX_RETRIES` | 5 | 重试次数 |

## Cookie 获取方法

1. 打开 https://aistudio.xiaomimimo.com
2. 用小米账号登录
3. F12 → Application → Cookies
4. 复制 `serviceToken` 和 `userId` 的值
5. 拼接: `serviceToken=xxx; userId=xxx`

## Key 消费方式

### 方式 1: 直接访问实例 (如果网络可达)

```bash
export OPENAI_BASE_URL=http://<实例IP>:9200/v1
```

### 方式 2: 通过 SSH 隧道

KeyPool 启动时自动建立 SSH 隧道 (localhost.run)，输出公网 URL。

### 方式 3: Key Exchange (推荐)

Part 2 创建新实例后，自动把新 Key 推送到 Key Exchange 服务。

```bash
# 外部服务器上运行 Key Exchange
node key-exchange.mjs

# 配置 Part 2 推送
KEY_EXCHANGE_URL=http://your-server:9201/key node controller.mjs
```

消费者从 Key Exchange 获取最新 Key:
```bash
curl http://your-server:9201/key
```

## 故障排除

### Cookie 过期

```
❌ Cookie 无效: ...
```
→ 重新登录 AI Studio，更新 `.cookie` 文件

### 实例创建失败

```
❌ 创建实例失败: ...
```
→ 可能触发了频率限制，等几分钟重试

### WebSocket 连接失败

```
🔄 WS连接 失败 (1/5): ...
```
→ 自动重试中。如果持续失败，检查网络或 Cookie

### 部署后 KeyPool 未启动

```
❌ KeyPool 启动后健康检查失败
```
→ 手动连接实例排查:
```bash
node ws-client.mjs "cat /tmp/keypool.log"
```

## 文件说明

| 文件 | 位置 | 说明 |
|------|------|------|
| `bin/server.mjs` | Part 1 实例内 | KeyPool 代理入口 |
| `bin/manager.mjs` | Part 2 外部 | 自动续期管理器入口 |
| `bin/app.mjs` | Part 2 外部 | Manager + Relay 联合启动 |
| `bin/relay.mjs` | Part 2 外部 | Relay 中继服务入口 |
| `bin/ws-client.mjs` | 任意 | WebSocket 调试客户端 |
| `controller-setup.sh` | Part 2 外部 | systemd 安装脚本 |
| `.cookie` | Part 2 外部 | 登录凭证 |
| `.controller-state.json` | Part 2 外部 | 运行状态 |
| `.controller.log` | Part 2 外部 | 运行日志 |

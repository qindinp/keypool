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

环境变量：
- `KEYPOOL_GATEWAY_URL` — Gateway WebSocket 地址
- `KEYPOOL_ACCOUNT_ID` — 账号 ID
- `KEYPOOL_RUN_ID` — 运行实例 ID

## 部署

通过 KeyPool Deployer 自动部署，或手动：

```bash
git clone https://gitee.com/qindinp/keypool-tunnel.git /root/.openclaw/skills/keypool-tunnel
cd /root/.openclaw/skills/keypool-tunnel
KEYPOOL_GATEWAY_URL="ws://your-ip:9300/tunnel" \
KEYPOOL_ACCOUNT_ID="your-account" \
KEYPOOL_RUN_ID="your-run-id" \
node scripts/tunnel-proxy.mjs
```

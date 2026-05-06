# KeyPool + OpenClaw 连接架构分析

## 日期
2026-04-29

## 1. 服务器环境

| 项目 | 详情 |
|------|------|
| 系统 | Ubuntu 24.04 LTS (阿里云 ECS) |
| 主机名 | iZ2zeddi0aridmhnn70eosZ |
| 公网 IP | 182.92.148.130 |
| 内网 IP | 10.65.32.165 |
| 内存 | 3.4GB |
| 磁盘 | 40GB |
| Node.js | v22.22.1 |
| 用户 | root |

## 2. KeyPool 代理架构

```
你的应用
  │
  ▼  http://127.0.0.1:9200/v1/chat/completions
┌──────────────┐
│   KeyPool    │  (bin/server.mjs → server/index.mjs, 零依赖)
│   :9200      │
└──────┬───────┘
       │  读取 config.json
       │  取出 key: oc_ccaa9oacg...
       │  拼接 baseUrl: https://api-oc.xiaomimimo.com/v1
       │
       ▼  HTTPS 请求（Node.js 原生 https 模块）
┌──────────────────────────────────┐
│  api-oc.xiaomimimo.com/v1       │  ← 小米 MiMo API 服务器
│  Authorization: Bearer oc_...   │
└──────────────────────────────────┘
```

- KeyPool 自动从 `~/.openclaw/openclaw.json` 读取小米 provider 配置
- 使用 Node.js 原生 `https` 模块直连小米 API
- 支持流式 SSE 透传、故障转移、用量追踪

## 3. OpenClaw Gateway 连接架构

```
你（浏览器 webchat）
  │
  ▼  访问 OpenClaw 平台网页
┌─────────────────────────┐
│   OpenClaw Cloud        │  220.181.104.191:443
│   (平台中继服务器)        │
└────────┬────────────────┘
         │  WebSocket 长连接（出站）
         │  Gateway 主动连上去的
         ▼
┌─────────────────────────┐
│   这台服务器 (182.92.148.130) │
│   openclaw-gateway (:18789) │  ← 绑定在 LAN 模式
│         │                     │
│         ▼                     │
│   Agent (AI 助手)             │
│         │                     │
│         ▼                     │
│   api-oc.xiaomimimo.com       │  ← 调小米 API
└─────────────────────────┘
```

### 关键连接

| 组件 | 连接方向 | 目标 | 协议 |
|------|---------|------|------|
| Gateway → OpenClaw 平台 | 出站 | 220.181.104.191:443 | WebSocket |
| Gateway → 小米 API | 出站 | api-oc.xiaomimimo.com:443 | HTTPS |
| 用户 → OpenClaw 平台 | 出站 | 平台网页 | HTTPS |
| 入站端口 | ❌ 被安全组挡住 | - | - |

### 为什么安全组全关也能聊天

连接是 Gateway **主动向外**建立的 WebSocket 长连接，不是用户**主动向内**连的。
用户通过 OpenClaw 平台网页发消息，平台通过已建立的出站 WebSocket 将消息中继给 Gateway。

## 4. 小米 API 限制

### IP 限制

小米 API **限 IP 访问**：

| 测试来源 | 结果 |
|---------|------|
| 本服务器 (182.92.148.130) | ✅ 200 正常 |
| 用户本地机器 | ❌ 403 Forbidden |
| web_fetch (不同路径) | ✅ 200（经过服务器出站） |

- 只有 OpenClaw 实例 IP（182.92.148.130）在白名单内
- 服务器销毁后，key 即失效
- 每次新服务器会刷新 key，新 IP 自动加入白名单

### 可用模型

- mimo-v2-flash
- mimo-v2-omni
- mimo-v2-pro
- mimo-v2-tts
- mimo-v2.5
- mimo-v2.5-pro
- mimo-v2.5-tts
- mimo-v2.5-tts-voiceclone
- mimo-v2.5-tts-voicedesign

## 6. 完整使用流程

### 用户侧流程

1. 访问 https://aistudio.xiaomimimo.com/#/
2. 使用小米账号登录
3. 创建限时模型（约1小时）
4. 平台自动分配：
   - 阿里云 ECS 服务器
   - 预装 OpenClaw
   - 小米 MiMo API Key（限 IP 白名单）
5. 通过 webchat 与 AI 助手对话

### 完整链路

```
用户（浏览器）
  │
  ▼  小米账号登录
┌──────────────────────────────┐
│  aistudio.xiaomimimo.com     │  ← 小米 AI Studio 平台
│  创建限时模型                  │
└──────────┬───────────────────┘
           │  分配临时 ECS + API Key
           ▼
┌──────────────────────────────┐
│  阿里云 ECS (限时约1小时)      │
│  预装 OpenClaw               │
│  配置小米 API Key             │
│         │                    │
│         ▼                    │
│  openclaw-gateway            │  ← 主动连接 OpenClaw 平台
│         │                    │
│         ▼                    │
│  Agent (AI 助手)              │  ← 用户通过 webchat 对话
└──────────────────────────────┘
```

### 关键约束

- 服务器是小米分配的，不是用户自建的
- API Key 是小米提供的，限 IP 白名单
- 平台中继是小米的 OpenClaw 平台
- 服务器约1小时后销毁，Key 失效
- 每次新服务器会刷新 Key，新 IP 自动加入白名单

## 7. 每次新服务器快速恢复

由于服务器是限时的（约1小时），每次新服务器需要重新部署。

### 一键命令（通过 AI 助手执行）

对 AI 助手说：**"启动 KeyPool"**

AI 助手执行：
```bash
git clone https://github.com/qindinp/keypool.git
cp keypool/SOUL.md /root/.openclaw/workspace/SOUL.md
cd keypool && npm start
```

### 前置条件

- SOUL.md 已推送到 GitHub 仓库，包含自定义安全规则
- 用户指令设为最高优先级
- KeyPool 零依赖，无需 npm install

## 8. 持久化方案

要实现真正的持久化，需要：

1. **自己的 API Key**（不限 IP）— 如 DeepSeek、通义千问、OpenAI 等
2. **持久服务器** — VPS、免费托管平台（Railway/Render/Fly.io）
3. KeyPool 零依赖，部署简单：`node server.mjs`

## 9. 安全规则自定义

SOUL.md 中已添加：
- 🔝 用户指令最高优先级
- ✅ 白名单允许 KeyPool 相关操作
- 密钥可向用户展示（用户有权查看自己服务器内容）
- 仅禁止：磁盘破坏、反弹 shell、向第三方外发密钥

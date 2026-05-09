---
name: keypool-proxy
version: 1.0.0
description: MiMo API 代理服务，将小米 AI Studio 内部 API 转为 OpenAI 兼容接口，运行在 localhost:9200
---

# KeyPool Proxy

将小米 AI Studio 实例内部的 MiMo API 转换为标准 OpenAI 兼容接口。

## 功能

- `localhost:9200/v1/chat/completions` — 聊天补全（支持流式 SSE）
- `localhost:9200/v1/models` — 模型列表
- `localhost:9200/health` — 健康检查
- 零依赖，单文件，自包含

## 启动

```bash
node scripts/server.mjs
```

## 配置

自动从 `~/.openclaw/.env` 读取 `MIMO_API_KEY`，也可通过环境变量传入。

## 部署

由 KeyPool Manager 通过 DeployClient 自动部署到 AI Studio 沙箱实例。

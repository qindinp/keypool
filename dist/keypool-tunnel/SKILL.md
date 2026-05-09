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

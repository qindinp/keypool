# KeyPool Tunnel Protocol

> 远端沙箱实例与本地 Gateway 之间的 WebSocket 双向协议

## 概述

远端沙箱实例运行 `keypool-tunnel`，通过 WebSocket 主动反连本地 Gateway（`ws://公网IP:9300/tunnel`）。
Gateway 通过同一条 WS 推送 API 请求，远端执行后返回结果。

## 连接参数

```
ws://<gateway-host>:9300/tunnel?accountId=<id>&runId=<runId>
```

| 参数 | 说明 |
|------|------|
| `accountId` | 账号标识（必须） |
| `runId` | 本次部署运行标识（用于 superseded 检测） |
| `bootstrap=1` | Bootstrap 模式：仅推送 skill 文件后关闭连接 |

## 消息格式

所有消息均为 JSON 文本帧。

### 方向标识

- **C→S**：远端 Client → Gateway Server
- **S→C**：Gateway Server → 远端 Client
- **双向**：双方均可发送

---

## 消息类型

### 1. `register`（C→S）

连接建立后，远端发送注册消息。

```json
{
  "type": "register",
  "accountId": "account-1",
  "runId": "run-abc123"
}
```

Gateway 处理逻辑：
- 校验 `accountId` 有效
- 检查 `runId` 是否已被 superseded（旧 runId 直接拒绝并关闭连接）
- 替换同账号旧 tunnel 连接
- 更新 registry：`tunnel`、`tunnelRunId`、`tunnelConnectedAt`、`verified=true`、`healthOk=true`、`status=ACTIVE`

### 2. `registered`（S→C）

注册成功确认。

```json
{
  "type": "registered",
  "accountId": "account-1"
}
```

### 3. `proxy_request`（S→C）

Gateway 通过 tunnel 推送 API 请求到远端。

```json
{
  "type": "proxy_request",
  "id": "m3abc-xyz123",
  "method": "POST",
  "path": "/v1/chat/completions",
  "headers": { "content-type": "application/json" },
  "body": "{\"model\":\"mimo-v2.5-pro\",\"messages\":[...]}"
}
```

| 字段 | 说明 |
|------|------|
| `id` | 请求唯一 ID（时间戳+随机串，用于匹配响应） |
| `method` | HTTP 方法 |
| `path` | 请求路径（不含 host） |
| `headers` | 请求头（已去除 `host`） |
| `body` | 请求体（可能为 null） |

### 4. `proxy_response`（C→S）

非流式完整响应。

```json
{
  "type": "proxy_response",
  "id": "m3abc-xyz123",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"id\":\"chatcmpl-...\",\"choices\":[...]}"
}
```

### 5. `proxy_response_chunk`（C→S）

流式响应分块。`chunkId=0` 的首块包含 `status` 和 `headers`。

```json
{
  "type": "proxy_response_chunk",
  "id": "m3abc-xyz123",
  "chunkId": 0,
  "status": 200,
  "headers": { "content-type": "text/event-stream" },
  "chunk": "<base64-encoded-data>"
}
```

```json
{
  "type": "proxy_response_chunk",
  "id": "m3abc-xyz123",
  "chunkId": 1,
  "chunk": "<base64-encoded-data>"
}
```

| 字段 | 说明 |
|------|------|
| `chunkId` | 从 0 开始递增 |
| `chunk` | Base64 编码的二进制数据 |
| `status` | 仅首块（chunkId=0）携带 |
| `headers` | 仅首块（chunkId=0）携带 |

Gateway 收到 chunk 后：
- 刷新超时（避免长流式请求被误杀）
- 首块（chunkId=0）：根据模式决定是否写 HTTP head
- 解码 base64 → Buffer
- 根据传输模式分发（见下方三种模式）

### 6. `proxy_response_end`（C→S）

流式响应结束。

```json
{
  "type": "proxy_response_end",
  "id": "m3abc-xyz123",
  "totalChunks": 5
}
```

Gateway 处理：
- 清理 pending request
- 拼接所有 chunk 为完整 body（供非 chunk 场景使用）
- 调用 `registry.markProxySuccess()`

### 7. `proxy_error`（C→S）

远端代理错误。

```json
{
  "type": "proxy_error",
  "id": "m3abc-xyz123",
  "error": "upstream connection refused"
}
```

### 8. `ping` / `pong`（双向）

心跳保活。

```json
{ "type": "ping" }
{ "type": "pong" }
```

- Gateway 每 30 秒发送 `ping`
- 远端收到 `ping` 后必须回复 `pong`
- 远端也可主动发送 `ping`，Gateway 回复 `pong`
- 任何有效消息都刷新 `lastPong`（避免长请求期间误杀）
- 超时阈值：`HEARTBEAT_INTERVAL(30s) + HEARTBEAT_TIMEOUT(10s) = 40s`

### 9. Bootstrap 模式

连接 URL 带 `bootstrap=1` 参数时，Gateway 推送 `skill/` 目录下所有 `.mjs`、`.md`、`.json` 文件。

```
ws://<host>:9300/tunnel?bootstrap=1&accountId=account-1
```

消息序列：
```json
{ "type": "file", "path": "tunnel-proxy.mjs", "content": "..." }
{ "type": "file", "path": "SKILL.md", "content": "..." }
...
{ "type": "done", "totalFiles": 3 }
```

错误时：
```json
{ "type": "error", "message": "read failed: ..." }
```

---

## `sendProxyRequest` 三种传输模式

### 模式 A：Buffered（默认）

收完整响应后一次性返回。不传 `res` 和 `onChunk`。

```
Gateway                    Tunnel
  |--- proxy_request ------->|
  |<-- proxy_response -------|  (完整 body)
```

### 模式 B：Pipe（`opts.res`）

传入 HTTP `res` 对象，tunnel 收到 chunk 直接写入 HTTP 响应。

```
Gateway (HTTP res)           Tunnel
  |--- proxy_request ------->|
  |<-- chunk_0 (head) -------|  → res.writeHead()
  |<-- chunk_1 --------------|  → res.write()
  |<-- chunk_2 --------------|  → res.write()
  |<-- response_end ---------|  → res.end()
```

适用场景：OpenAI 流式透传。

### 模式 C：Callback（`opts.onChunk`）

传入 `onChunk(buf, isFirst, status, headers)` 回调，每个 chunk 到达时同步调用。

```
Gateway                      Tunnel
  |--- proxy_request ------->|
  |<-- chunk_0 --------------|  → onChunk(buf, true, 200, headers)
  |<-- chunk_1 --------------|  → onChunk(buf, false)
  |<-- chunk_2 --------------|  → onChunk(buf, false)
  |<-- response_end ---------|  → resolve()
```

适用场景：Anthropic 流式转换（需要在 onChunk 中解析 OpenAI SSE 并转换为 Anthropic SSE）。

### 互斥约束

**`res` 和 `onChunk` 互斥**，不能同时传入。入口处会校验并 reject。

---

## Superseded Run 检测

当同一账号有新 tunnel 连接时：
1. Gateway 关闭旧 tunnel（`close(1000, 'replaced by newer tunnel')`）
2. 将旧 `runId` 加入 `supersededRunIds` 集合
3. 旧 runId 的后续 register 请求被拒绝

```json
// 拒绝消息
{ "type": "error", "error": "superseded tunnel run" }
```

---

## 注册超时

连接建立后 15 秒内未发送 `register` 消息，Gateway 主动断开。

---

## 认证

当前无显式认证机制。`accountId` 和 `runId` 通过 URL 参数传递。
安全性依赖于：
- Gateway 仅监听本地/公网但无敏感数据暴露
- tunnel 连接由远端主动发起

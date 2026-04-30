# AI Studio MiMo Claw API 逆向分析

## 已发现的 API 端点

基础域名: `https://aistudio.xiaomimimo.com`

### 1. 用户信息
```
GET /open-apis/user/mi/get?xiaomichatbot_ph={ph}
```
返回: userId, userName, bannedStatus 等

### 2. Bot 配置
```
GET /open-apis/bot/config?xiaomichatbot_ph={ph}
```
返回: modelConfigList (可用模型列表), claw 配置, TTS 配置等

### 3. MiMo Claw 实例状态
```
GET /open-apis/user/mimo-claw/status?xiaomichatbot_ph={ph}
```
返回:
```json
{
  "code": 0,
  "data": {
    "status": "AVAILABLE",
    "expireTime": 1777468376000,  // 过期时间戳 (ms)
    "message": "可用"
  }
}
```

### 4. 创建/获取实例
```
POST /open-apis/user/mimo-claw/create?xiaomichatbot_ph={ph}
Content-Type: application/json
Body: {}
```
返回: 同 status（当前实例已存在时返回现有实例信息）

### 5. WebSocket Ticket
```
GET /open-apis/user/ws/ticket?xiaomichatbot_ph={ph}
```
返回:
```json
{
  "code": 0,
  "data": {
    "ticket": "992b3be96b734c43b0fd84504213ad9d"
  }
}
```
用于建立 WebSocket 连接: `wss://aistudio.xiaomimimo.com/ws/proxy?ticket={ticket}`

### 6. 会话列表
```
POST /open-apis/chat/conversation/list?xiaomichatbot_ph={ph}
Content-Type: application/json
Body: {}
```

## 认证方式

Cookie 认证，关键字段:
- `serviceToken` — 登录凭证（核心，较长）
- `userId` — 用户 ID
- `xiaomichatbot_ph` — 固定值

## API Key 机制

- API Key (`oc_` 前缀) 通过环境变量 `MIMO_API_KEY` 注入到 MiMo Claw 沙箱
- **不在 HTTP API 中暴露** — 无法通过 web 接口直接获取
- 每次创建新实例会生成新 key
- Key 随实例过期而失效

## 未找到的端点

以下尝试均返回 404:
- `/open-apis/user/mimo-claw/stop`
- `/open-apis/user/mimo-claw/start`
- `/open-apis/user/mimo-claw/renew`
- `/open-apis/user/mimo-claw/extend`
- `/open-apis/user/mimo-claw/api-key`
- `/open-apis/user/mimo-claw/config`
- `/open-apis/user/mimo-claw/token`
- `/open-apis/user/mimo-claw/credential`

## 自动续期方案（待实现）

### 难点
API Key 仅存在于沙箱环境变量中，web API 不返回 key。

### 可能的方案
1. **WebSocket 拦截** — 监听实例创建时的 WS 消息，可能包含 key
2. **页面 DOM 解析** — 如果页面上有显示 key 的元素，可通过浏览器自动化提取
3. **外部脚本** — 在实例外运行，用 cookie 调用 create API，配合其他手段获取 key

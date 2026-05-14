# KeyPool Admin Console 审查报告

> 审查时间：2026-05-13 21:19 GMT+8
> 审查范围：`src/gateway/admin.mjs`（~580 行，含内嵌 HTML/JS 前端）+ `index.mjs` 中的 admin 挂载方式

---

## 一、安全问题

### S-1 [严重] Admin API 无认证

**现状：** 所有 `/admin/*` 端点完全无认证。任何能访问 9300 端口的人都可以：
- 查看所有账号 Cookie（通过 `/admin/api/accounts`）
- 创建/删除/修改账号
- 销毁/停止实例
- 启停 Manager

**影响：** 如果 KeyPool 绑定 `0.0.0.0`（当前配置），局域网甚至公网（通过 Tailnet）上的任何设备都能完全控制 KeyPool。

**建议修法：**
```javascript
// 在 createAdminHandler 入口处添加 Bearer Token 认证
const ADMIN_TOKEN = process.env.KEYPOOL_ADMIN_TOKEN || config.adminToken;

function checkAdminAuth(req, res) {
  if (!ADMIN_TOKEN) return true; // 未配置 token 时允许（开发模式）
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${ADMIN_TOKEN}`) return true;
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}
```
前端在请求中附加 `Authorization: Bearer <token>`。localStorage 存储 token。

### S-2 [中等] accounts.json Cookie 明文存储

**现状：** `accounts.json` 中 Cookie 以明文存储，admin API 返回 `hasCookie: true/false` 但不暴露实际值——这很好。但文件本身是明文。

**建议：** 至少设置文件权限为 600（仅 owner 可读），长期考虑加密存储。

### S-3 [中等] readJsonBody 无大小限制

**现状：** `readJsonBody()` 会读取整个请求体到内存，无上限。

```javascript
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(...); // 无限制
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
```

**风险：** 攻击者可发送 GB 级 POST 请求耗尽内存。

**建议：** 添加 `MAX_BODY_SIZE = 1MB` 限制。

### S-4 [低] 无 CSRF 保护

POST/PUT/DELETE 端点无 CSRF token。如果管理员在同一浏览器访问恶意网站，可能被利用。低风险因为是本地工具。

---

## 二、架构/代码质量问题

### A-1 [重要] 单文件过大

`admin.mjs` 约 580 行，混合了：
- HTTP 路由分发（手写 regex 路由）
- 业务逻辑（账号 CRUD、Manager 控制）
- 数据持久化（读写 accounts.json）
- 完整的前端 HTML/CSS/JS（~400 行模板字符串）

**建议拆分：**
```
src/gateway/admin/
├── index.mjs          # 路由分发 + 认证
├── routes/
│   ├── accounts.mjs   # 账号 CRUD API
│   ├── instances.mjs  # 实例管理 API
│   └── control.mjs    # Manager 控制 API
├── store.mjs          # accounts.json 读写
└── frontend/
    └── index.html     # 独立 HTML 文件
```

### A-2 [重要] /health 端点重复定义

`/health` 在 `index.mjs` 和 `admin.mjs` 中都有定义。`index.mjs` 中 `url.pathname === '/health'` 的判断先于 `adminHandler` 调用，所以实际走的是 `admin.mjs` 中的逻辑。但 `index.mjs` 的判断不会被触发（因为 `url.pathname.startsWith('/admin')` 不包含 `/health`），实际路由是 `index.mjs` 里写 `if (url.pathname === '/health' || url.pathname.startsWith('/admin'))` 把两者都交给了 `adminHandler`。

**问题：** 代码意图不清晰，容易误改。

**建议：** 只在 `admin.mjs` 中定义 `/health`，`index.mjs` 只做路由转发。

### A-3 [中等] 手写路由分散且无统一校验

每个端点都用手动 `if (url.pathname === '...' && req.method === '...')` 判断，regex 匹配也是手动的。18 个路由条件堆在一起，难以维护。

**建议：** 引入轻量路由表：
```javascript
const routes = [
  { method: 'GET',  path: '/admin',           handler: handleAdminPage },
  { method: 'GET',  path: '/admin/api/overview', handler: handleOverview },
  { method: 'POST', path: '/admin/api/accounts', handler: handleCreateAccount },
  { method: 'PUT',  path: '/admin/api/accounts/:id', handler: handleUpdateAccount },
  { method: 'DELETE', path: '/admin/api/accounts/:id', handler: handleDeleteAccount },
  { method: 'POST', path: '/admin/api/accounts/:id/:action', handler: handleAccountAction },
  // ...
];
```

### A-4 [低] mutateAccountsConfig 同步文件 I/O

`writeFileSync` 在 async 函数中使用，会阻塞事件循环。对于 admin 操作频率很低可以接受，但建议改用 `await writeFile()`。

### A-5 [低] 前端用 alert() 做反馈

所有成功/失败都用 `alert()` 弹窗。体验差且阻塞 UI。

**建议：** 用 toast 通知替代。

---

## 三、前端 UI 优化建议

### F-1 缺少 weight 配置支持

后端已支持 `weight` 字段（accounts.mjs normalizeAccount + registry 加权随机），但 admin UI 的账号表单中没有 weight 输入框。

**修法：** 在账号表单中增加 weight 字段，默认 100。

### F-2 缺少实例操作的实时反馈

点击"部署"/"销毁"按钮后，只有 alert 提示成功/失败，没有 loading 状态，也没有自动跳转到实例 tab 看进度。

**建议：**
- 按钮加 disabled + loading spinner
- 操作完成后自动切到"实例" tab 并高亮目标实例

### F-3 自动刷新效率低

10 秒一次自动刷新同时发 4 个 HTTP 请求（overview + agents + instances + accounts）。对于 2 个账号来说浪费不大，但如果账号增多会成为问题。

**建议：**
- 合并为单个 `/admin/api/all` 端点返回所有数据
- 或使用 WebSocket 推送增量更新

### F-4 缺少日志查看器

管理员无法在 UI 中看到 KeyPool 的运行日志。排查问题必须 SSH 到服务器看 `.keypool-bg.out.log`。

**建议：** 添加"日志" tab，通过 WebSocket 实时推送日志（或定时读取最近 N 行）。

### F-5 缺少系统信息面板

没有显示：
- KeyPool 版本/启动时间
- Node.js 内存/CPU 使用
- 系统负载
- 已处理请求数/错误率

### F-6 实例卡片信息过载

每个实例卡片显示了 ~20 个字段，很多是 null/-。应该：
- 默认只显示关键字段（状态、Agent、URL、最后部署时间）
- 点击"展开详情"显示完整字段

---

## 四、功能缺失

### FE-1 [重要] 没有请求速率限制

admin API 无速率限制。如果有人写脚本疯狂调用 `POST /admin/api/accounts` 可以产生大量写操作。

### FE-2 [重要] 没有操作审计日志

谁在什么时间做了什么操作（创建/删除/修改账号、启停 Manager）没有记录。

**建议：** 在 `memory/` 或 `logs/` 目录下写 admin-audit.log。

### FE-3 [有用] 没有批量操作

- "部署所有" / "停止所有" / "重启所有"
- "禁用所有" / "启用所有"

### FE-4 [有用] 没有 proxy 日志/统计

无法查看：
- 最近 N 次代理请求的延迟/状态码
- 各账号的成功率/失败率趋势
- 当前 inflight 请求详情

### FE-5 [有用] 没有配置编辑器

无法在 UI 中编辑 `config.json`（端口、deployRepo、tunnel timeout 等）。

---

## 五、优先级排序

| 编号 | 类型 | 优先级 | 描述 | 工作量 |
|------|------|--------|------|--------|
| S-1 | 安全 | **P0** | Admin API 认证 | 小 |
| S-3 | 安全 | **P1** | readJsonBody 大小限制 | 小 |
| F-1 | 功能 | **P1** | UI 支持 weight 配置 | 小 |
| A-1 | 架构 | **P2** | 拆分 admin.mjs | 中 |
| A-2 | 架构 | **P2** | 统一 /health 路由 | 小 |
| F-2 | UI | **P2** | 操作 loading 状态 | 小 |
| F-4 | 功能 | **P2** | 日志查看器 | 中 |
| FE-2 | 功能 | **P2** | 操作审计日志 | 小 |
| F-3 | UI | **P3** | 合并 API 请求 | 中 |
| F-6 | UI | **P3** | 实例卡片折叠 | 小 |
| FE-3 | 功能 | **P3** | 批量操作 | 小 |
| FE-4 | 功能 | **P3** | Proxy 统计面板 | 大 |
| A-3 | 架构 | **P3** | 引入路由表 | 中 |
| FE-5 | 功能 | **P4** | 配置编辑器 | 中 |
| S-2 | 安全 | **P4** | Cookie 加密存储 | 大 |
| S-4 | 安全 | **P4** | CSRF 保护 | 中 |
| A-4 | 架构 | **P4** | 异步文件写入 | 小 |
| A-5 | UI | **P4** | Toast 替代 alert | 小 |
| FE-1 | 功能 | **P4** | 速率限制 | 中 |

---

## 六、建议实施路径

### Phase 1: 安全 + 关键功能（立即）
1. S-1: 添加 Bearer Token 认证（env 变量配置）
2. S-3: readJsonBody 添加大小限制
3. F-1: 账号表单添加 weight 字段

### Phase 2: 架构改善（近期）
4. A-2: 统一 /health 路由
5. A-1: 拆分 admin.mjs 为路由 + 逻辑 + 前端
6. FE-2: 添加审计日志

### Phase 3: UI 体验提升（按需）
7. F-2: 操作 loading 状态
8. F-6: 实例卡片折叠
9. F-5: 系统信息面板
10. A-5: Toast 替代 alert

### Phase 4: 高级功能（有空时）
11. F-4: 日志查看器
12. FE-4: Proxy 统计面板
13. FE-3: 批量操作
14. F-3: WebSocket 推送

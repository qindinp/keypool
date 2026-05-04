# KeyPool 独立 GUI（复用 admin.html 前端）实现计划

> 执行策略：优先复用现有 `relay/admin.html` 的前端布局与交互思路，但从 relay 侧剥离；新增一个独立本地控制服务，供 `file://` 打开的 GUI 调用。

**目标：** 让 KeyPool 拥有一个不依赖 relay 存活的独立控制台，支持状态查看、全局启停、单账号 deploy/recover/destroy、日志查看。

**架构：** 前端保留 `admin.html` 的视觉和组件模型，但改为独立 GUI 文件；后端新增 `control-server.mjs` 提供本地 API，并调用/复用现有 `app-bg`、manager、registry、worker 能力。

**技术栈：** 原生 HTML/CSS/JS + Node.js（ESM） + 现有 KeyPool 模块。

## 里程碑

- [ ] M1：控制服务骨架可启动，`GET /status` 可用
- [ ] M2：全局启停接口可用（start-all/stop-all/restart-all）
- [ ] M3：独立 GUI 能从 `file://` 打开并显示状态
- [ ] M4：账号列表与单账号动作接通
- [ ] M5：日志查看接通并完成最小验证

## Step 1 — 新增独立控制服务骨架
- [ ] 新建 `control-server.mjs`
- [ ] 监听 `127.0.0.1:9310`
- [ ] 增加基础 JSON 返回工具与 CORS 头
- [ ] 允许 `Origin: null`、`http://127.0.0.1:9310`、`http://localhost:9310`
- [ ] 提供根路径说明响应（便于浏览器直接查看）

## Step 2 — 状态聚合接口
- [ ] 从 `scripts/app-bg.mjs` 复用 app-bg 状态能力
- [ ] 复用/移植 manager 状态检测逻辑
- [ ] 检查 9300 relay 是否存活（端口/health）
- [ ] 读取 `.manager/registry.json`
- [ ] 读取 `.manager/*.state.json`
- [ ] 提供 `GET /status`
- [ ] 状态返回统一为：`relay / manager / app / summary / accounts`

## Step 3 — 全局启停接口
- [ ] 提供 `POST /start-all`
- [ ] 提供 `POST /stop-all`
- [ ] 提供 `POST /restart-all`
- [ ] `start-all` 先复用现有 `app-bg` 启动链路
- [ ] 若已有 relay 存活，避免重复拉起冲突实例
- [ ] 明确返回“控制动作已触发”与“实际状态”两层信息

## Step 4 — 账号聚合接口
- [ ] 读取 `accounts.json`
- [ ] 聚合 registry / state 信息到账号视图
- [ ] 提供 `GET /accounts`
- [ ] 返回字段至少覆盖：
  - `id/name/enabled/priority/tags`
  - `instanceStatus/shareUrl/localUrl/baseUrl`
  - `healthy/lastError/deployCount/lastDeployAt`

## Step 5 — 单账号动作接口
- [ ] 复用现有 worker runtime 构造方式
- [ ] 接入 `POST /accounts/:id/deploy`
- [ ] 接入 `POST /accounts/:id/recover`
- [ ] 接入 `POST /accounts/:id/destroy`
- [ ] 返回统一动作结果结构：
  - `ok`
  - `action`
  - `accountId`
  - `message`
  - `state`

## Step 6 — 日志接口
- [ ] 提供 `GET /logs?name=manager&limit=100`
- [ ] 支持 `relay` / `app-bg` / `<account-id>`
- [ ] 只返回尾部日志，避免响应过大
- [ ] 对不存在的日志给出明确提示

## Step 7 — 独立 GUI 页面
- [ ] 基于 `relay/admin.html` 拷贝出独立页面（建议命名 `keypool-gui.html`）
- [ ] 把所有相对路径 API 改成 `API_BASE = 'http://127.0.0.1:9310'`
- [ ] 保留现有：
  - 状态卡片
  - 账号列表
  - 单账号动作按钮
  - 日志面板
- [ ] 去掉只对 relay 宿主有意义的链接/相对路径依赖
- [ ] 调整文案，明确这是“独立控制台”而非 relay 附属页

## Step 8 — 最小验证
- [ ] 本地启动 `control-server.mjs`
- [ ] 浏览器以 `file://` 打开 GUI
- [ ] 验证 `/status` 能正常显示
- [ ] 验证“一键启动全部”能触发控制服务
- [ ] 验证至少一个账号动作按钮通路正常
- [ ] 验证日志面板可读

## Step 9 — 提交与清理
- [ ] 清理临时调试输出
- [ ] 补 README/使用说明（最小必要）
- [ ] 提交 git

## 约束与注意事项
- [ ] 不直接把 KeyPool 总控逻辑塞进现有 `model-manager` 的 8766 服务
- [ ] 不继续把独立 GUI 绑定到 relay 是否存活
- [ ] 区分“接口返回 200”和“业务动作真实成功”
- [ ] 对 Windows 环境下的日志/文本读取保持 UTF-8 兼容意识

## 当前执行建议
先做 Step 1~3（控制服务骨架 + 状态 + 全局启停），这样最快能把“独立于 relay 的控制能力”打通。随后再接前端与账号动作。

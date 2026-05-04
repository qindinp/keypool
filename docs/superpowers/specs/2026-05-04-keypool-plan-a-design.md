# KeyPool 方案 A 设计草案

## 目标
为 KeyPool 增加一套**独立 GUI + 独立本地控制服务**，使用户在 relay 不可用时，仍可通过一个固定入口查看状态并执行“一键启动全部服务 / 停止 / 单账号动作”等操作。

## 问题背景
当前 `relay/admin.html` 挂在 relay 上，relay 死掉时页面本身也随之消失，因此它不能承担“系统之外总控台”的角色。用户已经明确选择方案 A，希望控制入口不依赖 relay 存活。

## 设计原则
1. **最小增量**：复用现有 `manager.mjs`、`relay/server.mjs`、`scripts/app-bg.mjs`、`.manager/*.json` 与单账号 worker 能力，不推翻现有架构。
2. **双层控制拆分**：
   - 独立控制服务负责系统级启停与状态聚合
   - 现有 relay/admin 继续承担 relay 存活时的细粒度管理页面
3. **本地优先**：控制服务仅监听 `127.0.0.1`。
4. **本地网页可用**：允许 `file://` 页面通过 CORS 调本地控制服务。
5. **先 MVP 后扩展**：第一版先做状态、启动/停止、账号列表、单账号动作、日志，不先做复杂图表和高级配置编辑。

## 目标形态

### 前端
新增一个独立 GUI 页面，例如：
- `keypool-gui.html`（可直接 `file:///...` 打开）

### 后端
新增一个独立本地控制服务，例如：
- `control-server.mjs`
- 监听 `127.0.0.1:9310`

### 运行关系
- GUI 不依赖 relay
- 控制服务依赖本机文件系统与进程管理能力
- relay 只是被控制对象之一

## MVP 范围

### 1. 全局状态
提供统一状态聚合接口，显示：
- relay 是否运行
- manager 是否运行
- app-bg 是否运行
- 关键端口状态（9300 / 9310）
- registry 汇总（healthy upstream 数、missing shareUrl 数等）

### 2. 一键启动/停止
提供：
- `POST /start-all`
- `POST /stop-all`
- `POST /restart-all`
语义：
- `start-all`：优先启动 `app-bg`，必要时补起 manager；若已有 relay 可复用则不重复拉起
- `stop-all`：停止 `app-bg`，并尽量停止 manager/relay 相关子链路
- `restart-all`：先 stop，再 start

### 3. 账号列表
读取：
- `accounts.json`
- `.manager/registry.json`
- `.manager/*.state.json`
聚合出账号卡片所需字段。

### 4. 单账号动作
复用已有动作语义：
- `POST /accounts/:id/deploy`
- `POST /accounts/:id/recover`
- `POST /accounts/:id/destroy`
优先复用现有 worker / API 调用链，而不是再造一套逻辑。

### 5. 日志查看
提供：
- `GET /logs?name=manager`
- `GET /logs?name=relay`
- `GET /logs?name=<account-id>`
返回尾部日志，足够诊断即可。

## 接口草案

### 状态接口
- `GET /status`
返回：
- `relay`
- `manager`
- `app`
- `summary`
- `accounts`

### 控制接口
- `POST /start-all`
- `POST /stop-all`
- `POST /restart-all`

### 账号接口
- `GET /accounts`
- `POST /accounts/:id/deploy`
- `POST /accounts/:id/recover`
- `POST /accounts/:id/destroy`

### 日志接口
- `GET /logs?name=manager&limit=100`
- `GET /logs?name=relay&limit=100`
- `GET /logs?name=account-1&limit=100`

## CORS 设计
控制服务允许的 Origin：
- `null`（用于 `file://` 本地网页）
- `http://127.0.0.1:9310`
- `http://localhost:9310`

## 建议文件布局
在 `keypool` 仓库内新增：
- `control-server.mjs`：独立本地控制服务
- `keypool-gui.html`：独立 GUI 页面
可选：
- `scripts/control-bg.mjs`：如果后续需要让控制服务本身后台常驻

## 与现有代码的复用边界

### 直接复用
- `scripts/app-bg.mjs`
- `manager.mjs` 的状态文件与 registry 语义
- `relay/server.mjs` 中已存在的部分聚合和账号动作思路
- `controller/account-worker.mjs` 的 deploy/recover 逻辑
- `controller/mimo-api.mjs` 的 create/destroy/ticket 能力

### 不直接复用
- 不把控制入口继续绑死在 `relay/admin.html`
- 不把 `model-manager` 的 8766 服务直接拿来承载 KeyPool 控制逻辑

## 实施步骤（MVP）
1. 新增 `control-server.mjs`，先打通 `GET /status`
2. 接入 `start-all / stop-all / restart-all`
3. 接入 `GET /accounts` 与账号聚合
4. 接入单账号 deploy/recover/destroy
5. 新增 `keypool-gui.html`，先做最小状态面板和按钮
6. 再补日志面板与更细致的错误提示

## 风险与约束
1. `file://` 页面一定要依赖控制服务正确放开 CORS，否则浏览器会拦。
2. 控制服务若和 relay 竞争端口或状态定义，可能引入双重控制冲突；因此控制服务应尽量调用已有 app-bg / manager 能力，而不是重复造进程编排。
3. 单账号动作要清晰区分“控制服务状态”和“业务动作成功状态”，避免 UI 误把接口 200 当业务成功。

## 推荐结论
方案 A 是当前最合理的方向。第一版应优先做成：
- 一个能从 `file://` 打开的 `keypool-gui.html`
- 一个仅监听 `127.0.0.1:9310` 的 `control-server.mjs`
- 支持状态查看、全局启停、单账号动作、日志查看

后续如验证好用，再考虑：
- 开机自启
- 控制服务后台常驻
- 桌面快捷方式
- 更复杂的账号配置编辑

# KeyPool 项目全面审查与优化计划

> 生成时间：2026-05-12 18:37 CST  
> 仓库：`C:\Users\Administrator\.openclaw\workspace\keypool`  
> 目标：对 KeyPool 各模块做系统性代码审查、风险梳理、优化设计、验证补强和分阶段落地。

---

## 1. 当前基线

### 1.1 项目定位

KeyPool 是一个多账号 MiMo / AI Studio 实例编排器 + 统一 API Gateway：

- 本地 Gateway 监听 `9300`，提供：
  - OpenAI 兼容 `/v1/chat/completions`
  - Anthropic 兼容 `/v1/messages`
  - `/v1/models`
  - `/health`
  - `/admin`
  - WebSocket `/tunnel`
- 远端沙箱实例运行 `keypool-tunnel`，通过 WebSocket 反连 Gateway。
- Manager 负责账号、实例生命周期、部署、恢复、销毁和调度。

### 1.2 当前运行状态快照

最近检查结果：

- Gateway `http://127.0.0.1:9300/health`：`status=ok`
- `verifiedInstances=2`
- `deployingInstances=0`
- `failedInstances=0`
- `/v1/models` 可返回 MiMo 模型列表。
- 最小非流式 chat 调用可通。
- 9300 当前由 PID `8692` 监听。
- `.keypool-bg.pid` 中记录的 PID 疑似过期。

### 1.3 仓库状态

- 分支：`main`
- 相对 `origin/main`：ahead 21
- 已修改未提交：
  - `src/gateway/index.mjs`
  - `src/gateway/tunnel.mjs`
- 大量未跟踪文件：临时脚本、日志、zip 包、runtime-monitor、artifact stage、异常命名空文件等。

### 1.4 已知近期问题线索

- Tunnel 连接曾出现 `tunnel connection closed`。
- 日志中有大量“拒绝已被替换的旧 runId”。
- Admin destroy 曾出现“销毁一个账号影响另一个账号”的联动问题。
- 已修复过全局 deploy 队列问题，改为 per-account deploy queue。
- 仍待确认 scheduler 对 destroy / manual stop 的语义是否正确，避免销毁后立刻自动重建。
- 部署链路曾受公开 Gateway URL、Gitee 仓库地址、远端 skill 路径、旧 prompt / 旧进程残留影响。
- 当前未提交代码正在调整 tunnel 流式 chunk → Anthropic SSE 的转换链路。

---

## 2. 审查目标

本轮审查不只是“看代码”，而是要产出可落地的优化结果：

1. 明确各模块职责边界。
2. 梳理核心状态机和请求链路。
3. 找出正确性、并发、生命周期、错误处理、安全、可维护性问题。
4. 区分：
   - 必须立即修复的问题
   - 可以分阶段优化的问题
   - 仅需文档化的问题
5. 补齐最小测试与验证脚本。
6. 清理仓库噪音，形成可提交、可回滚的改动批次。
7. 最终给出稳定运行与后续维护指南。

---

## 3. 模块拆分与审查重点

### 3.1 Gateway HTTP 入口：`src/gateway/index.mjs`

审查范围：

- HTTP 路由分发
- `/health` / `/admin`
- `/v1/models`
- `/v1/chat/completions`
- `/v1/messages`
- Anthropic ↔ OpenAI 转换入口
- tunnel 优先和 HTTP fallback 行为

重点问题：

- 路由和 body 读取是否对所有路径合理。
- Anthropic streaming 转换是否完整输出：
  - `message_start`
  - `content_block_start`
  - `content_block_delta`
  - `content_block_stop`
  - `message_delta`
  - `message_stop`
- 非流式和流式错误格式是否兼容上游客户端。
- `collectModels` fallback 是否可能掩盖真实无可用上游。
- `PassThrough` 当前未实际使用，需确认是移除还是正式抽象为 stream adapter。
- 中英文/乱码日志是否需要统一编码与格式。

优化方向：

- 将 Anthropic streaming 处理从 `index.mjs` 抽出独立模块，例如 `src/gateway/anthropic-stream.mjs`。
- 明确 OpenAI native endpoint 与 Anthropic endpoint 的错误模型。
- 给 `/v1/models` 的 fallback 增加标记字段或日志，避免误诊。
- 增加请求 ID 日志，方便跨 Gateway / tunnel / remote proxy 追踪。

---

### 3.2 Gateway Proxy：`src/gateway/proxy.mjs`

审查范围：

- OpenAI `/v1/chat/completions` 代理
- upstream 选择
- tunnel vs HTTP 直连 fallback
- 请求/响应透传
- 流式响应处理

重点问题：

- 当 tunnel 已注册但请求失败时，是否应该 fallback 到 HTTP。
- 非 2xx 上游响应是否保留原始 body 和 status。
- streaming response 是否可能被提前 end。
- 大 body / 长请求是否存在内存风险。
- 错误是否会误触发 registry 健康状态变化。

优化方向：

- 统一 proxy result 类型：`success | upstream_error | transport_error | timeout`。
- 明确 transport error 才影响健康，业务错误不应误判实例坏。
- 添加最小代理测试：正常、上游 400、上游 500、超时、stream chunk。

---

### 3.3 Tunnel Server：`src/gateway/tunnel.mjs`

审查范围：

- WebSocket upgrade 和注册
- `accountId` / `runId` 语义
- superseded run 处理
- pending request 管理
- streaming chunk 协议
- heartbeat
- bootstrap skill 文件推送

重点问题：

- `pendingRequests` 是全局 map，close 时必须只清理当前 ws 对应请求；当前方向是对的，要补测试。
- superseded runId 当前日志大量出现，需判断是正常旧连接重试，还是远端旧进程未被有效停止。
- `onChunk` 模式下当前还会继续写 `entry.res.write(buf)`；如果同时传入 `res` 和 `onChunk` 可能导致双写，需要明确互斥契约。
- `onChunk` 异常目前只 log，不会 reject，是否会导致请求挂住需确认。
- `proxy_response_end` resolve 后，如果 `onChunk` 调用方负责 `res.end()`，约定需要写清楚。
- heartbeat 以任意有效消息刷新 `lastPong` 是合理的，但需要避免长时间无 chunk 的上游请求误杀。
- bootstrap 直接读本地 `skill` 目录推送，需审查路径、大小、文件类型和错误处理。

优化方向：

- 抽象 tunnel protocol schema：`register`、`proxy_request`、`proxy_response`、`proxy_response_chunk`、`proxy_response_end`、`proxy_error`。
- 给 `sendProxyRequest` 明确三种模式：
  1. buffered：收完整 body
  2. pipe：直接写 HTTP response
  3. callback：只调用 onChunk，由调用方负责输出
- 对 superseded run 做节流日志或统计，不要刷屏。
- 增加 pending request metrics：当前数量、超时数量、关闭清理数量。

---

### 3.4 Registry / Router：`src/gateway/registry.mjs`、`src/gateway/router.mjs`

审查范围：

- 实例状态存储
- verified upstream 列表
- 模型路由策略
- proxy success / failure 标记
- 健康字段更新

重点问题：

- 状态字段是否重复：`verified`、`healthOk`、`status`、`lastVerifiedAt`。
- ACTIVE / FAILED / RECOVERING 等状态是否在 registry 和 manager 之间一致。
- 路由是否支持模型级别过滤。
- 选择策略是否考虑失败次数、最近成功时间、正在恢复状态。

优化方向：

- 定义统一状态枚举与状态流转表。
- Registry 只做 runtime view，Manager 负责生命周期决策，避免职责混杂。
- 路由增加健康权重和熔断窗口。

---

### 3.5 Adapter：`src/gateway/adapter.mjs`

审查范围：

- Anthropic 请求转 OpenAI 请求
- OpenAI 响应转 Anthropic 响应
- OpenAI SSE chunk 转 Anthropic events
- reasoning / thinking 字段兼容

重点问题：

- 当前 MiMo 可能返回 `reasoning_content`，`content` 为空；需明确映射到 Anthropic thinking 还是 text。
- `max_tokens`、`temperature`、`tools`、`tool_choice`、`system`、multi-modal content 是否完整兼容。
- streaming chunk 中 reasoning 和 text block 的开闭顺序是否符合 Anthropic SDK。
- stop reason 映射是否正确。

优化方向：

- 为 adapter 建测试矩阵：
  - text only
  - reasoning only
  - reasoning + text
  - tool calls
  - empty delta
  - `[DONE]`
  - length stop
- 将状态机文档化。

---

### 3.6 Admin：`src/gateway/admin.mjs`

审查范围：

- `/admin` UI
- Admin API
- deploy / recover / destroy 操作
- overview 状态展示

重点问题：

- destroy 的语义必须澄清：
  - destroy remote instance only?
  - pause account?
  - manual stop and do not auto recreate?
- 曾出现销毁一个账号影响另一个账号，需要重点复盘：
  - per-account queue 是否已完全覆盖所有动作
  - scheduler 是否会在 destroy 后立即 create
  - upstream platform 是否按账号隔离实例槽位
- Admin 操作是否有认证或本地访问限制。
- UI 是否显示 runId、tunnelConnectedAt、last error、deploy stage。

优化方向：

- 引入 `MANUAL_STOPPED` 或 `PAUSED` 状态。
- Admin destroy 改名或分拆：
  - `stop`：停止并暂停自动重建
  - `destroy`：销毁当前实例但允许 scheduler 后续重建
  - `recover`：解除暂停并重建
- 操作结果返回 correlation id。

---

### 3.7 Manager 入口：`src/manager/index.mjs`

审查范围：

- Manager 初始化
- account worker 创建
- gateway URL / public URL 注入
- scheduler 启停
- 状态暴露

重点问题：

- 启动顺序：Gateway、Manager、Scheduler、Registry 同步是否可靠。
- 上次出现过 `sleep is not defined`，说明 helper / import 容易被误删，需要测试覆盖启动路径。
- 配置加载失败或账号为空时行为是否明确。
- 进程退出时是否优雅关闭。

优化方向：

- 启动路径增加 smoke test。
- Manager 提供只读 diagnostic snapshot。
- 启动失败时输出结构化错误。

---

### 3.8 Account Worker：`src/manager/account-worker.mjs`

审查范围：

- 单账号生命周期
- create / deploy / verify / recover / destroy
- 状态字段和错误记录
- 与 instance / deployer / scheduler 的协作

重点问题：

- 是否所有 async 操作都有并发保护。
- worker 是否会被重复 create / recover。
- 状态更新是否可能乱序覆盖。
- runId 是否贯穿 create → deploy → tunnel register。
- error 分类是否清晰：资源不可用、认证失败、部署失败、tunnel 未连通、上游 API 失败。

优化方向：

- 给每次 lifecycle operation 分配 operation id。
- 所有状态更新带 generation / runId，旧操作不能覆盖新状态。
- 对上游资源不可用做冷却，不要高频重试。

---

### 3.9 Scheduler：`src/manager/scheduler.mjs`

审查范围：

- 状态驱动调度
- 自动创建 / 恢复 / 冷却
- failed / destroyed / recovering 处理
- 多账号公平性

重点问题：

- `DESTROYED` 是否被自动 create，是当前最重要风险之一。
- 是否缺失 `PAUSED` / `MANUAL_STOPPED`。
- 调度周期和操作耗时是否可能重叠。
- failed retry 是否有指数退避。
- 多账号是否完全独立。

优化方向：

- 建立显式状态机：
  - `NONE`
  - `CREATING`
  - `READY`
  - `DEPLOYING`
  - `DEPLOYED_UNVERIFIED`
  - `ACTIVE`
  - `RECOVERING`
  - `FAILED`
  - `PAUSED`
  - `MANUAL_STOPPED`
- 对每个状态写清楚 scheduler 行为。
- 添加调度决策日志：`state + reason + action`。

---

### 3.10 Instance API：`src/manager/instance.mjs`

审查范围：

- MiMo / AI Studio 实例创建、销毁、查询
- cookie / token 认证
- 上游错误解析
- shareUrl / ticket / resource 状态

重点问题：

- Cookie 失效和资源不可用需区分。
- 400 `Mimo Claw资源当前不可用` 应被分类为上游资源限制，而不是本地失败。
- 创建/销毁是否会影响同平台其他实例槽位。
- HTTP 错误 body 是否完整记录但不泄露敏感信息。

优化方向：

- 定义 UpstreamError 类，带 `kind`：`AUTH`、`RESOURCE_UNAVAILABLE`、`RATE_LIMIT`、`NETWORK`、`UNKNOWN`。
- 敏感字段脱敏日志。
- 对资源不可用加入冷却时间。

---

### 3.11 Deployer：`src/manager/deployer.mjs`、`src/manager/deploy-client.mjs`

审查范围：

- 远端沙箱 OpenClaw 通信
- skill 安装 / Gitee clone
- tunnel proxy 启动 prompt
- public gateway URL 注入
- per-account deploy queue
- marker / timeout 判断

重点问题：

- deployer 判断成功不能只依赖 chat marker；tunnel register 到达应可作为成功条件之一。
- Gitee URL、repo owner、目标路径不能残留旧值。
- 不能在日志或 prompt 中泄露 token。
- per-account queue 是否覆盖 deploy / recover / destroy 全部路径。
- 远端旧 tunnel 进程是否会不断重连，造成 superseded 日志刷屏。

优化方向：

- 部署成功判据改为多信号：
  1. 远端 prompt marker
  2. tunnel register 到达
  3. models/chat smoke test 通过
- prompt 模板集中管理，避免散落字符串。
- 增加 remote cleanup step：停止旧 tunnel-proxy。
- 部署日志结构化，记录 stage 和耗时。

---

### 3.12 Config / Accounts：`src/manager/config.mjs`、`src/manager/accounts.mjs`

审查范围：

- `config.json` / `config.example.json`
- `accounts.json` / `accounts.example.json`
- gateway public URL
- Gitee 配置
- 账号 cookie 加载

重点问题：

- 配置字段是否有 schema 校验。
- 缺失字段是否有安全默认值。
- 敏感字段是否误入 Git 或日志。
- README / example 是否和当前代码一致。

优化方向：

- 添加 `validateConfig()` 和 `validateAccounts()`。
- example 保持最小可用。
- 敏感字段只允许本地配置，不写入 artifact。

---

### 3.13 Skill / dist / scripts

审查范围：

- `skill/`
- `dist/keypool-tunnel/`
- `scripts/start-keypool-bg.ps1`
- `scripts/status-keypool-bg.ps1`
- `scripts/stop-keypool-bg.ps1`
- Gitee deploy 文档
- zip 产物

重点问题：

- `skill` 与 `dist/keypool-tunnel` 是否一致。
- 远端安装路径到底是 `/root/.openclaw/skills/keypool-tunnel` 还是 workspace 路径。
- bg pid 文件过期问题。
- Windows PowerShell 启停脚本是否准确识别进程。

优化方向：

- 明确单一发布源：`skill/` → build → `dist/keypool-tunnel`。
- pid 文件写入前后校验进程 command line。
- status 脚本同时检查 pid、端口、health。
- 清理或归档 zip 产物。

---

### 3.14 文档与编码

审查范围：

- README
- docs
- 注释
- 日志输出

重点问题：

- 当前部分中文显示为乱码，可能是历史编码或终端显示问题。
- README 与当前架构是否一致。
- 状态机、部署链路、排障指南是否缺失。

优化方向：

- 新增 `docs/ARCHITECTURE.md`。
- 新增 `docs/STATE_MACHINE.md`。
- 新增 `docs/RUNBOOK.md`。
- 日志采用统一前缀和英文/中文一致编码。

---

## 4. 横切审查维度

### 4.1 正确性

- 请求不丢失。
- 流式响应不双写、不早停、不挂死。
- 旧 run 不能覆盖新 run。
- destroy / pause / recover 语义明确。

### 4.2 并发与状态一致性

- 每账号操作串行。
- 不同账号互不阻塞。
- 全局共享结构需要按 ws / account / request id 精确清理。
- scheduler 不与 admin 手动动作打架。

### 4.3 错误处理

- 区分业务错误、认证错误、资源不足、网络错误、超时、协议错误。
- 客户端收到兼容格式错误。
- 内部日志保留足够诊断信息但脱敏。

### 4.4 可观测性

- 每个请求有 request id。
- 每次部署有 operation id。
- 每个 tunnel 有 accountId + runId。
- health/admin overview 显示关键状态。

### 4.5 安全

- 不打印 cookie / token。
- Admin 默认只绑定本地或加认证。
- bootstrap 文件推送限制路径和文件类型。
- 外部配置不把私密内容写入 Git。

### 4.6 可维护性

- 大文件拆分。
- 协议和状态机文档化。
- 临时脚本收敛到 scripts 或删除。
- 测试覆盖关键链路。

---

## 5. 分阶段执行计划

### Phase 0：建立安全基线与审查快照

目标：确保后续优化可回滚、可验证。

任务：

1. 记录当前 Git 状态、diff、未跟踪文件清单。
2. 备份当前未提交 diff。
3. 标记哪些临时文件可删、哪些需保留。
4. 记录当前运行状态：pid、port、health、models、chat smoke。
5. 建立审查 checklist。

交付物：

- `docs/review/00-baseline.md`
- `docs/review/untracked-files.md`
- 可复现 smoke 命令。

验收：

- 不改业务代码。
- 当前服务仍可用。

---

### Phase 1：架构与状态机审查

目标：先把系统真实行为画清楚。

任务：

1. 绘制模块调用图。
2. 绘制请求链路：
   - OpenAI non-stream
   - OpenAI stream
   - Anthropic non-stream
   - Anthropic stream
   - `/v1/models`
3. 绘制实例生命周期状态机。
4. 梳理 Admin 操作和 Scheduler 自动动作冲突点。
5. 确认 destroy / stop / pause / recover 语义。

交付物：

- `docs/ARCHITECTURE.md`
- `docs/STATE_MACHINE.md`
- `docs/REQUEST_FLOWS.md`

验收：

- 能明确回答“某个账号为何会被创建/销毁/恢复”。
- 能明确回答“一个 chat 请求如何路由到远端 tunnel”。

---

### Phase 2：测试与验证框架补强

目标：避免边修边破。

任务：

1. 增加 Node test 基础目录。
2. 为 adapter 添加单元测试。
3. 为 tunnel pending cleanup 添加单元/集成测试。
4. 为 scheduler 状态决策添加测试。
5. 为 admin destroy/pause/recover 添加行为测试。
6. 增加 smoke 脚本：
   - health
   - models
   - OpenAI chat non-stream
   - OpenAI chat stream
   - Anthropic messages non-stream
   - Anthropic messages stream

交付物：

- `tests/adapter.test.mjs`
- `tests/tunnel.test.mjs`
- `tests/scheduler.test.mjs`
- `scripts/smoke-keypool.ps1`

验收：

- `npm test` 可运行。
- smoke 能清楚显示通过/失败原因。

---

### Phase 3：高风险修复优先落地

目标：优先处理会导致实例错杀、请求中断、仓库不可维护的问题。

优先修复项：

1. Admin destroy 语义修复：引入 `PAUSED` / `MANUAL_STOPPED`。
2. Scheduler 不自动重建手动停止账号。
3. Deployer 成功判据增加 tunnel register 信号。
4. Tunnel `sendProxyRequest` 三模式互斥，避免 onChunk/res 双写。
5. 旧 runId / 旧进程重连处理降噪，并审查是否需要远端 cleanup。
6. pid 文件过期问题修复。

交付物：

- 小批次 commit，每个 commit 只解决一个主题。
- 对应测试用例。

验收：

- 销毁 account-1 不影响 account-2。
- 手动停止不会被 scheduler 立即重建。
- Anthropic stream 不双写、不挂住。
- status 脚本显示真实进程。

---

### Phase 4：Gateway / Tunnel 协议稳定化

目标：把核心请求链路做稳。

任务：

1. 明确 tunnel protocol schema。
2. 增加 request id / operation id 日志。
3. 完善 proxy 错误分类。
4. 完善 OpenAI ↔ Anthropic streaming adapter。
5. collectModels 行为明确化，不掩盖真实无 upstream。

交付物：

- `docs/TUNNEL_PROTOCOL.md`
- adapter 测试矩阵
- proxy 错误分类实现

验收：

- 流式和非流式 OpenAI / Anthropic 均 smoke 通过。
- tunnel timeout / close / upstream error 均返回可理解错误。

---

### Phase 5：部署链路与配置整理

目标：让远端部署稳定、可诊断、可重复。

任务：

1. 集中 prompt 模板。
2. 明确 Gitee 仓库、目标路径和认证方式。
3. 部署前停止旧 tunnel 进程。
4. 部署阶段结构化：install、start、connect、verify。
5. 配置 schema 校验。
6. accounts/config example 更新。

交付物：

- `docs/DEPLOYMENT.md`
- `docs/RUNBOOK.md`
- config/accounts validation

验收：

- 单账号 recover 可稳定完成。
- 日志可看出失败在哪个阶段。
- 不泄露 token/cookie。

---

### Phase 6：仓库清理与文档收尾

目标：让仓库进入可维护状态。

任务：

1. 清理 `_tmp_*` 临时文件。
2. 处理异常空文件：如 `{console.error(e.message)` 等。
3. 决定 zip / dist 产物是否纳入 Git。
4. 更新 `.gitignore`。
5. 将临时诊断脚本迁移到 `scripts/diagnostics/` 或删除。
6. README 更新为当前架构。

交付物：

- 清理 commit
- 更新 README
- 更新 `.gitignore`

验收：

- `git status` 干净或只剩明确需要保留文件。
- 新人可按 README 启动和排障。

---

## 6. 优先级矩阵

### P0：必须先做

- 保护当前未提交改动和运行状态。
- 明确 destroy / pause / scheduler 语义。
- 修复可能导致跨账号影响的问题。
- 修复 stream onChunk/res 双写风险。
- 建立 smoke 验证。

### P1：应尽快做

- adapter 测试。
- tunnel pending cleanup 测试。
- deployer 成功判据优化。
- pid/status 脚本修复。
- 配置校验和脱敏日志。

### P2：持续优化

- 架构文档完善。
- 日志结构化。
- 仓库临时文件清理。
- admin UI 展示增强。

---

## 7. 建议提交策略

不要一次性大改。建议按以下 commit 拆分：

1. `docs: add keypool review baseline and architecture notes`
2. `test: add keypool smoke and adapter tests`
3. `fix(manager): add manual stopped state for admin stop`
4. `fix(scheduler): avoid recreating manually stopped accounts`
5. `fix(tunnel): make stream handling modes explicit`
6. `fix(deploy): treat tunnel registration as deploy success signal`
7. `chore(scripts): harden keypool background status scripts`
8. `chore(repo): clean temporary diagnostics and update gitignore`

每个 commit 后跑：

- `npm test`
- health smoke
- models smoke
- chat non-stream smoke
- stream smoke（若该 commit 影响 stream）

---

## 8. 风险与注意事项

1. 不要直接删除临时文件，先分类列表并确认是否仍被引用。
2. 不要把 cookie、token、Gitee 认证 URL 明文写进文档或提交。
3. 对运行中的 9300 服务做改动前，应记录当前进程和启动方式。
4. 修改 scheduler/admin 前要先写状态机测试，避免再次出现账号联动。
5. 修改 stream 处理时必须同时测 OpenAI stream 和 Anthropic stream。
6. 远端 MiMo 资源不可用可能不是本地 bug，要在错误分类中明确体现。

---

## 9. 首轮建议执行清单

如果现在开始执行，我建议按这个顺序：

1. 生成 baseline：Git 状态、diff、未跟踪文件、运行状态。
2. 新建 `docs/review/`，写入 baseline 和模块图。
3. 添加 smoke 脚本，先把当前可用性固定下来。
4. 审查 scheduler/admin，设计 `MANUAL_STOPPED`。
5. 审查 tunnel streaming，收敛当前未提交 diff。
6. 为 adapter/tunnel/scheduler 添加最小测试。
7. 再开始代码修复和仓库清理。

---

## 10. 最终验收标准

本轮全面审查和优化完成时，应满足：

- 文档：架构、状态机、请求链路、部署、排障齐全。
- 测试：关键 adapter / tunnel / scheduler 行为有覆盖。
- 运行：health/models/chat/stream smoke 通过。
- 语义：Admin stop/destroy/recover 与 Scheduler 自动动作不冲突。
- 隔离：一个账号操作不会误影响另一个账号。
- 部署：远端 tunnel 部署可重复、可诊断。
- 仓库：临时文件清理，Git 状态清晰。
- 安全：敏感信息不出现在 Git、日志、计划文档中。

# KeyPool 多账号负载均衡方案

参考 QuantumNous/new-api 的路由逻辑，为 KeyPool 设计多 upstream 负载均衡 + 失败重试机制。

## 1. new-api 核心逻辑（参考）

### 1.1 Channel 选择 (`model/ability.go`)
- Ability 表按 `(group, model, channel_id)` 存能力记录
- 关键字段：`priority`（数字越小优先级越高）、`weight`（权重）、`enabled`
- `GetChannel(group, model, retry)` 流程：
  1. 按 group/model/enabled 查询所有候选
  2. retry=0 取最高优先级层，retry>0 按优先级降级
  3. 同一优先级层内做加权随机：`weightSum = Σ(Weight + 10)`，随机数逐个扣减 `(Weight + 10)` 选中 channel
  4. `+10` 让 weight=0 的 channel 也有基础概率，避免饿死

### 1.2 重试机制 (`controller/relay.go`)
- `Relay` 主循环：每轮调用 `getChannel`，成功转发则返回
- 失败后 `processChannelError` 可自动禁用 channel
- `shouldRetry` 决定是否重试，重试时再次调用 `CacheGetRandomSatisfiedChannel`
- 可降级 priority（retry>0 时）

### 1.3 关键特性
- 优先级分层 + 同层加权随机
- 失败重试 + priority 降级
- 自动禁用（连续失败超阈值）
- group 隔离
- channel affinity（同一请求优先用同一 channel）

## 2. KeyPool 当前现状

### 2.1 路由逻辑（`registry.mjs`）
```
getVerifiedUpstreams(model):
  - filter: verified=true, 有连接(proxyUrl/baseUrl/localUrl/tunnel)
  - filter: status ∈ {ACTIVE, DEPLOYED_UNVERIFIED}
  - model 匹配（models 数组为空则通配）
  - sort: priority ASC, lastVerifiedAt DESC
  → 返回排序后的数组

chooseVerifiedUpstream(model):
  - return getVerifiedUpstreams(model)[0]
  → 永远选第一个，没有负载均衡
```

### 2.2 问题
- **单点优选**：永远选 priority 最低 + lastVerifiedAt 最新的那个，另一个 upstream 永远不会被选中
- **healthOk 未参与路由**：`markProxyFailure` 会设 `healthOk=false`，但 `getVerifiedUpstreams` 不检查它
- **无重试**：proxy 失败后直接返回 502，不会换 upstream 重试
- **无加权**：即使有多个同优先级 upstream，也不会轮换

## 3. 设计方案

### 3.1 Registry 扩展

#### 新增字段（per instance state）
```javascript
{
  priority: 100,          // 已有，数字越小优先级越高
  weight: 10,             // 新增，默认 10，同优先级层内加权随机
  healthOk: true,         // 已有，proxy 失败时设 false
  consecutiveFailures: 0, // 已有
  lastUsedAt: null,       // 已有
}
```

#### `getVerifiedUpstreams(model, opts)` 改造
```javascript
getVerifiedUpstreams(model, opts = {}) {
  const { excludeAccountIds = new Set(), includeUnhealthy = false } = opts;
  
  return [...this.instances.values()]
    .filter(s => s && s.verified && (s.proxyUrl || s.baseUrl || s.localUrl || s.tunnel))
    .filter(s => !s.status || ['ACTIVE', 'DEPLOYED_UNVERIFIED'].includes(s.status))
    .filter(s => !excludeAccountIds.has(s.accountId))
    .filter(s => includeUnhealthy || s.healthOk !== false)  // ← 新增
    .filter(s => !model || !Array.isArray(s.models) || s.models.length === 0 || s.models.includes(model))
    .sort((a, b) => {
      const pa = Number.isFinite(a.priority) ? a.priority : 100;
      const pb = Number.isFinite(b.priority) ? b.priority : 100;
      if (pa !== pb) return pa - pb;
      // 同优先级：按 lastVerifiedAt 降序（仅用于稳定排序，不决定选择）
      const va = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) || 0 : 0;
      const vb = b.lastVerifiedAt ? Date.parse(b.lastVerifiedAt) || 0 : 0;
      return vb - va;
    });
}
```

#### `chooseVerifiedUpstream(model, opts)` 改造 — 加权随机
```javascript
chooseVerifiedUpstream(model, opts = {}) {
  const { excludeAccountIds = new Set() } = opts;
  const upstreams = this.getVerifiedUpstreams(model, { excludeAccountIds });
  if (upstreams.length === 0) return null;

  // 按优先级分层
  const topPriority = Number.isFinite(upstreams[0].priority) ? upstreams[0].priority : 100;
  const tier = upstreams.filter(u => {
    const p = Number.isFinite(u.priority) ? u.priority : 100;
    return p === topPriority;
  });

  if (tier.length === 1) return tier[0];

  // 同层加权随机（参考 new-api：weight + 10）
  const BASE_WEIGHT = 10;
  let weightSum = 0;
  const weighted = tier.map(u => {
    const w = (Number.isFinite(u.weight) ? u.weight : 10) + BASE_WEIGHT;
    weightSum += w;
    return { upstream: u, weight: w };
  });

  let rand = Math.random() * weightSum;
  for (const { upstream, weight } of weighted) {
    rand -= weight;
    if (rand <= 0) return upstream;
  }
  return weighted[weighted.length - 1].upstream;
}
```

### 3.2 Proxy 重试逻辑

#### 设计原则
- **transport error（连接断开/超时）**：换 upstream 重试
- **HTTP 5xx**：换 upstream 重试（上游内部错误，可能是该实例问题）
- **HTTP 4xx**：不重试（客户端请求本身有问题）
- **streaming 已开始写 headers**：不能重试（客户端已收到部分响应）
- **最多重试 N 次**：建议 2 次（即总共最多 3 次请求）

#### proxy.mjs 改造（伪代码）
```javascript
async function proxyHandler(req, res, body) {
  const MAX_RETRIES = 2;
  const excludeAccountIds = new Set();
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const upstream = registry.chooseVerifiedUpstream(body.model, { excludeAccountIds });
    if (!upstream) {
      return sendError(res, lastError ? 502 : 503, 
        lastError ? `All upstreams failed: ${lastError}` : 'No healthy upstream available');
    }

    try {
      // 尝试 tunnel → fallback HTTP
      const result = await tryProxyRequest(upstream, body, req, res);
      
      if (result.ok) {
        registry.markProxySuccess(upstream.accountId, result.latencyMs);
        return; // 成功，响应已发送
      }
      
      // 上游返回 HTTP 错误
      registry.markProxyUpstreamError(upstream.accountId, result.status, result.body);
      
      if (result.status >= 500) {
        // 5xx：换 upstream 重试
        excludeAccountIds.add(upstream.accountId);
        lastError = `[${upstream.accountId}] HTTP ${result.status}`;
        continue;
      }
      
      // 4xx：不重试，直接返回
      return sendError(res, result.status, result.body);
      
    } catch (err) {
      // transport error
      registry.markProxyFailure(upstream.accountId, err.message);
      excludeAccountIds.add(upstream.accountId);
      lastError = `[${upstream.accountId}] ${err.message}`;
      continue;
    }
  }
}
```

#### Streaming 重试边界
- **headers 未发送**：可以重试（替换 upstream 重新请求）
- **headers 已发送**：不能重试（客户端已收到 200 + 部分 body）
- 实现：用 `res.headersSent` 判断

### 3.3 healthOk 自动恢复

当前 `markProxyFailure` 设 `healthOk=false`，但没有恢复机制。需要：
- 定时器：每 N 秒检查 `healthOk=false` 的实例，尝试发送轻量 health check
- 或：选择性恢复——如果 `healthOk=false` 但 `lastHealthError` 超过 M 秒，允许在加权随机中以较低权重参与
- 建议：先用简单方案——`healthOk=false` 超过 60s 后自动恢复为 `true`（由下次请求触发）

### 3.4 配置化

accounts.json 中每个 account 支持：
```json
{
  "id": "account-1",
  "priority": 100,
  "weight": 10,
  "enabled": true
}
```

- `priority`：默认 100，数字越小优先级越高
- `weight`：默认 10，同优先级层内加权比例
- `enabled`：默认 true，false 则完全跳过

## 4. 与 new-api 的差异

| 特性 | new-api | KeyPool 方案 |
|------|---------|-------------|
| group 隔离 | ✅ 多 group | ❌ 不需要（单模型池） |
| billing | ✅ 预扣费 | ❌ 不需要 |
| auto-disable | ✅ 连续失败自动禁用 | ⚠️ 简化：healthOk 临时降级 |
| channel affinity | ✅ 同请求同 channel | ❌ 不需要（无状态） |
| priority 降级 | ✅ retry 时降级 | ❌ 暂不需要（upstream 少） |
| 多 key random | ✅ 同 channel 多 key | ❌ 不需要 |

## 5. 实现步骤

1. **Registry 改造**（`src/gateway/registry.mjs`）
   - `getVerifiedUpstreams` 增加 `excludeAccountIds` 和 `healthOk` 过滤
   - `chooseVerifiedUpstream` 实现加权随机
   - 新增 `getHealthyUpstreamCount(model)` 方法

2. **Proxy 重试**（`src/gateway/proxy.mjs`）
   - `proxyHandler` 加入 retry loop
   - transport error / 5xx 换 upstream 重试
   - 4xx 不重试
   - streaming 已开始后不重试

3. **healthOk 恢复**（`src/gateway/registry.mjs`）
   - `markProxyFailure` 记录失败时间
   - `chooseVerifiedUpstream` 中：healthOk=false 超过 60s 的实例以较低权重参与（不完全排除）

4. **测试**（`tests/registry.test.mjs` 新增）
   - 加权随机分布测试
   - excludeAccountIds 过滤测试
   - healthOk 过滤测试
   - 重试逻辑测试

5. **配置支持**
   - accounts.json 支持 `weight` 字段
   - `validateAccountsConfig` 校验

## 6. 风险与注意事项

- **streaming 重试**：已发送 headers 后不能重试，需要 `res.headersSent` 检查
- **幂等性**：重试时 body 已消费，需要确保 body 可重放（当前 body 已解析为 JSON，可直接序列化）
- **并发**：多个请求同时选 upstream，加权随机是无锁的，不保证严格轮换，但统计上均匀
- **healthOk 恢复**：过于激进的恢复可能导致再次失败，需要 cooldown 机制

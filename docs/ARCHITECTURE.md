# KeyPool Architecture

> Generated: 2026-05-12 18:55 CST  
> Repo: `C:\Users\Administrator\.openclaw\workspace\keypool`

## 1. System overview

KeyPool is a local Gateway + Manager system that exposes a unified local API while orchestrating remote MiMo / AI Studio sandbox instances.

```text
Client / SDK / OpenClaw
        |
        | HTTP :9300
        v
+-------------------------------+
| Local KeyPool Gateway          |
| - /v1/chat/completions         |
| - /v1/messages                 |
| - /v1/models                   |
| - /health                      |
| - /admin                       |
| - WS /tunnel                   |
+-------------------------------+
        |                       ^
        | proxy_request         | register / response chunks
        v                       |
+-------------------------------+
| Remote keypool-tunnel skill    |
| running inside MiMo sandbox    |
| - calls MiMo model API         |
| - streams chunks back via WS   |
+-------------------------------+

+-------------------------------+
| Local Manager                  |
| - loads accounts               |
| - creates AccountWorkers       |
| - Scheduler drives lifecycle   |
| - Deployer installs tunnel     |
+-------------------------------+
```

## 2. Main runtime entry

### `bin/app.mjs`

Responsibilities:

1. Read `config.json`.
2. Resolve runtime port/host and public Gateway URLs.
3. Create Gateway.
4. Start Gateway.
5. Create Manager with Gateway registry.
6. Attach Manager back into Gateway admin context.
7. Start Manager.
8. Register SIGINT/SIGTERM shutdown handlers.

Important environment/config inputs:

- `PORT`
- `HOST`
- `ACCOUNTS_PATH`
- `KEYPOOL_PUBLIC_WS_URL`
- `KEYPOOL_GATEWAY_URL`
- `KEYPOOL_PUBLIC_HTTP_BASE`
- `KEYPOOL_GATEWAY_HTTP_BASE`
- `LOCAL_SRC_DIR`
- `config.json`

## 3. Gateway layer

### `src/gateway/index.mjs`

Gateway HTTP router and integration point.

Routes:

- `GET /` and `GET /v1`: metadata.
- `GET /health`: delegated to Admin handler.
- `/admin*`: Admin UI/API.
- `GET /v1/models`: model discovery through verified upstreams.
- `POST /v1/messages`: Anthropic-compatible endpoint; request is converted to OpenAI format.
- `POST /v1/chat/completions`: OpenAI-compatible direct proxy.
- `WS /tunnel`: handled by Tunnel server via HTTP upgrade.

Key dependencies:

- `Registry`
- `createProxyHandler`
- `createAdminHandler`
- `anthropicToOpenAI`, `openAIToAnthropic`, `openAIChunkToAnthropicEvents`
- `createTunnelServer`

Current review notes:

- Anthropic streaming logic currently lives in `index.mjs`; it is a candidate for extraction.
- Current uncommitted diff changes streaming from `PassThrough` to tunnel `onChunk` callback.
- `collectModels()` has fallback behavior that may mask true model discovery failures.

### `src/gateway/proxy.mjs`

OpenAI-compatible proxy handler.

Responsibilities:

1. Parse request body to obtain `model`.
2. Choose verified upstream from Registry.
3. Prefer tunnel transport if available.
4. Fall back to HTTP direct URL if available and tunnel failed before headers were sent.
5. Preserve streaming and non-streaming responses.
6. Mark proxy success/failure in Registry.

Current review notes:

- `markProxyFailure()` currently flips `healthOk=false` for all proxy failures. Business errors and transport failures should be separated.
- If stream headers have already been sent, fallback is impossible; this behavior is correct but needs explicit smoke coverage.

### `src/gateway/tunnel.mjs`

WebSocket server for reverse tunnel connections.

Responsibilities:

1. Handle WS upgrade.
2. Support bootstrap file push mode.
3. Register remote tunnel connections by `accountId` and `runId`.
4. Supersede old runs.
5. Send proxy requests over WS.
6. Receive buffered or chunked proxy responses.
7. Manage pending requests and heartbeat.

Current review notes:

- `pendingRequests` is global; close cleanup correctly filters by `entry.ws`, but needs tests.
- Large superseded run log volume suggests old remote processes may still reconnect.
- `sendProxyRequest()` needs explicit mode contracts: buffered / pipe / callback.

### `src/gateway/registry.mjs`

Runtime view of account/instance states.

Responsibilities:

- Store per-account instance state.
- Provide routeable verified upstreams.
- Select upstream by model and priority.
- Track proxy success/failure metadata.

Current review notes:

- State metadata is split across `status`, `verified`, `healthOk`, `failureType`, etc.
- Registry should remain runtime view; Manager/Scheduler should own lifecycle decisions.

### `src/gateway/admin.mjs`

Admin UI and Admin API.

Responsibilities:

- Render `/admin` UI.
- Expose overview/status/control endpoints.
- Manage accounts config.
- Trigger account actions: `deploy`, `recover`, `destroy`.

Current review notes:

- `destroy` currently calls `worker.api.destroyInstance()`, sets `worker.instance=null`, `worker.state='DESTROYED'`, and registry status `DESTROYED`.
- Scheduler currently treats `DESTROYED` as a creation trigger. This is the main semantic conflict to fix.

## 4. Manager layer

### `src/manager/index.mjs`

Manager factory.

Responsibilities:

1. Load config.
2. Create MiMo API client.
3. Load accounts.
4. Create Deployer.
5. Create AccountWorkers.
6. Create Scheduler.
7. Return manager facade: `start`, `stop`, `workers`, `config`.

### `src/manager/account-worker.mjs`

Single-account lifecycle owner.

Responsibilities:

- Maintain worker state and current instance.
- Create instance.
- Deploy current instance.
- Renew instance.
- Recover deployment.
- Push state updates into Registry.

Current state path:

```text
NONE -> CREATING -> READY -> DEPLOYING -> DEPLOYED_UNVERIFIED -> ACTIVE
ACTIVE -> CREATING    (renew)
... -> FAILED         (create/deploy failure)
```

Current review notes:

- No `PAUSED` / `MANUAL_STOPPED` state yet.
- State updates are not generation guarded; future hardening should ensure old operations cannot overwrite newer states.

### `src/manager/scheduler.mjs`

Periodic lifecycle driver.

Responsibilities:

- Iterate workers.
- Decide action based on worker state and Registry metadata.
- Create/recover/renew/retry as needed.

Important current behavior:

```js
case 'NONE':
case 'DESTROYED':
case 'EXPIRED':
  await worker.create();
```

This means Admin destroy will be auto-recreated on the next scheduler tick. This is useful for lifecycle continuity but conflicts with a human expectation of manual stop/destroy.

### `src/manager/instance.mjs`

MiMo / AI Studio instance API wrapper.

Responsibilities:

- Create instance.
- Destroy instance.
- Get status.
- Parse upstream errors.

Review target:

- Classify upstream errors: auth, resource unavailable, rate limit, network, unknown.

### `src/manager/deployer.mjs` and `deploy-client.mjs`

Remote deployment layer.

Responsibilities:

- Connect to remote sandbox OpenClaw.
- Install or update `keypool-tunnel` skill files.
- Start tunnel proxy.
- Wait for deployment confirmation.
- Return deploy metadata.

Current review notes:

- Deployer has markers like `KEYPOOL_TUNNEL_CREATED_*` and `KEYPOOL_TUNNEL_STARTED_*`.
- AccountWorker already treats tunnel registration as verified if it arrives before deploy returns.
- Need to make deploy success criteria explicit and documented: marker, tunnel registration, smoke.

## 5. Scripts and docs

### Existing scripts

- `scripts/start-keypool-bg.ps1`
- `scripts/status-keypool-bg.ps1`
- `scripts/stop-keypool-bg.ps1`
- `scripts/init-gitee.sh`

Current issue:

- `status-keypool-bg.ps1` reports both pid file and port owner, but pid file can be stale. This should be made explicit in output.

### New review docs

- `docs/KEYPOOL_REVIEW_OPTIMIZATION_PLAN_20260512.md`
- `docs/review/00-baseline.md`
- `docs/review/untracked-files.md`
- `docs/review/current-stream-tunnel-diff.patch`

## 6. High-risk architecture seams

1. Admin action semantics vs Scheduler automation.
2. Tunnel stream mode contracts.
3. Registry health updates mixing transport and upstream business errors.
4. Remote deploy success criteria.
5. PID/status script mismatch.
6. Untracked temporary files hiding important diagnostics.

## 7. Immediate next design decisions

1. Should Admin `destroy` mean “destroy and allow scheduler recreate”, or should it become “manual stop”?
2. Should we add separate actions: `stop`, `destroy`, `recover`?
3. Should stream tunnel callback mode reject `res` to prevent double write?
4. Should Registry expose a typed status snapshot for Admin instead of raw mutable state?

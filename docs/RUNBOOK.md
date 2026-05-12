# KeyPool Runbook

> Operational checklist for starting, stopping, verifying, and debugging KeyPool.

## Quick status

```powershell
cd C:\Users\Administrator\.openclaw\workspace\keypool
.\scripts\status-keypool-bg.ps1
```

Important fields:

- `port9300Listening`: whether Gateway is listening
- `authoritativePid`: PID actually listening on 9300
- `stalePidFile`: whether `.keypool-bg.pid` is stale
- `health`: raw `/health` response

If `stalePidFile=true`, trust `authoritativePid` over `.keypool-bg.pid`.

## Start

```powershell
cd C:\Users\Administrator\.openclaw\workspace\keypool
.\scripts\start-keypool-bg.ps1
```

Force restart:

```powershell
.\scripts\start-keypool-bg.ps1 -ForceRestart
```

## Stop

```powershell
cd C:\Users\Administrator\.openclaw\workspace\keypool
.\scripts\stop-keypool-bg.ps1
```

If the PID file is stale but port 9300 is still listening, identify the real owner:

```powershell
Get-NetTCPConnection -LocalPort 9300 -State Listen | Select-Object LocalPort,OwningProcess
```

Then stop only if you have confirmed it is KeyPool:

```powershell
Stop-Process -Id <pid> -Force
```

## Smoke test

Full smoke:

```powershell
.\scripts\smoke-keypool.ps1
```

Skip chat:

```powershell
.\scripts\smoke-keypool.ps1 -SkipChat
```

Skip stream:

```powershell
.\scripts\smoke-keypool.ps1 -SkipStream
```

Expected full smoke checks:

- `port-listener`
- `health`
- `models`
- `openai-chat-non-stream`
- `anthropic-messages-non-stream`
- `openai-chat-stream`
- `anthropic-messages-stream`

## Common issues

### No healthy upstream available

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:9300/health
Invoke-RestMethod http://127.0.0.1:9300/v1/models
```

Possible causes:

- Gateway is stopped.
- No verified remote tunnel is connected.
- Remote MiMo resource is unavailable.
- Account is `MANUAL_STOPPED` or `PAUSED`.

### `/v1/models` times out

Retry once with a longer timeout:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9300/v1/models -TimeoutSec 20
```

If transient, rerun smoke. If persistent, inspect Gateway logs for `collectModels` warnings.

### Old runId reconnect spam

Likely old remote tunnel processes are still running.

Recommended deploy-side cleanup before starting a new tunnel:

```bash
pkill -f "keypool-tunnel/scripts/tunnel-proxy.mjs" || true
pkill -f "tunnel-proxy.mjs" || true
```

Do this only inside the target remote sandbox context.

### Admin stop vs destroy

Current intended semantics:

- `stop`: manual stop; account should become `MANUAL_STOPPED`; scheduler must not recreate it.
- `destroy`: destroy current instance; current explicit behavior may allow scheduler to recreate `DESTROYED` accounts.
- `recover`: return account to an active/deployable path.

Use `stop` when you want to prevent automatic recreation.

## Validation commands

Unit/integration tests:

```powershell
npm test
```

Current expected result:

```text
42/42 pass
```

Full runtime smoke:

```powershell
.\scripts\smoke-keypool.ps1
```

## Logs

Background logs:

- `.keypool-bg.out.log`
- `.keypool-bg.err.log`

When debugging request failures, look for `x-keypool-request-id` / `requestId=` in logs.

## Safety

- Do not commit `accounts.json`, `.cookie`, or real tokens.
- Do not paste cookies/tokens into docs, examples, or issue logs.
- Prefer `trash` or archive moves over irreversible deletion when cleaning the repository.

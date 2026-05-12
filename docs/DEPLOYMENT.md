# KeyPool Deployment Guide

> Goal: make remote tunnel deployment repeatable, diagnosable, and safe.

## Overview

KeyPool deploys a `keypool-tunnel` skill into each remote MiMo / AI Studio sandbox. The remote skill starts a WebSocket tunnel back to the local Gateway.

```text
Local KeyPool Manager
  └─ DeployClient chat prompts
      └─ Remote OpenClaw sandbox
          └─ ~/.openclaw/skills/keypool-tunnel/scripts/tunnel-proxy.mjs
              └─ ws(s)://<public-gateway>/tunnel?accountId=...&runId=...
```

## Required local files

- `config.json` — local runtime/deploy config. Do not commit.
- `accounts.json` — account list and cookie references. Do not commit.
- `skill/` — tunnel skill source files copied to remote sandbox.

Examples:

- `config.example.json`
- `accounts.example.json`

## Required config fields

Recommended fields in `config.json`:

```json
{
  "port": 9300,
  "host": "0.0.0.0",
  "deployRepo": "https://github.com/qindinp/keypool.git",
  "publicWsUrl": "wss://your-public-host.example.com/tunnel",
  "publicHttpBase": "https://your-public-host.example.com",
  "checkInterval": 60,
  "renewBefore": 300,
  "maxRetries": 5,
  "retryBaseDelay": 5000,
  "retryMaxDelay": 60000,
  "chatTimeout": 120000,
  "wsConnectTimeout": 30000,
  "deployTimeout": 300000,
  "readyTimeout": 180000
}
```

Do not put real cookies or tokens into example files or documentation.

## Deployment stages

The deployer should be understood as four stages.

### 1. install

Create remote directories and write the tunnel skill files:

- `SKILL.md`
- `scripts/tunnel-proxy.mjs`
- `scripts/lib/ws-client.mjs`
- `scripts/lib/api-handler.mjs`

Implementation notes:

- Small files use heredoc prompts.
- Large files use base64 chunk prompts.
- Each write is verified before proceeding.

### 2. start

Start the remote tunnel proxy in the background.

Current process target:

```text
/root/.openclaw/skills/keypool-tunnel/scripts/tunnel-proxy.mjs
```

The process connects back to:

```text
<publicWsUrl>?accountId=<accountId>&runId=<runId>
```

### 3. connect

The Gateway receives a tunnel `register` message.

This is the most important deploy success signal. If the remote process starts but the Gateway never sees a tunnel register, routing will not work.

### 4. verify

Verify local Gateway state:

```powershell
Invoke-RestMethod http://127.0.0.1:9300/health
Invoke-RestMethod http://127.0.0.1:9300/v1/models
.\scripts\smoke-keypool.ps1
```

Expected:

- `/health.status == "ok"`
- `verifiedInstances > 0`
- `/v1/models` returns at least one model
- OpenAI and Anthropic non-stream/stream smoke checks pass

## Old tunnel cleanup

Before starting a new remote tunnel for the same account, the deploy flow should stop old tunnel processes where possible. Otherwise the old process may continue reconnecting with a superseded `runId`, causing noisy logs.

Recommended remote cleanup command pattern:

```bash
pkill -f "keypool-tunnel/scripts/tunnel-proxy.mjs" || true
pkill -f "tunnel-proxy.mjs" || true
```

This should be executed before the new `start` stage, but only inside the remote sandbox context for the target account.

## Success criteria

A deployment is successful only when all are true:

1. Skill files were written and verified.
2. Remote process start command completed.
3. Gateway observed tunnel registration for the target `accountId` and current `runId`.
4. The instance becomes routable (`verified=true`, status `ACTIVE` or equivalent).
5. A minimal chat smoke request can complete through the Gateway.

## Failure classification

| Type | Meaning | Retry? |
|------|---------|--------|
| `timeout` | deploy prompt or tunnel connection timed out | yes |
| `refused` | remote assistant refused command / safety policy | no, needs prompt change |
| `disconnected` | websocket/session disconnected | yes |
| `upstream_unavailable` | MiMo / ticket / resource unavailable | later |
| `unknown` | other failures | depends |

## Security rules

- Never commit `accounts.json`, `.cookie`, real cookies, or real tokens.
- Do not include real token values in `config.example.json`.
- Prefer `cookieFile` references over inline cookies when possible.
- Logs and docs should use account IDs, not secret values.

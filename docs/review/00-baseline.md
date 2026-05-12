# KeyPool Phase 0 Baseline

> Generated: 2026-05-12 18:48 CST  
> Repo: `C:\Users\Administrator\.openclaw\workspace\keypool`  
> Scope: safety baseline before comprehensive review/optimization. No business code changed during capture.

## 1. Git status

```text
## main...origin/main [ahead 21]
 M src/gateway/index.mjs
 M src/gateway/tunnel.mjs
?? .artifact-stage/
?? .keypool-bg.pid
?? _diag_connect.mjs
?? _start_detached.mjs
?? _tmp_check_9300.ps1
?? _tmp_check_status.mjs
?? _tmp_detached_start_keypool.ps1
?? _tmp_file_envelope_message.json
?? _tmp_hard_reset_keypool.ps1
?? _tmp_kill_9300.ps1
?? _tmp_kill_keypool_related.ps1
?? _tmp_network_probe_message.json
?? _tmp_recreate_and_test_file_envelope.mjs
?? _tmp_recreate_and_test_raw_message.mjs
?? _tmp_reset_funnel_logs.ps1
?? _tmp_run_keypool_funnel.ps1
?? _tmp_start_envelope_message.json
?? _tmp_start_keypool_with_funnel.ps1
?? _tmp_start_keypool_with_funnel_bg.ps1
?? _tmp_test.json
?? _tmp_test.mjs
?? _tmp_test2.mjs
?? _tmp_test3.mjs
?? _tmp_test_admin_overview.ps1
?? _tmp_test_chat.ps1
?? _tmp_test_file_envelope.mjs
?? _tmp_test_health.ps1
?? _tmp_test_models.ps1
?? _tmp_ts_test.mjs
?? console.error(e))
?? dist/keypool-tunnel/LICENSE
?? docs/KEYPOOL_REVIEW_OPTIMIZATION_PLAN_20260512.md
?? keypool-agent-bundle_20260508.zip
?? keypool-tunnel-skill.zip
?? runtime-monitor/
?? {console.error(e.message)
?? {console.log(JSON.stringify(Object.keys(cfg)))
```

## 2. Diff stat

```text
src/gateway/index.mjs  | 63 +++++++++++++++++++++++++++++++-------------------
src/gateway/tunnel.mjs | 39 +++++++++++++++++++++++--------
2 files changed, 69 insertions(+), 33 deletions(-)
```

Current uncommitted source changes are concentrated in Gateway Anthropic streaming and Tunnel chunk handling. Preserve before edits.

## 3. Recent commits

```text
ce06bea fix(ws-client): stop reconnect on superseded error from Gateway
42da9dc fix(tunnel): guard entry.res calls with typeof checks
3e611f6 fix(deploy): use per-account deploy queues
31ed002 fix(manager): restore sleep helper accidentally removed
7baf81f fix(deploy): use public gateway URL and workspace path in start prompt
18a1809 fix(deploy): use conversational gitee install prompt
d5d5694 chore(config): clear unused gitee token
f26495b fix(deploy): remove token from gitee clone prompt
484bfc5 fix(gateway): return default models when discovery is empty
1a9f966 fix(gateway): make /v1 return endpoint metadata
```

## 4. Branches / remotes

```text
backup/main-before-sync-20260509 44d49b6 docs: update public-link and skill-proxy routing notes
* main                            ce06bea [origin/main: ahead 21] fix(ws-client): stop reconnect on superseded error from Gateway

origin https://github.com/qindinp/keypool.git (fetch)
origin https://github.com/qindinp/keypool.git (push)
```

## 5. Runtime state

### PID / port

- `.keypool-bg.pid`: `15612`
- Actual process listening on `0.0.0.0:9300`: PID `8692`
- Process: `node`
- Path: `C:\Program Files\QClaw\resources\node\node.exe`
- StartTime: `2026/05/12 18:28:27`

Conclusion: `.keypool-bg.pid` appears stale and should be fixed in script hardening phase.

### 9300 connections

Observed established local connections and a listener:

```text
Listen      0.0.0.0:9300    OwningProcess=8692
Established 127.0.0.1:9300  OwningProcess=8692
```

## 6. Smoke checks

### `/health`

```json
{
  "status": "ok",
  "agents": 0,
  "verifiedInstances": 2,
  "deployingInstances": 0,
  "failedInstances": 0
}
```

### `/v1/models`

Returned MiMo model list successfully, including:

- `mimo-v2-flash`
- `mimo-v2-omni`
- `mimo-v2-pro`
- `mimo-v2-tts`
- `mimo-v2.5`
- `mimo-v2.5-pro`
- `mimo-v2.5-tts`
- `mimo-v2.5-tts-voiceclone`
- `mimo-v2.5-tts-voicedesign`

### OpenAI non-stream chat

Request: `POST http://127.0.0.1:9300/v1/chat/completions`

Payload summary:

```json
{
  "model": "mimo-v2.5-pro",
  "messages": [{"role": "user", "content": "baseline ping"}],
  "stream": false,
  "max_tokens": 16
}
```

Result: success. Response had `finish_reason=length`, `model=mimo-v2.5-pro`, and returned `reasoning_content`; `content` was `null` because max tokens were intentionally tiny.

## 7. Test command status

`npm test` currently fails because `tests/` does not exist:

```text
> keypool@3.0.0 test
> node --test tests/

Could not find 'tests/'
```

This confirms Phase 2 needs to add the test directory and initial tests.

## 8. Log observations

Recent output log repeatedly shows account-1 tunnel connections with the same old run id:

```text
[tunnel] remote connected accountId=account-1 runId=account-1-mp1pvubz
```

Recent error log repeatedly shows superseded old run rejection:

```text
[tunnel:account-1] rejected superseded old runId=account-1-mp1pvubz
```

Note: console rendering shows mojibake in the current terminal output, but the semantic pattern is clear. This remains a review target for log encoding and superseded-run noise reduction.

## 9. Immediate conclusions

1. Runtime is currently usable: health/models/non-stream chat are passing.
2. Test suite is absent.
3. PID file is stale.
4. Current source diff should be protected before modifying stream/tunnel code.
5. Untracked files need classification before any cleanup.
6. Next recommended step: create `scripts/smoke-keypool.ps1` and start Phase 1 architecture/state-machine docs, then implement P0 fixes with tests.

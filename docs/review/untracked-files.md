# KeyPool Untracked Files Review

> Generated: 2026-05-12 18:48 CST  
> Repo: `C:\Users\Administrator\.openclaw\workspace\keypool`

This document classifies current untracked files before cleanup. Do not delete files until the classification is reviewed.

## 1. Newly generated review docs

Keep and commit after review:

```text
docs/KEYPOOL_REVIEW_OPTIMIZATION_PLAN_20260512.md
```

Expected next generated files:

```text
docs/review/00-baseline.md
docs/review/untracked-files.md
```

## 2. Runtime state / logs

Likely should not be committed; add or confirm `.gitignore` coverage.

```text
.keypool-bg.pid
.keypool-bg.err.log
.keypool-bg.out.log
.controller.log
.tmp_admin_restart.err.log
.tmp_admin_restart.out.log
.tmp_deploy_fix_restart.err.log
.tmp_deploy_fix_restart.out.log
_tmp_gateway.err.log
_tmp_gateway.out.log
```

Notes:

- `.keypool-bg.pid` is stale: file contains `15612`, actual port 9300 listener is PID `8692`.
- Logs are useful for local diagnosis but should generally stay out of Git.

## 3. Temporary diagnostics scripts and payloads

Likely delete or migrate selected useful scripts into `scripts/diagnostics/`.

```text
_diag_connect.mjs
_start_detached.mjs
_tmp_check_9300.ps1
_tmp_check_status.mjs
_tmp_detached_start_keypool.ps1
_tmp_file_envelope_message.json
_tmp_hard_reset_keypool.ps1
_tmp_kill_9300.ps1
_tmp_kill_keypool_related.ps1
_tmp_network_probe_message.json
_tmp_recreate_and_test_file_envelope.mjs
_tmp_recreate_and_test_raw_message.mjs
_tmp_reset_funnel_logs.ps1
_tmp_run_keypool_funnel.ps1
_tmp_start_envelope_message.json
_tmp_start_keypool_with_funnel.ps1
_tmp_start_keypool_with_funnel_bg.ps1
_tmp_test.json
_tmp_test.mjs
_tmp_test2.mjs
_tmp_test3.mjs
_tmp_test_admin_overview.ps1
_tmp_test_chat.ps1
_tmp_test_file_envelope.mjs
_tmp_test_health.ps1
_tmp_test_models.ps1
_tmp_ts_test.mjs
```

Potentially useful to preserve as formal scripts:

- `_tmp_test_health.ps1` → `scripts/diagnostics/test-health.ps1` or replaced by `scripts/smoke-keypool.ps1`
- `_tmp_test_models.ps1` → covered by smoke script
- `_tmp_test_chat.ps1` → covered by smoke script
- `_tmp_check_9300.ps1` → covered by status script
- `_tmp_kill_keypool_related.ps1` / `_tmp_hard_reset_keypool.ps1` → keep only if a documented recovery runbook needs them

## 4. Artifact/build staging

Needs decision whether source of truth is tracked.

```text
.artifact-stage/README.txt
.artifact-stage/bin/agent.mjs
.artifact-stage/package.json
dist/keypool-tunnel/LICENSE
keypool-agent-bundle_20260508.zip
keypool-tunnel-skill.zip
```

Recommendation:

- Do not commit zip artifacts unless release artifacts are intentionally versioned.
- Decide whether `.artifact-stage/` is local build output and add to `.gitignore` if so.
- `dist/keypool-tunnel/LICENSE` is untracked while other dist files may be tracked/ignored; inspect before deciding.

## 5. Runtime monitor outputs

Likely local diagnostic artifacts. Either move scripts to `scripts/diagnostics/` and ignore generated JSON, or ignore entire `runtime-monitor/`.

```text
runtime-monitor/e2e-funnel-meta-20260508154153.json
runtime-monitor/e2e-funnel-meta-20260508154331.json
runtime-monitor/e2e-funnel-meta-20260508155926.json
runtime-monitor/e2e-funnel-meta-20260508160129.json
runtime-monitor/e2e-funnel-meta-20260508160758.json
runtime-monitor/e2e-funnel-meta-20260508160959.json
runtime-monitor/e2e-funnel-meta-20260508161107.json
runtime-monitor/e2e-funnel-meta-20260508161732.json
runtime-monitor/e2e-funnel-meta-20260508161859.json
runtime-monitor/e2e-funnel-meta-20260508163527.json
runtime-monitor/e2e-funnel-meta-20260508163610.json
runtime-monitor/e2e-funnel-meta-20260508172338.json
runtime-monitor/e2e-funnel-meta-20260508172425.json
runtime-monitor/e2e-funnel-meta-20260508172812.json
runtime-monitor/e2e-funnel-meta-20260508172905.json
runtime-monitor/monitor-keypool-host.ps1
runtime-monitor/start-keypool-detached.ps1
```

Recommendation:

- JSON e2e metadata: ignore or archive outside repo.
- `monitor-keypool-host.ps1` and `start-keypool-detached.ps1`: inspect; if useful, migrate to `scripts/diagnostics/` or `scripts/`.

## 6. Accidental malformed empty files

Likely safe to remove after confirmation. They appear to be zero-byte accidental shell/PowerShell quoting artifacts.

```text
console.error(e))
{console.error(e.message)
{console.log(JSON.stringify(Object.keys(cfg)))
```

Recommendation: remove during Phase 6 cleanup after baseline commit or patch backup.

## 7. Suggested cleanup policy

Before deleting anything:

1. Commit/backup review docs and source diff.
2. Create/confirm `.gitignore` entries for logs, pid, temp scripts, zip artifacts, runtime metadata.
3. Migrate any useful diagnostics into stable script names.
4. Delete malformed empty files and obsolete `_tmp_*` files.
5. Re-run health/models/chat smoke.

## 8. Proposed `.gitignore` additions to consider

```gitignore
# local runtime state
.keypool-bg.pid
*.log
*.err.log
*.out.log

# local diagnostics / temporary files
_tmp_*
_diag_*.mjs
_start_detached.mjs
console.error(e))
{console.error(e.message)
{console.log(JSON.stringify(Object.keys(cfg)))

# local build/release artifacts
.artifact-stage/
*.zip

# runtime monitor generated metadata
runtime-monitor/*.json
```

Do not apply this blindly; first check whether any existing tracked files match these patterns.

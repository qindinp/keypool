# KeyPool State Machine

> Generated: 2026-05-12 18:55 CST  
> Repo: `C:\Users\Administrator\.openclaw\workspace\keypool`

## 1. Current implemented states

Observed in source comments and scheduler/worker logic:

- `NONE`
- `CREATING`
- `READY`
- `DEPLOYING`
- `DEPLOYED_UNVERIFIED`
- `ACTIVE`
- `RECOVERING`
- `FAILED`
- `EXPIRED`
- `DESTROYED`

Proposed new manual-control states:

- `PAUSED`
- `MANUAL_STOPPED`

## 2. Current lifecycle graph

```text
NONE
  |
  | scheduler -> worker.create()
  v
CREATING
  |
  | createInstance success
  v
READY
  |
  | deployCurrentInstance()
  v
DEPLOYING
  |
  | deploy result verified OR tunnel already connected
  v
ACTIVE

DEPLOYING
  |
  | deploy completed but no tunnel yet
  v
DEPLOYED_UNVERIFIED
  |
  | tunnel register observed
  v
ACTIVE

ACTIVE
  |
  | renew threshold reached
  v
CREATING

ANY create/deploy path
  |
  | failure
  v
FAILED
  |
  | scheduler retry/recover after cooldown if retryable
  v
CREATING or RECOVERING

EXPIRED / DESTROYED
  |
  | scheduler currently recreates
  v
CREATING
```

## 3. Scheduler current behavior by state

| State | Current scheduler action | Review notes |
|---|---|---|
| `NONE` | `worker.create()` | OK for initial bootstrap. |
| `DESTROYED` | `worker.create()` | High-risk conflict with Admin destroy expectation. |
| `EXPIRED` | `worker.create()` | Reasonable if expiry is automatic. |
| `CREATING` | no-op | Wait. |
| `DEPLOYING` | no-op | Wait. |
| `RECOVERING` | no-op | Wait. |
| `READY` | status check, renew check | May redeploy/recover depending metadata. |
| `DEPLOYED_UNVERIFIED` | mark active if tunnel exists; otherwise status/renew; recover after timeout | Good direction; needs tests. |
| `ACTIVE` | require verified/healthOk; check tunnel or HTTP status; renew | Good direction; business vs transport errors need refinement. |
| `FAILED` | retry based on `failureType`, `retryable`, cooldown | Needs explicit backoff and classification tests. |

## 4. Admin action current behavior

### `deploy`

Current behavior:

```text
admin deploy -> worker.create()
```

Effect:

- Creates new instance.
- Deploys tunnel if deployer exists.
- May overwrite current lifecycle if called while another operation is active.

Review target:

- Should be operation-guarded per account.
- Should maybe mean “create/recreate from scratch”.

### `recover`

Current behavior:

```text
admin recover -> worker.recover()
```

Effect:

- Sets state `RECOVERING`.
- Calls deployer for current instance.
- If recover fails, current code sets state `CREATING` and calls `create()`.

Review target:

- Recover failure currently escalates to full recreate. This should be intentional and documented.

### `destroy`

Current behavior:

```text
admin destroy -> worker.api.destroyInstance(cookie)
              -> worker.instance = null
              -> worker.state = 'DESTROYED'
              -> registry.status = 'DESTROYED'
```

Then scheduler behavior:

```text
DESTROYED -> worker.create()
```

Risk:

- Human-triggered destroy is followed by automatic recreation.
- On a platform with account/slot coupling, this may indirectly affect another active account.
- This matches recent user-observed risk: destroying one account may disturb another account.

## 5. Proposed explicit states

### `MANUAL_STOPPED`

Meaning:

- Human explicitly stopped this account.
- Scheduler must not auto-create or recover.
- Gateway must not route traffic to it.
- Recover/start action is required to leave this state.

Suggested entry actions:

- Admin `stop` or redefined Admin `destroy`.
- Destroy remote instance if present.
- Clear tunnel reference.
- Set `verified=false`, `healthOk=false`.
- Set `retryable=false` or equivalent scheduler guard.

Suggested scheduler behavior:

```text
MANUAL_STOPPED -> no-op
```

Suggested exit actions:

```text
admin recover/start -> NONE or CREATING -> create/deploy
```

### `PAUSED`

Meaning:

- Temporarily disabled without necessarily destroying remote instance.
- Scheduler no-op.
- Gateway should not route.

Potential distinction from `MANUAL_STOPPED`:

- `PAUSED`: leave remote resources as-is.
- `MANUAL_STOPPED`: remote instance is destroyed/stopped.

Recommendation:

- Start with only `MANUAL_STOPPED` to keep semantics simple.
- Add `PAUSED` only if UI needs “disable routing but keep remote instance”.

## 6. Proposed revised Admin actions

| Action | Proposed meaning | Scheduler behavior after action |
|---|---|---|
| `deploy` | Force create/recreate and deploy | Active lifecycle resumes. |
| `recover` | Re-deploy current instance or create if missing | Active lifecycle resumes. |
| `stop` | Destroy remote instance and prevent auto-recreate | State `MANUAL_STOPPED`, scheduler no-op. |
| `destroy` | Either alias to `stop`, or reserve for “destroy but allow recreate” | Needs UX decision. |

Recommended compatibility approach:

1. Add new explicit `/admin/api/accounts/:id/stop`.
2. Keep existing `destroy`, but decide one of:
   - Safer: make `destroy` an alias of `stop`.
   - Backward-compatible lifecycle: keep `destroy` as destroy-and-recreate, but rename UI button and add warning.

Given the recent incident, safer default is: `destroy` should behave as manual stop unless the UI explicitly says “recreate”.

## 7. Proposed final scheduler action table

| State | Scheduler action |
|---|---|
| `NONE` | create |
| `CREATING` | wait |
| `READY` | deploy/status/renew logic |
| `DEPLOYING` | wait |
| `DEPLOYED_UNVERIFIED` | if tunnel connected mark ACTIVE; else recover after timeout unless refused |
| `ACTIVE` | routeable; verify tunnel/health; renew near expiry |
| `RECOVERING` | wait |
| `FAILED` | retry/recover if retryable and cooldown elapsed |
| `EXPIRED` | create |
| `DESTROYED` | do not use for human stop, or treat as create only for automatic lifecycle destruction |
| `MANUAL_STOPPED` | no-op |
| `PAUSED` | no-op |

## 8. Invariants to test

1. `MANUAL_STOPPED` never calls `worker.create()` from scheduler.
2. Admin `stop` clears routeability: `verified=false`, no tunnel route.
3. Admin `recover` exits manual stop and creates/deploys.
4. `DESTROYED` behavior is explicitly chosen and tested.
5. `FAILED` with `retryable=false` never retries.
6. `FAILED` with `failureType=refused` never retries automatically.
7. `DEPLOYED_UNVERIFIED` with live tunnel becomes `ACTIVE`.
8. Closing an old tunnel does not clear pending requests for a different live tunnel.

## 9. P0 implementation outline

1. Add a worker method, for example `manualStop()`:

```js
async manualStop() {
  try { await this.api.destroyInstance(this.account.cookie); } catch (err) { ... }
  this.instance = null;
  this.setState('MANUAL_STOPPED', {
    verified: false,
    healthOk: false,
    tunnel: null,
    retryable: false,
    failureType: 'manual_stop',
    lastManualStopAt: new Date().toISOString(),
  });
}
```

2. Add scheduler cases:

```js
case 'MANUAL_STOPPED':
case 'PAUSED':
  break;
```

3. Add Admin route/action for `stop`; decide whether `destroy` aliases to it.
4. Add tests for scheduler no-op and admin action semantics.

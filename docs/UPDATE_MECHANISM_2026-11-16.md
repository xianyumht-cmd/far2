# Update mechanism — why it was unusable and how it works now

## Observed state before the deployment

`GET /api/admin/update/status` on the running instance returned:

```json
{"capability":{"supported":false,"mode":"source","reason":"checkout_main_required"},
 "currentVersion":"2.3.2","branch":"dev/fr3gb"}
```

`release-updater.js#capability()` refuses in this order:

| # | Condition | reason | Old production | New deployment |
|---|---|---|---|---|
| 1 | packaged build (`process.pkg`) | `packaged_release_updater_not_configured` | no | no |
| 2 | Docker runtime | `docker_requires_external_orchestrator` | no | no |
| 3 | **no `.git` in the project root** | `git_checkout_required` | **YES — the old tree was a copied export, never a clone** | no (it is a real clone) |
| 4 | current branch ≠ update branch | `checkout_main_required` | — | yes, because the branch was hard-coded to `main` |
| 5 | origin is not `xianyumht-cmd/far2` | `update_origin_rejected` | — | no, origin is correct |
| 6 | Windows: no `FAR2Farm` service | `automatic_restart_not_available` | — | yes, this host is launcher-started, not an NSSM service |

So the one-click update was unusable for **two independent reasons**: the deployment had no Git metadata at
all, and even a clone could not be updated unless it sat on `main` **and** ran as an NSSM service.

## What changed in this commit

`core/src/services/release-updater.js`:

1. **`UPDATE_BRANCH` is now configurable**
   `const UPDATE_BRANCH = String(process.env.FAR2_UPDATE_BRANCH || 'main').trim() || 'main';`
   A deployment that tracks a long-lived dev branch can set `FAR2_UPDATE_BRANCH=dev/fr3gb` and use the
   built-in updater (`fetch` → `merge --ff-only` → `pnpm install --frozen-lockfile` → `pnpm verify`)
   instead of copying the directory again.
2. **Launcher-started deployments keep the update path**
   When no Windows service is registered, the transport now reports
   `{supported:true, executionMode:'manual_restart', reason:'manual_restart_required', autoRestart:false}`
   instead of refusing. The update runs, verifies, and then asks the operator to restart; nothing is
   auto-killed. Service-based deployments keep the existing `windows_task` behaviour unchanged.

## How to use it on this machine

```powershell
# 1) tell the instance to follow the dev branch (persist it in the launcher environment)
$env:FAR2_UPDATE_BRANCH = 'dev/fr3gb'

# 2) restart once so the value is picked up, then:
#    POST /api/admin/update/check   (async)
#    GET  /api/admin/update/status  (phase/stage/lastError)
#    POST /api/admin/update/apply   (async, fast-forward only)
```

Rollback inside the updater: `performUpdate()` records `previousSha` and calls `rollback()` if the
fast-forward, install, or verify step fails; the state file then reports `phase:"rolled_back"` with the
restored SHA. A diverged local branch is refused with `update_non_fast_forward` rather than merging.

## Remaining limitation

`apply` runs `pnpm verify` (build + tests) inside the live process, which takes minutes; during that time
the farm keeps running on the old code until the operator restarts. That is the intended trade-off for a
launcher-started host without a service supervisor.

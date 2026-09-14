# FAR2 WebUI one-click update

FAR2 2.3.0 adds an administrator-only **升级** page for source deployments on Windows.

## Supported production path

The supported Windows layout is:

- FAR2 source checkout is on branch `main`.
- `origin` is the canonical `xianyumht-cmd/far2` GitHub repository.
- FAR2 WebUI runs under the existing NSSM service (default `FAR2Farm`, LocalSystem).
- A hidden Windows Scheduled Task (default `FAR2UpdateAgent`) runs update work as the interactive Windows user.
- That Windows user must already be able to read the private FAR2 repository with Git without an interactive credential prompt.

The split is intentional: the FAR2 service stays LocalSystem, while private-repository Git authentication remains in the Windows user's existing Git credential context. No GitHub PAT is copied into the FAR2 service environment.

## One-time enablement

After FAR2 2.3.0 is present in the local `main` checkout, run:

```text
install-webui-update.cmd
```

The installer:

1. requires elevation;
2. verifies the checkout is clean and on `main`;
3. verifies the Git remote is the canonical FAR2 repository;
4. performs a non-interactive `git ls-remote` preflight as the current Windows user;
5. registers the hidden `FAR2UpdateAgent` scheduled task with `Interactive` logon and highest available privileges;
6. records `FAR2_UPDATE_TASK_NAME` and `FAR2_SERVICE_NAME` in the existing NSSM service environment without removing existing variables;
7. restarts FAR2 so the WebUI sees the Update Agent configuration.

After successful installation, log in to WebUI as an administrator and open **升级**. The page should report **可一键升级**.

## Check-update path

**检查更新** is asynchronous. The LocalSystem WebUI does not fetch the private repository itself.

1. WebUI validates admin access, source checkout, `main`, official origin, clean tracked worktree, NSSM service, and Update Agent task.
2. It writes a constrained `check` request to `core/data/update-state.json`.
3. It starts `FAR2UpdateAgent` through Task Scheduler.
4. The Update Agent runs under the interactive Windows user and fetches only `origin/main`.
5. FAR2 verifies local HEAD is an ancestor of `origin/main`; diverged history is rejected.
6. The page polls update state and shows version, target SHA, and up to 20 new commits.

If the scheduled task does not begin within 45 seconds, the operation fails instead of remaining permanently queued.

## Apply-update path

**一键升级** uses the same Update Agent and is fail-closed:

1. fetch canonical `origin/main`;
2. require fast-forward history;
3. record the previous commit SHA;
4. `git merge --ff-only origin/main`;
5. `pnpm install --frozen-lockfile`;
6. run the canonical full `pnpm verify` gate;
7. verify final HEAD equals the fetched target SHA;
8. only after successful verification, mark restart pending and terminate the old FAR2 Node process;
9. NSSM restarts FAR2, and the new process marks the update completed after verifying it is running the expected target SHA.

If installation or verification fails after the source switch, FAR2 automatically resets to the previous SHA, reinstalls the locked dependencies, rebuilds the WebUI, and reports the rollback result.

## Safety boundaries

The WebUI never accepts a caller-supplied repository URL, branch, shell command, target SHA, or executable path. Update source is fixed to canonical `origin/main`.

Tracked local modifications block automatic update. Docker deployments are explicitly unsupported by this source updater because application code is baked into the image and only data is persistent. Packaged `pkg` executables are also blocked until a signed release-asset updater exists.

## Troubleshooting

If WebUI shows **尚未安装 Windows Update Agent**, run `install-webui-update.cmd` once from the interactive Windows user that has access to the private FAR2 repository.

If it shows **Windows Update Agent 计划任务不可用**, rerun the installer to repair the task and NSSM environment entry.

Update Agent diagnostics are appended to:

```text
core/data/update-agent.log
```

The persisted state machine is stored in:

```text
core/data/update-state.json
```

## Interrupted update recovery

The Update Agent records its PID and start time. If FAR2 observes an active check/update/rollback state but the worker no longer exists (or exceeds the scheduled-task runtime ceiling), the state is no longer left permanently busy.

- interruption before the source switch becomes `interrupted` and can be retried normally
- interruption after a rollback point exists becomes `recovery_required`
- the next `一键升级` first hard-resets to the recorded previous verified commit, reinstalls the frozen dependency graph, rebuilds the WebUI, verifies the restored SHA, and only then retries the normal update transaction
- `检查更新` is blocked while recovery is required so it cannot hide an incomplete prior transaction
- automatic recovery never deletes arbitrary untracked user files

## Restart session and bootstrap health

FAR2 authentication tokens are intentionally process-local. A successful service restart invalidates the browser's old token. The upgrade page treats the first post-restart 401 as the expected session boundary: it stops polling, clears stale local session state, redirects to login, and returns to `/system-update` after a successful login.

The first-time Windows bootstrap also verifies real HTTP readiness instead of trusting the NSSM `Running` state alone. After restart it polls loopback `/api/ping` and requires the reported FAR2 version to match the just-installed `core/package.json` version before declaring one-click update enabled. The ping response is deliberately minimal (`ok`, uptime, version) and contains no account/configuration data.

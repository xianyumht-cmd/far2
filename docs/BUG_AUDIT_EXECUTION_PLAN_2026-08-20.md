# FAR2 BUG Audit Execution Plan — 2026-08-20

## Goal

Freeze non-essential feature expansion while the current production business flow is stable enough to audit hidden reliability defects. The audit is source-first and runtime-evidence-first: a finding is not considered fixed until its trigger path, failure mode, regression test, and deployment verification are all defined.

## Safety boundary

- `main` and the Windows production worktree are not modified directly by audit work.
- Each confirmed defect is fixed on a dedicated branch and submitted as a separate PR when practical.
- Open feature PRs are not merged or rewritten as part of the audit.
- Production service restart/deployment is a separate gate after source review and regression checks.
- Read/status paths must not silently gain writes, process scans, login refreshes, or Worker RPCs.

## Execution order

### Phase A — P0 resource audit

1. `P0-001` CodeManager idle Session scan every 10s — **FIX CANDIDATE OPEN: PR #58**.
2. `P0-002` enumerate production `child_process` / PowerShell / CIM callers; eliminate or bound recurring shell creation.
3. `P0-003` enumerate long-lived timers; verify reason, frequency, overlap protection, stop semantics, and idle cost.

Exit gate: healthy idle FAR2 must not continuously create short-lived PowerShell processes.

### Phase B — P1 recovery audit

Audit `WS400 -> refresh -> Worker replacement`, kickout recovery, retry state, duplicate trigger suppression, Provider/session failure handling, and stale Worker cleanup.

Exit gate: repeated failure cannot create concurrent refreshes, duplicate Workers, tight retries, or destructive stop-before-provider-ready behavior.

### Phase C — P2 read-side-effect audit

Audit `/api/runtime-health`, `/api/code-manager/status`, CodeManager WebUI polling, Health Center polling, Provider health endpoints, and desktop Session status helpers.

Exit gate: normal status/health polling is cache/read-only unless the endpoint is explicitly documented as a live probe.

### Phase D — P4 persistence/restart audit

Audit JSON atomic writes, redundant rewrites, parse/corruption behavior, desktop-session registry persistence, service restart/recovery ownership, and stale runtime artifacts.

Exit gate: routine reads do not rewrite state; writes are atomic and failure behavior is explicit/fail-closed where identity or credentials are involved.

### Phase E — P3 business-loop soak audit

Audit Farm/Friend scheduler loops, heartbeat/status sync, fertilizer timer, reconnect/backoff, API timeouts, and long-running overlap behavior.

Exit gate: no unbounded overlap, timer leak, tight failure loop, or high-cost idle loop is left in the normal business runtime.

### Phase F — closeout

- Record every finding and disposition in `docs/BUG_AUDIT_2026-08-20.md`.
- Keep unresolved issues explicitly listed rather than silently declaring the audit complete.
- After code PRs are ready, perform a separate production deployment gate and then a Windows idle CPU/process soak to verify runtime behavior.

## Current status

- Phase A started.
- `P0-001`: source fix + regression test in PR #58; production not changed by this audit branch.
- Remaining phases continue in the order above.

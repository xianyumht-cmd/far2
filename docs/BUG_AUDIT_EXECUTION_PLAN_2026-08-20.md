# FAR2 BUG Audit Execution Plan — 2026-08-20

## Goal

Freeze non-essential feature expansion while the current production business flow is stable enough to audit hidden reliability defects. The audit is source-first and runtime-evidence-first: a finding is not considered production-fixed until its trigger path, failure mode, regression test, merge state, deployment verification and Windows runtime evidence are all defined.

## Safety boundary

- Audit repair code is not applied directly to the Windows production worktree.
- Each confirmed defect is fixed on a dedicated branch and submitted as a separate PR when practical.
- Open feature PRs are not merged or rewritten as part of the audit.
- Production service restart/deployment is a separate gate after source review and regression checks.
- Read/status paths must not silently gain writes, process scans, login refreshes, or Worker RPCs.
- One three-line audit placeholder was accidentally created on `main` during the audit and immediately removed by a normal follow-up commit; no repair code or lasting tree content from that placeholder remains on `main`.

## Execution order

### Phase A — P0 resource audit

1. `P0-001` CodeManager idle Session scan every 10s — PR #58.
2. `P0-002` production `child_process` / PowerShell / CIM callers — PR #59 for confirmed event-time shell churn.
3. `P0-003` long-lived timers / overlap — PR #60 for confirmed fertilizer purchase overlap.

Source gate: **COMPLETE**.

Production exit gate remains: healthy idle FAR2 must not continuously create short-lived PowerShell processes after deployment.

### Phase B — P1 recovery audit

Audited `WS400 -> refresh -> Worker replacement`, kickout recovery, retry state, duplicate trigger suppression, Provider/session failure handling, and Worker stop/start safety.

Source gate: **PASS**. No new blocking concurrent-Worker/tight-retry defect confirmed.

### Phase C — P2 read-side-effect audit

Audited `/api/runtime-health`, `/api/code-manager/status`, CodeManager WebUI polling, Health Center polling, Provider health endpoints, and desktop Session status helpers.

Source gate: **PASS WITH PR #58**. Normal WebUI polling becomes cache/read-only with respect to Desktop Session scans; explicit Provider/Agent readiness probes remain live by design.

### Phase D — P4 persistence/restart audit

Confirmed two persistence defect groups:

- P4-001: critical `accounts.json` corruption silently became fallback state — PR #61.
- P4-002: user/card/security files used direct overwrite plus tolerant reset — stacked PR #62 on #61.

Source gate: **COMPLETE WITH REPAIR PRS OPEN**.

### Phase E — P3 business-loop soak/source audit

Audited Farm/Friend scheduler loops, heartbeat/status sync, fertilizer timer, startup friend import, and bounded Agent identity polling.

Source gate: **PASS WITH PR #60**. No second P0-style healthy-idle loop found; one write-capable overlap defect was fixed in #60.

### Phase F — P5 / source closeout

Audited docs/tests/runtime drift.

- Event-only policy docs were correct; P0-001 was implementation drift and is addressed by #58.
- No `.github/workflows` CI gate currently exists on `main`.
- `core/package.json` default `test` remains a failing placeholder despite many real self-tests.

Source gate: **COMPLETE, with CI/default-test aggregation recorded as a post-merge engineering gate**.

## Repair PR set

```text
#58  P0-001  event-only idle Session/PowerShell scan
#59  P0-002  Code capture clipboard PowerShell throttle
#60  P0-003  fertilizer timer overlap guard
#61  P4-001  critical accounts JSON fail-closed
#62  P4-002  user/card/security atomic persistence (stacked on #61)
```

No repair PR has been merged by this audit execution, and no Windows production deploy/restart has been performed.

## Remaining production gate

The source plan has been executed. The audit is not production-closed until a separately authorized gate completes:

1. review repair PR diffs and merge in dependency-safe order;
2. create/confirm the canonical offline regression entrypoint and CI policy;
3. update the Windows production checkout without deleting runtime data;
4. restart only the required FAR2 service/tasks;
5. verify WebUI, Worker, Code Provider/Agent and account recovery health;
6. run a Windows idle process/CPU soak long enough to prove the 10-second PowerShell creation is gone;
7. retain pre/post evidence and rollback material.

Production deployment remains intentionally blocked pending explicit authorization.

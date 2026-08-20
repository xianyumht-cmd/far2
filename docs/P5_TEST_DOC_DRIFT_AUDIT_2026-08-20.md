# FAR2 P5 Test / Documentation Drift Audit — 2026-08-20

## Runtime policy vs documentation

The important production Code-recovery policy is consistent across the current README/milestone/install script:

```text
healthy -> no proactive Code refresh
WS400 / valid kickout / manual -> event-driven refresh
```

The defect found in P0-001 was therefore implementation drift, not a documentation misunderstanding: `FARM_CODE_SCHEDULED_REFRESH=0` and the milestone described event-only behavior while the old CodeManager still performed a live Session scan every 10 seconds. PR #58 closes that code/policy drift.

## Finding P5-001 — regression tests exist but there is no repository CI workflow

The repository currently has no `.github/workflows` directory on `main`. Core exposes many targeted self-test commands, but they are not automatically executed on pull requests or pushes.

Risk:

- a future change can reintroduce an idle process scan, timer overlap, or persistence fallback without any required automated gate;
- PR review currently depends on manually remembered self-test commands and real Windows verification notes.

Disposition: **process gap, not a runtime blocker for the current audit fixes.** Add a CI gate after the current audit PR stack is merged so the workflow can reference the final canonical test commands.

## Finding P5-002 — `core/package.json` default `test` is a failing placeholder

`core/package.json` still defines:

```text
"test": "echo \"Error: no test specified\" && exit 1"
```

while the same package exposes a large set of real self-tests. A developer or automation invoking the conventional `pnpm -C core test` gets a deliberate failure rather than the repository's regression suite.

Disposition: **test-entrypoint drift.** After audit PRs are merged, replace the placeholder with a curated offline/safe regression aggregate and use that aggregate from CI. Do not bind the default test command to probes that require live QQ, Windows Session, or write-capable Farm operations.

## Documentation freshness

`README.md` correctly frames stability/unattended operation as the priority and describes WS400/kickout event-driven Code recovery. `PROJECT_STATE.md` contains older roadmap/history sections and should remain historical context rather than the sole audit tracker.

For the current audit, the authoritative tracker is `docs/BUG_AUDIT_2026-08-20.md` plus the P0/P4 detail documents and repair PRs.

## Closeout requirement

P5 is considered source-audited when:

- the runtime/documentation event-only mismatch is closed by PR #58;
- P4 fixes have regression commands;
- the lack of CI/default test aggregation is explicitly tracked for the post-merge engineering gate instead of being mistaken for completed automation.

Production deployment is not part of P5 and remains separately authorized.

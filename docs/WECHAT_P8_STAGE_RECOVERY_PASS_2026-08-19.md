# WeChat P8 Isolated Real Recovery Gate — PASS

Date: 2026-08-19

## Result

The isolated P8 stage real login/recovery gate passed on Windows while production `FAR2Farm` remained running.

Observed result:

- Provider available: `true`
- Exact AppId: `wx5306c5978fdb76e4`
- Client version: `1.13.2.7`
- Initial Provider refresh: `true`
- Initial real login-only worker: `true`
- Scoped `ws_400` recovery triggered: `true`
- Second real login after recovery: `true`
- Fresh Code rotated: `true`
- Provider refresh count: `2`
- Code lengths: `32`, `32`
- Validation worker starts/stops: `2/2`
- Login generations: `2`
- Validation account existed in memory only
- Raw Code printed: `false`
- Raw Code persisted in report: `false`
- Raw Code persisted in stage: `false`
- Farm automation started: `false`

Production safety checks all passed:

- `FAR2Farm` stayed running
- Service PID stayed unchanged
- Production `accounts.json` hash stayed unchanged
- Production tracked working-tree state stayed unchanged
- QQ production remained untouched

Final gate result: `gatePassed=true`.

## Interpretation

This closes the isolated proof for the production-shaped path:

`Resident Agent -> authenticated loopback Provider -> fresh wx.login Code -> staged FAR2 WeChat gateway login -> scoped ws_400 -> second fresh Code -> target validation Worker replacement -> second real login`.

The next step is **not** to reset or replace the dirty production worktree. The production migration must first audit only the P8 runtime-critical files against the current `D:\project2\far2-test` working tree, preserve unrelated/dirty QQ work, and prove the P8 patch can be integrated without overwriting local changes.

A read-only migration audit is now provided by:

- `plan-wechat-p8-production-migration.cmd`
- `scripts/windows/plan-wechat-p8-production-migration.ps1`

The audit performs a three-way merge simulation for only these runtime-critical files:

- `core/client.js`
- `core/src/core/worker-bootstrap.js`
- `core/src/services/wechat-gateway-profile.js`
- `core/src/services/wechat-runtime-code-provider.js`
- `core/src/services/wechat-recovery-manager.js`

It writes merged candidates only under `%LOCALAPPDATA%\FAR2\p8-production-audit\...`; it does not modify production, stop/restart the service, mutate accounts, or control QQ workers. Any merge conflict fails closed. It also checks resident Provider health and whether NSSM still needs explicit Provider env injection before the eventual controlled apply/restart step.

## Safety boundary retained

- no chat database/content/contact access
- no Cookie/long-lived token capture
- no WebSocket payload capture
- raw wx.login Code remains transient only
- no farm automation/write in this gate
- no production service restart
- no production account mutation
- no QQ worker stop/start
- no `git clean`, reset, checkout, or blanket file replacement on the dirty production tree

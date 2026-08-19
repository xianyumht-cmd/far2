# Windows WeChat P8 Controlled Production Apply PASS — 2026-08-19

## Result

The rollback-safe P8 production runtime apply passed on the real `FAR2Farm` service.

Production target:

- worktree: `D:\project2\far2-test`
- app directory: `D:\project2\far2-test\core`
- production git HEAD before apply: `d4c419246f0891d535280839317e694a049a71a3`
- FAR2Farm PID: `14740 -> 28120`
- service remained stable after the single deployment restart

Applied audited runtime files:

- `core/client.js`
- `core/src/core/worker-bootstrap.js`
- `core/src/services/wechat-gateway-profile.js`
- `core/src/services/wechat-runtime-code-provider.js`
- `core/src/services/wechat-recovery-manager.js`

Validation:

- syntax preflight: PASS
- dependency/module preflight: PASS
- FAR2Farm NSSM Provider URL/token injection: PASS (values never printed)
- production `accounts.json` SHA256 unchanged before/after apply
- Resident Agent ready before and after restart
- exact target AppId: `wx5306c5978fdb76e4`
- client version reported by Agent: `1.13.2.7`
- rollback was not required

## Safety observations

The controlled apply did not:

- edit production account data
- call `wx.login`
- print raw WeChat Code
- print Provider token
- add farm writes
- run `git reset`, `git checkout`, or `git clean` against the dirty production worktree

The one FAR2Farm deployment restart naturally restarted FAR2Farm-owned QQ workers. This deployment restart is not counted as a scoped WeChat-recovery isolation test.

## Next gate

The next step is `test-wechat-p8-production-account-gate.cmd`.

It creates or resumes exactly one real `platform=wx` production account, configured with:

- `codeRefreshEnabled=true`
- `codeRefreshMode=windows_wechat`
- exact AppId `wx5306c5978fdb76e4`

The running service is not restarted by that gate. `WechatRecoveryManager` discovers the account, obtains a fresh Code itself, starts the real production worker, then performs a second scoped refresh. The gate requires the FAR2Farm PID and QQ identity/ownership fields to remain unchanged across the scoped WeChat refresh stage.

Raw Code is expected to be stored only in the normal production `accounts.json` credential field by `WechatRecoveryManager`; it is never printed or written into gate reports.

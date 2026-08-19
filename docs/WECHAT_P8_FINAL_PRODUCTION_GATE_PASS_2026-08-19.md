# FAR2 Windows WeChat P8 Final Production Gate PASS — 2026-08-19

## Result

The final real production WeChat account gate passed on Windows production FAR2.

Verified production evidence:

- FAR2Farm production worktree: `D:\project2\far2-test`
- FAR2Farm PID stayed unchanged for the whole account gate: `28120 -> 28120`
- Production QQ accounts stayed `2 -> 2`
- QQ identity / ownership snapshot stayed unchanged
- One real production WeChat account was enrolled as account id `3`
- `platform=wx`
- exact appId: `wx5306c5978fdb76e4`
- resident recovery enabled with `codeRefreshMode=windows_wechat`
- first real production refresh/login succeeded
  - reason: `scheduled`
  - fresh Code length: `32`
  - nickname/status sync observed
  - client version: `1.13.2.7`
  - gateway version: `1.13.2.7_20260723`
  - WMPF version: `25297`
- second scoped production refresh also succeeded
  - reason: `scheduled`
  - fresh Code length: `32`
- Resident Agent was ready before and after the gate
- the gate did not restart FAR2Farm
- raw wx.login Code was not printed and was not written to the gate report
- Provider token was not printed
- no diagnostic farm write was injected
- no `git reset`, `git checkout`, or `git clean` was used on the dirty production worktree

## Production interpretation

The P8 Windows WeChat path is now proven end-to-end in the real FAR2 production runtime:

`desktop WeChat exact farm runtime -> Resident Agent -> fresh wx.login Code -> WechatRecoveryManager -> real production wx Worker -> successful Login -> later scoped fresh Code refresh`

The earlier deployment restart is not counted as QQ-isolation evidence. During this final account gate, FAR2Farm PID stayed unchanged and the QQ identity/ownership snapshot stayed unchanged while the WeChat account completed two real production refresh cycles.

## Known cosmetic issue

The production account display name was persisted as mojibake (`寰俊鍐滃満`) by the gate launcher path. This does not affect authentication or recovery. The production finalization step repairs only that account display name to `微信农场` without restarting FAR2Farm.

## Remaining production closeout

1. Install the Resident Agent as an interactive-user logon task (never Session 0).
2. Keep a self-contained Agent runtime copy under `%LOCALAPPDATA%\FAR2\wechat-agent\runtime` so autostart does not depend on the probe worktree remaining checked out.
3. Repair the one WeChat account display name.
4. Update WebUI wording/status to use the Resident Provider path.
5. Retire or fail-close the old 8059 / Scheme unattended fallback from the primary path.
6. Cold-start limitation remains: after Windows/WeChat restart, the user must open QQ Classic Farm once after the Agent is armed so the exact farm runtime can be selected.

## Safety boundary retained

- QQ exact-UIN Provider behavior remains separate.
- QQ global client version is unchanged.
- WeChat raw Code remains transient at capture time and only normal production credential storage persists the current account Code.
- No chat DB, contact data, cookie, long-lived token, or broad WebSocket payload capture is used.
- `Weixin.exe` is not terminated.

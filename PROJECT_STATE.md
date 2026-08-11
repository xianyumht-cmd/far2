# FAR2 Project State / Handoff

> Last updated: 2026-08-12 06:27 (+08:00)
>
> Repository: `xianyumht-cmd/far2`
>
> Local test checkout used during this work: `D:\project2\far2-test`
>
> Branch: `main`
>
> Handoff anchor after Provider contract/docs work: `7b7921c5dd20fd411d14d6f96ee721204cef0cfd`

## 1. Current task goal

Implement safe, unattended Farm Code refresh for multiple QQ accounts without cross-account refreshes, without falling back to the machine-wide QQ account chooser, and without guessing an account by process order.

The architecture is intentionally split into two layers:

1. **Account/Session orchestration** — identify which Windows QQ farm runtime belongs to which farm account, recover after PID changes, schedule refresh independently per account, expose state/config through API/WebUI, and hard-block cross-account refreshes.
2. **Targeted Code Provider** — obtain a fresh Farm Code for exactly the requested QQ identity/session.

Layer 1 is now substantially complete and verified. Layer 2 is the remaining blocker.

---

## 2. Current verified account/session mapping

Last binding audit passed with `issueCount=0`.

| FAR2 account | Account ID | QQ/UIN | Main QQ PID at audit | Farm root PID at audit | Binding |
|---|---:|---|---:|---:|---|
| `4476` | `1` | `44****56` | `9192` | `13772` | online, exact UIN match |
| `232` | `2` | `23****72` | `5500` | `7132` | online, exact UIN match |

Important:

- PIDs are **runtime-only and ephemeral**. Never persist identity by PID alone.
- Durable identity is the saved QQ/UIN.
- The Session Registry is expected to recover new PIDs after the same QQ reopens the farm mini-program.
- Do not bind accounts by ordering of processes/windows.

The full QQ numbers are intentionally not documented here. The current account records already contain their UIN/QQ metadata.

---

## 3. Proven protocol/runtime facts

### Game protocol

- Farm WSS endpoint remains the project endpoint used by the original bot.
- Publicly working client version adopted during this work: `1.13.0.5_20260729`.
- With the updated version, the bot successfully performed Login, user info, friend list, friend weed/bug/water, and own-farm operations.
- A later `KickoutNotify` with unknown reason is a separate issue; do **not** treat every unknown kickout as guaranteed Code expiry.

### Fresh Code source on Windows

A standalone diagnostic proved that the official Windows QQ mini-program runtime can produce a usable Farm Code through its own `qq.login()` flow:

- QQEX farm cache was patched temporarily.
- The real QQ farm mini-program executed `qq.login()`.
- A fresh Code was captured.
- Farm WebSocket probe passed.
- Patched files were restored afterward.

This proves a fresh Code is obtainable from the real Windows QQ runtime. It does **not** solve selecting one specific QQ when multiple QQ identities share the same desktop environment.

---

## 4. Completed and verified work

### 4.1 Desktop Session Registry

Implemented `core/src/services/desktop-session-registry.js`.

Capabilities:

- Read-only Windows process snapshot through CIM.
- Detect top-level QQ processes and farm mini-program roots.
- Resolve QQ/UIN from farm/main QQ descendant process annotations.
- Current successful UIN source on this machine: `main_qq_tree`.
- Persist bindings in `core/data/desktop-sessions.json`.
- Recover runtime PID/channel values by saved UIN after farm restart.
- Mark offline / `needsRebind` when no matching runtime is present.

Key commands:

```powershell
pnpm qr:sessions
pnpm qr:session-map
pnpm qr:session-recover-test -- 1
pnpm qr:session-recover-test -- 2
```

Account 1 recovery was explicitly tested and passed after farmRootPid changed.

### 4.2 Account ↔ Session pairing

Legacy imported account metadata originally lacked UIN/QQ, so automatic mapping from the old source was impossible.

Interactive pairing was performed and corrected to the verified mapping above.

A later binding audit independently verified both account UINs, saved binding UINs, and live runtime Session UINs all match.

### 4.3 Multi-account CodeManager

`core/src/services/code-manager.js` was refactored into a per-account Session-aware scheduler.

Each configured account has independent state such as:

- `nextRefreshAt`
- `inFlight`
- `pendingReason`
- retry scheduling
- Session state
- Provider state

Supported states include:

- `configured`
- `scheduled`
- `refreshing`
- `ready`
- `waiting_session`
- `waiting_provider`
- `provider_error`
- `session_mismatch`

Important behavior:

- `ws_400` affects only the corresponding account.
- Kickout-triggered refresh affects only the corresponding account.
- Offline Session does not stop the existing worker.
- Unavailable Provider does not stop the existing worker.
- Existing worker is stopped only after a Provider has already returned a fresh Code.
- CodeManager waits for the old worker to exit before starting the new one.
- No automatic fallback to global `tencent://` exists.

### 4.4 Hard backend anti-cross-account guard

This is a critical completed protection.

Before **any** Provider can run, CodeManager now checks:

1. Account has a valid UIN/QQ.
2. Bound Session has a valid UIN.
3. Account UIN equals bound Session UIN exactly.

If any identity check fails:

- Provider is not called.
- Worker is not stopped.
- Code is not modified.
- State becomes `session_mismatch` (or the relevant waiting state).

The fake self-test explicitly changed account 1's bound UIN to account 2's UIN and verified:

- mismatched Session blocked before Provider — PASS
- Provider refresh call count did not increase — PASS
- Code remained unchanged — PASS
- worker did not stop/start — PASS
- restoring the correct UIN allowed refresh again — PASS

Latest self-test result included:

```text
sessionIdentityHardGuard=true
```

### 4.5 Account-level refresh configuration

Both real accounts have been configured as:

```text
codeRefreshEnabled=true
codeRefreshMode=windows_session
```

Last audit verified both remain enabled with mode `windows_session`.

Command:

```powershell
pnpm qr:code-manager-config -- enable 1 2
```

### 4.6 CodeManager read-only planner/audit

Useful diagnostics:

```powershell
pnpm qr:code-manager-plan
pnpm qr:session-binding-audit
```

Last real binding audit result:

```text
accountId=1 name=4476
  accountUin=44****56 bindingUin=44****56
  expectedSession=online boundSession=online
  bindingStatus=online needsRebind=false
  codeRefreshEnabled=true mode=windows_session
  result=OK

accountId=2 name=232
  accountUin=23****72 bindingUin=23****72
  expectedSession=online boundSession=online
  bindingStatus=online needsRebind=false
  codeRefreshEnabled=true mode=windows_session
  result=OK

issueCount=0
```

### 4.7 CodeManager API

Implemented authenticated API routes:

```text
GET  /api/code-manager/status
GET  /api/code-manager/config
POST /api/code-manager/config
POST /api/code-manager/refresh
```

Properties:

- Reuses existing admin/auth middleware.
- Normal users only see/control their own accounts.
- Admin can see all accessible accounts.
- No Farm Code is returned by these API routes.

API self-test passed:

```text
status permission filter PASS
own account config GET PASS
cross-account access denied PASS
config POST PASS
manual refresh route PASS
admin status scope PASS
response credential privacy PASS
```

### 4.8 WebUI Code refresh page

Added:

```text
/code-manager
```

Sidebar item: `Code刷新`.

Page follows the existing left-side selected account; it does not create a second account selector.

Displays:

- account-level enable/disable
- `windows_session` mode
- masked bound QQ/UIN
- Session online/offline state
- Provider name/status
- global scheduler state
- refresh interval / poll / retry
- next refresh / pending reason
- manual refresh button

Safety UI:

- manual refresh is disabled while the real Provider is unavailable
- UI compares current account UIN and bound Session UIN
- visible `Session 错绑` warning if identities differ
- mismatch disables refresh

Backend guard remains authoritative even if the UI is bypassed.

### 4.9 Web build / real admin startup

`pnpm build:web` passed successfully with Vite.

Observed UnoCSS warnings for some existing Carbon icons are non-fatal and did not block the build.

Real core/admin server was started successfully:

```powershell
pnpm dev:core
```

Admin panel:

```text
http://127.0.0.1:3007
```

`/code-manager` loaded correctly in the browser.

### 4.10 Provider injection contract

`createRuntimeEngine({ codeRefreshProvider })` now exposes the Provider injection point and forwards it to CodeManager.

See:

```text
docs/CODE_REFRESH_PROVIDER.md
```

Provider shape:

```js
{
  name: 'provider_name',

  async getAvailability(account, binding) {
    return { available: true, reason: 'ok' }
  },

  async refresh({ account, binding, reason }) {
    return {
      code: '<fresh Farm Code>',
      source: 'provider_name',
    }
  },
}
```

Provider must **not** mutate accounts or restart workers. CodeManager owns persistence/restart/retry/status.

---

## 5. Current production safety state

The built-in Provider is still:

```text
targeted_provider_pending
```

Therefore real automatic Code refresh is intentionally disabled.

**DO NOT set:**

```text
FARM_CODE_AUTO_REFRESH=1
```

until a targeted Provider passes the acceptance checklist in `docs/CODE_REFRESH_PROVIDER.md`.

Expected WebUI state while Provider is not implemented:

```text
Account config: enabled / windows_session
Session: online when farm is open
Provider: targeted_provider_pending
Global scheduler: disabled
Manual refresh: disabled
```

---

## 6. Failed / rejected approaches — do not repeat

These routes have already been tested and should not be retried without genuinely new evidence.

### 6.1 Old QQ miniapp IDE QR exchange

Old route can complete QR scan/poll and identify the QQ, but final exchange returned:

```text
-3000
校验失败
```

`-3000` is not a Farm Code and must never be stored.

### 6.2 PC QZone QR route

QZone PTLogin can authenticate a QQ web session but does not directly yield a Farm Code.

### 6.3 PC cookie → miniapp bridge

Using QZone login cookies with the miniapp flow did not make the miniapp confirmation ticket transition successfully.

### 6.4 Dual-scan experiment

Combining a genuine miniapp scan ticket with PC cookies still produced `-3000 校验失败` from the old IDE login exchange.

Conclusion: do not keep debugging the old IDE endpoint as the primary solution.

### 6.5 Global runtime Code acquisition with multiple QQs

The proven single-account runtime tester uses machine-wide `tencent://` to open QQ Farm. With multiple QQ accounts logged in this can show the QQ account chooser, so it is not suitable for unattended multi-account targeting.

### 6.6 Target-window Ctrl+R experiment

A test intercepted the global `tencent://` launch and sent Ctrl+R to the bound farm root window instead.

Result:

```text
90 秒内没有捕获到 Code
```

The QQ mini-program did not reload the modified disk `game.js` in the required way.

Do not rerun the old target-code test.

### 6.7 Renderer restart experiment

A test terminated only the target farm root's renderer children.

Result:

```text
renderer_not_respawned
```

The farm root remained, Session binding remained online, but QQEX did not respawn those renderer processes during the test window.

Do not use renderer killing as the refresh mechanism.

### 6.8 Process injection / IPC hooking path

Reference projects contain Frida/process-hooking/cookie-oriented approaches. These are not the chosen path for FAR2 targeted Provider work.

Do not add code that injects into QQ processes, hooks internal IPC, extracts cookies/tokens, or kills/restarts renderers to force credential generation.

---

## 7. What is actually solved vs. still open

### Solved / verified

- [x] Farm protocol works with updated client version.
- [x] Fresh Code can be generated by the real Windows QQ farm runtime in a single-account/unambiguous flow.
- [x] Multiple concurrent QQ farm Sessions can be discovered.
- [x] Each farm Session can be mapped to a QQ/UIN.
- [x] Account ↔ QQ/UIN ↔ runtime Session binding.
- [x] Session PID recovery after farm window restart.
- [x] Multi-account independent CodeManager scheduling.
- [x] Per-account single-flight behavior.
- [x] Waiting-session / waiting-provider safe states.
- [x] Worker stop/start ordering around a successful Provider result.
- [x] Backend hard UIN identity guard.
- [x] Fake multi-account self-tests.
- [x] API + permission isolation.
- [x] WebUI state/config page.
- [x] Real Web build and admin startup.
- [x] Targeted Provider interface/injection point.
- [x] Provider requirements documented.

### Not solved

- [ ] Obtain a fresh Farm Code for **one explicitly requested QQ identity** while multiple QQ accounts share the same Windows desktop runtime, using a safe/reliable unattended method.
- [ ] Production Provider implementation.
- [ ] Real end-to-end automatic refresh with Provider → fresh Code → account persistence → worker reconnect for account 1 and account 2.
- [ ] Final unattended soak test.

This distinction is important: **Session identity is solved; per-Session Code minting is not.**

---

## 8. Recommended next architecture

Do not spend more time trying random keyboard shortcuts, renderer kills, or process-order guesses inside one shared Windows desktop.

Recommended production topology:

```text
FAR2 / CodeManager
        |
        +-- account 4476 -> Provider instance A -> isolated QQ runtime A
        |
        +-- account 232  -> Provider instance B -> isolated QQ runtime B
```

Each Provider environment should have exactly one possible QQ identity.

Suitable isolation boundaries:

- separate Windows user sessions;
- separate Windows VMs;
- another supported QQ runtime isolation/profile where the QQ client itself keeps identity unambiguous.

Why this is preferred:

- no account chooser ambiguity;
- no PID/order guessing;
- no need to hook QQ internals;
- each Provider instance can reuse the already proven single-QQ runtime Code flow;
- FAR2 already has the account/session hard identity guard before applying a result.

---

## 9. Next implementation steps in the new chat

Proceed in this order.

### Step A — read state first

Read:

```text
PROJECT_STATE.md
docs/CODE_REFRESH_PROVIDER.md
```

Do not re-run the failed QR/target-window/renderer experiments.

### Step B — choose the first production Provider topology

Preferred first practical test:

- keep one QQ in the current Windows environment;
- put the second QQ in one isolated Windows runtime/user/VM;
- make each Provider endpoint responsible for exactly one QQ UIN.

The Provider must return only `{ code, source }` for the requested bound account.

### Step C — build Provider adapter

Implement a Provider that satisfies:

```js
getAvailability(account, binding)
refresh({ account, binding, reason })
```

No account mutation inside Provider.
No worker restart inside Provider.
No plaintext Code in normal logs/API.

### Step D — first real end-to-end account test

Test account 1 only:

1. Session online and exact UIN match.
2. Provider available.
3. Obtain fresh Code.
4. Only then stop account 1 worker.
5. Persist fresh Code to account 1.
6. Wait old worker exit.
7. Start account 1 worker.
8. Verify successful farm Login.
9. Confirm account 2 never changed/stopped.

Then repeat for account 2.

### Step E — enable global scheduler only after both pass

Only after both real accounts pass isolated manual Provider refresh should `FARM_CODE_AUTO_REFRESH=1` be considered.

Then test:

- scheduled refresh;
- `ws_400` trigger;
- safe non-version kickout trigger;
- Provider unavailable behavior;
- Session offline behavior;
- Session mismatch behavior;
- multi-hour unattended soak.

---

## 10. Useful commands

From:

```powershell
cd D:\project2\far2-test
```

Update:

```powershell
git pull
```

Build WebUI:

```powershell
pnpm build:web
```

Start real admin/core:

```powershell
pnpm dev:core
```

Admin:

```text
http://127.0.0.1:3007
http://127.0.0.1:3007/code-manager
```

Session registry:

```powershell
pnpm qr:sessions
```

Binding audit:

```powershell
pnpm qr:session-binding-audit
```

CodeManager plan:

```powershell
pnpm qr:code-manager-plan
```

Account refresh config:

```powershell
pnpm qr:code-manager-config -- enable 1 2
```

Fake CodeManager regression test:

```powershell
pnpm qr:code-manager-selftest
```

Fake API regression test:

```powershell
pnpm qr:code-manager-api-selftest
```

---

## 11. Important operational rules

- Never ask the user to paste a real Farm Code into chat.
- Do not print/store Farm Code in ordinary logs.
- Do not treat `-3000` as a Code.
- Do not assume every `KickoutNotify` means Code expiry.
- Do not identify an account by process order.
- Do not persist PID as account identity.
- Do not fall back to machine-wide `tencent://` when multiple QQ accounts are present.
- Do not enable real global refresh while Provider is still `targeted_provider_pending`.
- Session mismatch must fail closed.
- Provider failure must not stop a healthy worker.
- Obtain fresh Code before stopping the old worker.

---

## 12. New-chat continuation prompt

Use this as the first message in the next chat:

```text
继续 far2 的 QQ 农场多账号 Code 自动刷新项目。
先读取仓库根目录 PROJECT_STATE.md 和 docs/CODE_REFRESH_PROVIDER.md，严格按里面的当前状态继续，不要重复已经失败的 QR / Ctrl+R / renderer 重启实验。
当前 Session/绑定/CodeManager/API/WebUI/防串号已完成，剩余核心是 targeted Code Provider。继续从“独立 QQ 运行环境 Provider”方案往下实现。
```

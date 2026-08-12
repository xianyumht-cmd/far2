# FAR2 QQ Code Refresh Milestone — 2026-08-12

This note is the final real-Windows acceptance record for the current single-account unattended Code-refresh milestone.

## Final status

**COMPLETED / ACCEPTED for the current single-account Windows background scope.**

Accepted target:

- FAR2 account `232`;
- QQ/UIN masked as `23****72`;
- Windows background service + hidden interactive Code Agent;
- targeted exact-UIN Code refresh;
- event-driven recovery instead of healthy periodic re-login;
- browser/WebUI may be closed during normal unattended operation.

This completion does **not** claim that the separate second-QQ / second-Windows-session multi-account topology has been accepted. That is intentionally deferred and is a separate future scope.

## Real Windows acceptance summary

### Provider / Agent

Verified on the real Windows host:

- isolated Provider self-test passed;
- exact-UIN Provider health probe passed;
- real one-shot mint passed with no account chooser;
- returned Code was validated without printing plaintext Code;
- Agent health reported:
  - `ok=True`;
  - `available=True`;
  - `reason=ok`;
  - QQ `23****72`;
  - Windows Session `1`;
- Agent port `43101` was listening;
- Provider target configuration decoded to exactly one masked QQ target;
- bearer token was present without being logged.

### CodeManager E2E

A real WebUI start of account `232` proved the full unattended chain:

1. worker attempted connection;
2. Farm WS returned HTTP 400;
3. CodeManager automatically invoked the targeted Provider;
4. early attempts failed closed with `agent_capture_identity_unverified`;
5. CodeManager retried automatically;
6. a later refresh succeeded;
7. old account process exited;
8. account `232` restarted automatically;
9. Farm login succeeded at level 112;
10. normal farm/friend automation resumed.

Important conclusions:

- manual Code entry was not required;
- no shared QQ chooser fallback was used;
- automatic retry/self-recovery was proven;
- UIN/Windows SessionId safety checks remained fail-closed;
- plaintext Code was not exposed in normal logs/UI.

## Background/autostart acceptance

Normal use no longer requires foreground `pnpm dev:core` or `pnpm code:agent` console windows.

Installed runtime:

```text
Windows boot
  -> NSSM service: FAR2Farm
       -> WebUI / CodeManager / workers

Windows user logon
  -> hidden Scheduled Task: FAR2CodeAgent-<UIN>
       -> isolated Code Agent on 127.0.0.1:43101
       -> Farm window cloak helper
```

Real accepted status included:

```text
NSSM service: FAR2Farm status=Running
Code Agent task: FAR2CodeAgent-2320006072 state=Running
WebUI: READY http=200
Code Agent port 43101: LISTEN
Agent auth token: PRESENT
Agent health: ok=True available=True reason=ok qq=23****72
Service provider env: auto=True eventOnly=True targetsB64=True targetsRaw=False token=True healthTimeout=True entries=6
Service refresh mode: eventOnly=True passiveIntervalMs=315360000000
Service provider targets: decoded=True count=1 qq=23****72
```

`lastResult=267009` / `0x41301` for the scheduled task means the long-running task is currently active, not failed.

## NSSM environment fix

NSSM 2.24 command-line setting of multiple `AppEnvironmentExtra` values was not reliable on this host.

The installer now writes the service environment directly as the NSSM `Parameters\AppEnvironmentExtra` `REG_MULTI_SZ` value and verifies all required entries before starting the service.

Provider target JSON is stored as Base64 in:

```text
FARM_CODE_PROVIDER_TARGETS_B64
```

This avoids NSSM quoting/escaping problems while preserving exact-UIN target mapping.

## Event-driven refresh policy

A real diagnostic showed that the previous one-hour proactive refresh policy could create its own QQ Farm login conflict:

- repeated `scheduled` refreshes appeared in the Agent log;
- `已在其他终端登录` kickouts appeared roughly one hour apart;
- the Farm mini-program could reopen repeatedly;
- machine load was not saturated at diagnostic time, so performance was not treated as the primary root cause.

Production policy was changed to:

```text
healthy FAR2 account
  -> no hourly proactive QQ Farm re-login

WS400 / kickout / explicit manual refresh
  -> targeted Provider refresh
  -> retry only if recovery fails
```

Installed service environment includes:

```text
FARM_CODE_SCHEDULED_REFRESH=0
```

A far-future passive interval remains only as a compatibility horizon for the current CodeManager scheduler.

## Post-capture identity hardening

The Agent still requires exact identity verification and still fails closed on mismatch/unknown identity.

The observation path was strengthened to:

- inspect the current Windows process snapshot after capture;
- identify QQ mini-app trees associated with Farm app id `1112386029`;
- accept UIN annotation from the Farm root or descendants;
- walk through intermediate QQ utility processes to the real top-level QQ ancestor;
- allow the exact ancestor QQ tree UIN as the existing safety fallback when Farm descendants have not exposed UIN yet;
- reject any known mismatched UIN;
- reject unknown identity after timeout.

Diagnostic Agent lines include:

```text
[identity] t=... attempt=... source=process_tree farmRoots=... uins=...
[identity] verified ...
[identity] timeout ...
```

Historical `agent_capture_identity_unverified` failures remain useful evidence, but after the event-only policy and identity hardening they are no longer treated as a blocker for this completed single-account milestone.

## Farm-window hiding

The cloak helper preserves the real interactive QQ/QQEX runtime and uses:

1. fast title-based Farm-window detection;
2. Farm app-id CIM/process-tree detection;
3. a short polling interval to move the transient Farm window off-screen quickly.

This remains visual hiding rather than a true headless QQ runtime. The Agent must remain in the interactive Windows user session; moving it into Session 0/LocalSystem would break the isolation assumptions.

A future natural Code-refresh event may still be used to observe whether the Farm window is completely invisible or briefly flashes, but this is no longer a blocker for the current background-running milestone.

## Protobuf/shop startup race — fixed

A separate startup warning was observed:

```text
获取商店失败：无法读取未定义属性（读取“encode”），使用本地备选列表
```

Root cause was not a missing `ShopInfoRequest` definition. The Worker could receive a WebUI API request while asynchronous local Protobuf loading was still in progress, so `types.ShopInfoRequest` had not yet been populated.

The Worker Protobuf initialization was changed to complete atomically before other Worker API activity can use `types.*`.

After deployment the warning disappeared and normal startup proceeded as:

```text
正在加载 Protobuf 定义...
Protobuf 定义加载完成
正在连接服务器...
登录成功
```

## Long-running soak acceptance

After the final fixes were deployed, the real Windows setup was left running normally and observed again after sleep.

**Result: approximately 9 hours of continuous unattended operation with the account still online and automation working normally.**

No new startup Protobuf/shop warning was observed in that accepted run, and the service/worker stack remained alive without requiring the browser to stay open.

This 9-hour real-use soak is the final acceptance evidence used to mark the current single-account Windows background milestone complete.

## Current daily-use workflow

Normal use:

```text
1. Log into Windows.
2. Keep the target QQ logged in.
3. FAR2Farm starts automatically as an NSSM service.
4. FAR2CodeAgent starts hidden in the interactive Windows session.
5. Open http://127.0.0.1:3007 only when management is needed.
6. Start/stop account 232 from WebUI when needed.
7. The browser may be closed while FAR2 continues running.
8. Leave Code recovery/retries to CodeManager/Agent.
```

No manual PowerShell environment setup, manual Code entry, or visible FAR2/Agent console is required for normal operation.

## Completion boundary / intentionally deferred future scope

The following items are **not blockers for this completed milestone** and are intentionally separate future work:

- second QQ / second Windows user-session Agent acceptance;
- two-account controlled E2E;
- multi-cycle two-account unattended soak;
- future observation of a natural Code expiry to measure whether the Farm window is fully invisible or only briefly flashes.

Account `4476` remains outside this accepted single-account refresh chain.

## Do not repeat

Do not return to the previously rejected approaches unless genuinely new evidence appears:

- old QR exchange path;
- shared-desktop global QQ chooser fallback;
- Ctrl+R target-window experiments;
- renderer restart/kill experiments;
- PID/window-order identity guessing;
- injection/IPC/Frida/cookie extraction as a shortcut around the isolation design.

## Final milestone label

```text
FAR2 single-account Windows unattended/background Code refresh
Status: COMPLETE
Accepted account: 232 / 23****72
Acceptance date: 2026-08-12
Soak evidence: ~9 hours continuous normal operation
Refresh policy: event-only
Browser required for runtime: no
Manual Code required for normal recovery: no
```

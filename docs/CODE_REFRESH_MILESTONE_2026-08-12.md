# FAR2 QQ Code Refresh Milestone — 2026-08-12

This note is the latest real-Windows acceptance overlay for `PROJECT_STATE.md` and `docs/CODE_REFRESH_PROVIDER.md`.

## Milestone status

**Single-account targeted unattended Code refresh for account `232` / QQ `23****72`: PASS with retry.**

The feature is usable and may be left running in the background. It is not yet considered a fully clean/stable two-account production acceptance because post-capture identity verification can still intermittently time out and the second isolated Windows account/session has not been accepted.

## Real Windows results

### Provider / Agent

Verified on the real Windows host:

- isolated Provider self-test passed;
- exact-UIN Provider health probe passed;
- real one-shot mint passed with no account chooser;
- returned Code was validated without printing plaintext Code;
- Agent health later reported:
  - `ok=True`
  - `available=True`
  - `reason=ok`
  - QQ `23****72`
  - Windows Session `1`;
- Agent port `43101` was listening.

### CodeManager E2E

A real WebUI start of account `232` produced:

1. worker attempted connection;
2. Farm WS returned HTTP 400;
3. CodeManager automatically invoked the targeted Provider;
4. several refresh attempts failed closed with `agent_capture_identity_unverified`;
5. CodeManager retried automatically;
6. a later refresh succeeded;
7. old account process exited cleanly;
8. account `232` was restarted automatically;
9. Farm login succeeded at level 112;
10. normal farm/friend automation resumed.

Important conclusion:

- the unattended chain is proven end to end;
- manual Code entry was not required;
- automatic retry/self-recovery is proven;
- `agent_capture_identity_unverified` remains an intermittent timing issue, not a solved stability item.

Do not weaken the UIN/Windows SessionId guard to hide this error.

## Background/autostart acceptance

The foreground `pnpm dev:core` and `pnpm code:agent` consoles are no longer required for normal use.

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

Real status after installation:

```text
NSSM service: FAR2Farm status=Running
Code Agent task: FAR2CodeAgent-2320006072 state=Running
WebUI: READY http=200
Code Agent port 43101: LISTEN
Agent auth token: PRESENT
Agent health: ok=True available=True reason=ok qq=23****72
Service provider env: auto=True targetsB64=True targetsRaw=False token=True healthTimeout=True
Service provider targets: decoded=True count=1 qq=23****72
```

`lastResult=267009` / `0x41301` for the scheduled task means the long-running task is currently active, not failed.

### NSSM environment fix

NSSM 2.24 command-line setting of multiple `AppEnvironmentExtra` values was not reliable on this host. The installer writes the service environment directly as the NSSM `Parameters\AppEnvironmentExtra` `REG_MULTI_SZ` value and verifies all required entries before starting the service.

Provider target JSON is stored in the service environment as Base64 (`FARM_CODE_PROVIDER_TARGETS_B64`) to avoid quoting/escaping problems. The Provider supports decoding this format.

## 11:02 stability diagnostic and policy change

A later real diagnostic captured a longer running period with repeated Farm-window popups and repeated `agent_capture_identity_unverified` failures.

Important evidence:

- diagnostic-time CPU load was about 37%, not saturated;
- free memory was about 3.3 GB of 16.3 GB;
- Agent/service/task/43101 were all alive;
- the Agent log showed multiple `scheduled` refreshes, not only WS400 recovery;
- two `已在其他终端登录` kickouts appeared about one hour apart;
- the user manually pressed the Farm mini-program reconnect button after one such popup, after which FAR2 WebUI returned online.

Conclusion:

**machine load may amplify the timing race, but it is not treated as the primary root cause.** The previous one-hour proactive refresh policy could create its own QQ Farm login conflict and repeatedly reopen the Farm mini-program.

### New production refresh policy

The Windows installer now configures production as event-driven recovery:

```text
healthy FAR2 account
  -> no hourly proactive QQ Farm re-login

WS400 / kickout / explicit manual refresh
  -> targeted Provider refresh
  -> retry only if that recovery attempt fails
```

The service environment includes:

```text
FARM_CODE_SCHEDULED_REFRESH=0
```

and uses a far-future passive interval as a compatibility horizon for the current CodeManager scheduler. This prevents the previous hourly healthy-account refresh behavior while keeping WS400/kickout/manual triggers immediate.

Expected installed environment count is now `6/6`.

### Post-capture identity hardening

The Agent still fails closed and still requires exact UIN verification, but the observation path is now more robust:

- it inspects the actual Windows process snapshot after capture;
- identifies only QQ mini-app trees associated with Farm app id `1112386029`;
- accepts UIN annotation from the Farm root or any descendant in that Farm tree;
- can walk through intermediate QQ utility processes to find the real top-level QQ ancestor;
- if the Farm tree itself does not yet expose UIN, it may use the exact ancestor QQ tree UIN as the existing safety fallback;
- any known mismatched UIN still rejects the capture;
- unknown identity still times out and rejects the capture.

New Agent log lines are ASCII-safe and include observations such as:

```text
[identity] t=... attempt=... source=process_tree farmRoots=... uins=...
[identity] verified ...
[identity] timeout ...
```

This allows a future failure to show whether Farm roots were absent, UIN was absent, or a mismatch was observed without logging plaintext Code.

### Farm-window hiding hardening

The cloak helper still preserves the real interactive QQ/QQEX runtime, but now has two hiding paths:

1. fast title-based detection of QQ windows containing the Farm title token;
2. existing Farm app-id CIM/process-tree detection.

The fast path moves the window off-screen before the slower CIM tree refresh completes and polls at 60 ms. This aims to eliminate or greatly reduce the visible Farm popup while preserving `qq.login()` semantics.

This visual behavior still needs one real Windows observation after deployment; do not claim it fully accepted until observed.

## Current daily-use workflow

Normal use is:

```text
1. Log into Windows.
2. Keep the target QQ logged in.
3. Open http://127.0.0.1:3007 only when management is needed.
4. Start/stop account 232 from WebUI.
5. The browser may be closed while the background service continues running.
6. Leave Code recovery/retries to CodeManager/Agent.
```

No PowerShell environment setup or visible Agent/FAR2 consoles should be needed.

## Farm mini-program window hiding

This is **visual hiding, not a true headless QQ runtime**. Do not replace the real interactive runtime with Session 0/NSSM Agent execution; that would break the isolation model.

## Remaining work / intentionally deferred

- Re-accept the new process-tree identity verification on real Windows after deployment.
- Confirm whether the hardened Farm-window cloak removes the visible popup completely.
- If identity failures remain, use the new `[identity]` Agent lines rather than weakening the identity guard.
- Second QQ / second Windows user-session Agent acceptance is not done.
- Two-account controlled E2E is not done.
- Multi-cycle two-account unattended soak is not done.

Account `4476` remains outside this accepted single-account refresh chain for now.

## Separate observation

One unrelated/fallback log has appeared before Protobuf loading completed:

```text
warehouse store fetch failed: cannot read property `encode` of undefined; using local fallback list
```

The program continued, logged into Farm successfully, and automation resumed. Treat this as a separate warehouse/Protobuf issue; it did not block the Code refresh milestone.

## Do not repeat

Do not return to the previously rejected approaches unless genuinely new evidence appears:

- old QR exchange path;
- shared-desktop global QQ chooser fallback;
- Ctrl+R target-window experiments;
- renderer restart/kill experiments;
- PID/window-order identity guessing;
- injection/IPC/Frida/cookie extraction as a shortcut around the isolation design.

## Recommended next acceptance

After pulling the latest changes, reinstall the Windows service once so the new event-driven environment is written and the hidden Agent task is restarted with the new code/window cloak.

Then verify status shows event-only mode and use the system normally. Do not intentionally break Code just to test it. The next natural WS400/kickout is sufficient to verify whether:

1. no hourly proactive Farm popup occurs;
2. recovery opens no visible Farm window or only a minimal flash;
3. the first targeted refresh verifies UIN without repeated `agent_capture_identity_unverified`;
4. FAR2 returns online without manual Farm reconnect.

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

Do not weaken the UIN/Windows SessionId guard to hide this error. If it becomes frequent again, investigate capture/identity observation timing while keeping fail-closed behavior.

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
Service provider env: auto=True targetsB64=True targetsRaw=False token=True healthTimeout=True entries=5 source=REG_MULTI_SZ
Service provider targets: decoded=True count=1 qq=23****72
```

`lastResult=267009` / `0x41301` for the scheduled task means the long-running task is currently active, not failed.

### NSSM environment fix

NSSM 2.24 command-line setting of multiple `AppEnvironmentExtra` values was not reliable on this host. The installer now writes the service environment directly as the NSSM `Parameters\AppEnvironmentExtra` `REG_MULTI_SZ` value and verifies all five required entries before starting the service.

Provider target JSON is stored in the service environment as Base64 (`FARM_CODE_PROVIDER_TARGETS_B64`) to avoid quoting/escaping problems. The Provider supports decoding this format.

## Current daily-use workflow

Normal use is now:

```text
1. Log into Windows.
2. Keep the target QQ logged in.
3. Open http://127.0.0.1:3007
4. Start/stop account 232 from WebUI.
5. Leave Code refresh and retries to CodeManager/Agent.
```

No PowerShell environment setup or visible Agent/FAR2 consoles should be needed.

## Farm mini-program window hiding

A window-cloak helper was added so the temporary QQ Farm mini-program used for `qq.login()` can remain in the real interactive QQ/QQEX session while being moved outside the visible desktop and prevented from taking focus.

This is **visual hiding, not a true headless QQ runtime**.

Real acceptance of “no visible Farm window at all” has not been explicitly confirmed yet. Treat this as pending cosmetic acceptance. Do not replace the real interactive runtime with Session 0/NSSM Agent execution; that would break the isolation model.

## Remaining work / intentionally deferred

- `agent_capture_identity_unverified` can still occur intermittently before a later retry succeeds.
- Second QQ / second Windows user-session Agent acceptance is not done.
- Two-account controlled E2E is not done.
- Multi-cycle two-account unattended soak is not done.
- Farm-window cloak visual behavior is not explicitly accepted yet.

Account `4476` remains outside this accepted single-account refresh chain for now.

## Separate observation

During the final successful account start, one unrelated/fallback log appeared before Protobuf loading completed:

```text
warehouse store fetch failed: cannot read property `encode` of undefined; using local fallback list
```

The program continued, logged into Farm successfully, and automation resumed. Treat this as a separate warehouse/Protobuf issue if it becomes worth fixing; it did not block the Code refresh milestone.

## Do not repeat

Do not return to the previously rejected approaches unless genuinely new evidence appears:

- old QR exchange path;
- shared-desktop global QQ chooser fallback;
- Ctrl+R target-window experiments;
- renderer restart/kill experiments;
- PID/window-order identity guessing;
- injection/IPC/Frida/cookie extraction as a shortcut around the isolation design.

## Recommended next action when this project resumes

Do not change the working flow just for cleanup.

If `agent_capture_identity_unverified` becomes frequent enough to matter, resume from that timing/race only and preserve fail-closed identity verification. Otherwise the next meaningful feature step is the second isolated Windows user/session on a separate Agent endpoint such as `43102`, followed by two-account acceptance.

# Targeted Code Refresh Provider

## Status / precedence

Current source is the final truth for implementation details.

For acceptance state:

1. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`
2. this document
3. older notes / `PROJECT_STATE.md`

As of 2026-08-13:

- **single-account Windows isolated Provider: COMPLETED / ACCEPTED** in the scope recorded by `CODE_REFRESH_MILESTONE_2026-08-12.md`;
- event-driven recovery (`WS400` / kickout / manual) remains the production policy;
- **second QQ / second Windows user Session acceptance is still pending**;
- Provider core already supports multiple exact-UIN targets; the remaining work is deployment + real two-account acceptance, not a new capture algorithm.

Do not reinterpret older “Provider pending” text as the current state.

## Goal

CodeManager must refresh Farm Code for exactly one configured QQ account without falling back to a global QQ account selector and without guessing by process order.

The account/session identity chain is:

`account.id -> account.uin/qq -> desktop session binding.qqUin -> exact-UIN provider target -> isolated Windows Session Agent`

A provider is eligible only when CodeManager has already verified that the account UIN and bound Session UIN are identical.

## Provider contract

`createRuntimeEngine({ codeRefreshProvider })` accepts:

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

CodeManager owns worker stop/start, account persistence, retry scheduling and status reporting. A Provider must not mutate farm accounts or restart workers itself.

## Hard safety gates

Before a Provider can run, CodeManager requires:

1. Windows runtime.
2. Global `FARM_CODE_AUTO_REFRESH=1`.
3. Account `codeRefreshEnabled=true`.
4. Account `codeRefreshMode=windows_session`.
5. Bound desktop Session is online and does not need rebind.
6. Account UIN exists.
7. Bound Session UIN exists.
8. Account UIN equals bound Session UIN exactly.
9. Exact-UIN Provider target exists and reports available.

If account/session identity differs, the state becomes `session_mismatch` and the Provider is not called.

## Implemented isolated-runtime Provider

Production files:

```text
core/src/services/isolated-runtime-code-provider.js
core/src/services/isolated-code-agent.js
core/src/services/windows-runtime-code.js
core/scripts/qq-isolated-code-agent.js
core/scripts/qq-isolated-code-provider-selftest.js
core/scripts/qq-isolated-code-provider-check.js
scripts/windows/run-code-agent-hidden.ps1
scripts/windows/install-far2-autostart.ps1
scripts/windows/status-far2-autostart.ps1
```

Architecture:

```text
FAR2 / CodeManager (LocalSystem)
        |
        +-- UIN A -> 127.0.0.1:43101
        |
        +-- UIN B -> 127.0.0.1:43102

Windows user/session A
        +-- exactly one QQ A
        +-- isolated Code Agent A

Windows user/session B
        +-- exactly one QQ B
        +-- isolated Code Agent B
```

The main FAR2 process never invokes the old machine-wide runtime capture as a fallback. Only the Agent running inside its isolated Windows user Session calls the proven `windows-runtime-code.js` flow.

## Anti-cross-account checks

Main FAR2 Provider adapter:

- resolves a target by exact QQ UIN only;
- re-checks `account.uin/qq === binding.qqUin` before any request;
- checks Agent `/v1/health` returned UIN;
- checks refresh response UIN again;
- rejects malformed Code;
- never falls back to another endpoint.

Isolated Agent:

- is configured for exactly one `FAR2_CODE_AGENT_UIN`;
- requires a bearer token;
- identifies its own Windows `SessionId`;
- requires exactly one top-level QQ process in that Windows login Session;
- rejects live QQ/farm runtime whose observed UIN differs;
- after `qq.login()` returns Code, keeps the mini-program alive briefly and verifies runtime UIN in the same Windows Session before releasing Code;
- never prints plaintext Code to normal logs.

`desktop-session-registry.js` exposes Windows SessionId on detected QQ/farm runtime data; isolation is based on a real Windows login-session boundary, not PID ordering.

## Provider targets configuration

`FARM_CODE_PROVIDER_TARGETS` / `FARM_CODE_PROVIDER_TARGETS_B64` may contain multiple UIN mappings:

```json
{
  "123456789": {
    "name": "runtime_a",
    "url": "http://127.0.0.1:43101",
    "tokenEnv": "FAR2_CODE_PROVIDER_TOKEN_A"
  },
  "987654321": {
    "name": "runtime_b",
    "url": "http://127.0.0.1:43102",
    "tokenEnv": "FAR2_CODE_PROVIDER_TOKEN_B"
  }
}
```

Use a different loopback port and token per Windows Session Agent.

Remote plaintext HTTP is rejected by default. Use HTTPS/VPN/reverse proxy for remote environments. Do not weaken the Session/UIN gates merely to make a remote topology pass.

## Windows incremental installer

`install-far2-autostart.ps1` now treats one invocation as “register/update the QQ belonging to this Windows Session”, not “replace the entire machine with one QQ”.

Behavior:

- if only one FAR2 `windows_session` QQ is enabled, it remains backward-compatible with the previous single-account install;
- if multiple are enabled, it attempts to map the current Windows Session to one UIN from live QQ process annotations;
- ambiguous identity fails closed; `-Uin <QQ>` is the explicit override;
- existing target port/tokenEnv/token is reused;
- new targets receive the next free loopback port in `43101-43199`;
- new token envs use `FAR2_CODE_PROVIDER_TOKEN_A`, `_B`, `_C`... without exposing token values;
- existing `FARM_CODE_PROVIDER_TARGETS_B64` is decoded and merged rather than overwritten;
- only `FAR2CodeAgent-<selected UIN>` is replaced; other Agent tasks are preserved;
- `FAR2Farm` is restarted so LocalSystem reloads the merged Provider environment.

The second Windows user should run the installer from that user Session after its QQ is logged in and Farm has been opened at least once.

## Provider Agent transport

Private authenticated endpoints:

```text
GET  /v1/health
POST /v1/code/refresh
```

`/v1/health` never returns Farm Code.

`/v1/code/refresh` returns the fresh Code only to FAR2 after local identity checks pass. It is not exposed through normal FAR2 admin API/WebUI.

Normal FAR2 logs, CodeManager status API and WebUI must never contain plaintext Code.

## Self-test

Pure simulated test:

```powershell
pnpm code:provider-selftest
```

It does not open QQ, scan QR, press Ctrl+R, restart a renderer, or call real `qq.login()`.

It covers:

- UIN A routes only to endpoint A;
- UIN B routes only to endpoint B;
- account/Session UIN mismatch calls no endpoint;
- Provider-reported UIN mismatch is rejected;
- remote plaintext HTTP is rejected;
- Agent rejects multiple QQ main processes in one Windows Session;
- Agent rejects runtime UIN mismatch;
- process-tree identity fallback.

## Exact-UIN acceptance probe

Health only:

```powershell
pnpm code:provider-check -- <QQ UIN>
```

One-shot mint:

```powershell
pnpm code:provider-check -- <QQ UIN> --refresh
```

`--refresh` validates Code in memory and discards it; it must not print or persist plaintext Code or mutate FAR2 account state.

## Current second-QQ acceptance checklist

The single-account milestone is already accepted; do not repeat it merely to prove old work again.

For the new second-QQ scope, complete only the incremental checks:

- second Windows user Session has exactly one QQ;
- second Agent task is registered without deleting the first task;
- NSSM Provider target map contains both UINs;
- A and B use distinct loopback ports and token envs;
- status script reports both Agent listeners and exact identity;
- health-only probe READY for A and B independently;
- one-shot `--refresh` for B mints fresh Code with B identity;
- refreshing B leaves A worker/Code untouched;
- refreshing A leaves B worker/Code untouched;
- no account chooser appears;
- no plaintext Code/token appears in normal logs;
- after both controlled directions pass, run a two-account unattended soak.

Until those pass, describe the state as:

**“multi-session deployment implemented; second QQ real acceptance pending.”**

## Production refresh policy

Keep:

```text
FARM_CODE_AUTO_REFRESH=1
FARM_CODE_SCHEDULED_REFRESH=0
```

Healthy accounts are not proactively re-login every hour.

Refresh is event-driven:

- `WS400`;
- eligible kickout;
- explicit manual refresh.

Do not restore fixed hourly QQ Farm re-login as the default.

## Rejected paths remain rejected

Do not re-run or reintroduce these as fallbacks without genuinely new evidence:

- old QQ miniapp IDE QR exchange (`-3000 校验失败`);
- QZone QR as a Farm Code source;
- PC cookie -> miniapp bridge;
- dual-scan experiment;
- shared-desktop global `tencent://` targeting;
- target-window Ctrl+R;
- renderer kill/restart;
- process injection / internal IPC hooking / cookie extraction;
- PID/window-order guessing.

Those are not “backup Provider strategies”; they are previously rejected experiments.

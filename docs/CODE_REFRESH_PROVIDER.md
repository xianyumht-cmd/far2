# Targeted Code Refresh Provider

## Goal

CodeManager must refresh Farm Code for exactly one configured QQ account without falling back to a global QQ account selector and without guessing by process order.

The account/session identity chain is:

`account.id -> account.uin/qq -> desktop session binding.qqUin -> targeted provider instance`

A provider is only eligible when CodeManager has already verified that the account UIN and bound Session UIN are identical.

## Provider contract

`createRuntimeEngine({ codeRefreshProvider })` accepts a provider object with the following shape:

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

CodeManager owns worker stop/start, account persistence, retry scheduling and status reporting. A provider must not mutate farm accounts or restart workers itself.

## Hard safety gates

Before a provider can run, CodeManager requires all of the following:

1. Windows runtime.
2. Global `FARM_CODE_AUTO_REFRESH=1`.
3. Account `codeRefreshEnabled=true`.
4. Account `codeRefreshMode=windows_session`.
5. Bound desktop Session is online and does not need rebind.
6. Account UIN exists.
7. Bound Session UIN exists.
8. Account UIN equals bound Session UIN exactly.
9. Provider reports available.

If account/session identity differs, the state becomes `session_mismatch` and the provider is not called.

## Implemented isolated-runtime Provider

The repository now contains the first production-shaped targeted Provider implementation:

```text
core/src/services/isolated-runtime-code-provider.js
core/src/services/isolated-code-agent.js
core/scripts/qq-isolated-code-agent.js
core/scripts/qq-isolated-code-provider-selftest.js
core/scripts/qq-isolated-code-provider-check.js
```

Production startup in `core/client.js` creates `isolated_qq_runtime` only when `FARM_CODE_PROVIDER_TARGETS` is configured. If it is absent, CodeManager keeps the safe `targeted_provider_pending` fallback.

The design is deliberately split in two:

```text
FAR2 / CodeManager
        |
        +-- UIN A -> fixed Provider endpoint A
        |
        +-- UIN B -> fixed Provider endpoint B

Provider endpoint A -> isolated Windows login session -> exactly one QQ A
Provider endpoint B -> isolated Windows login session -> exactly one QQ B
```

The main FAR2 process never invokes the old machine-wide runtime capture as a fallback. Only the Agent running inside the isolated Windows environment calls the already-proven `windows-runtime-code.js` capture flow.

## Additional anti-cross-account checks

The isolated Provider adds defense in depth on top of CodeManager's existing account/Session UIN guard.

Main FAR2 Provider adapter:

- resolves an endpoint by exact QQ UIN only;
- re-checks `account.uin/qq === binding.qqUin` before any request;
- checks Agent `/v1/health` returned UIN equals the requested UIN;
- checks refresh response UIN again before accepting Code;
- rejects malformed Code;
- never falls back to another endpoint.

Isolated Agent:

- is configured for exactly one `FAR2_CODE_AGENT_UIN`;
- requires a bearer token;
- identifies its own Windows `SessionId`;
- requires exactly one top-level QQ process in that Windows login session;
- rejects a live QQ/farm runtime whose observed UIN differs from the configured UIN;
- after `qq.login()` returns Code, keeps the mini-program alive briefly and verifies the runtime UIN in the same Windows Session before releasing the Code;
- rejects the captured Code if runtime identity cannot be verified or differs;
- never prints the plaintext Code to normal logs.

`desktop-session-registry.js` now exposes Windows SessionId on detected QQ/farm runtime data so isolation is based on a real Windows login-session boundary, not PID ordering.

## Configuration

### 1. Start one Agent inside each isolated Windows QQ environment

Run the Agent under the same interactive Windows user that owns that QQ/QQEX runtime.

Required environment variables:

```text
FAR2_CODE_AGENT_UIN=<full QQ UIN>
FAR2_CODE_AGENT_TOKEN=<random secret, at least 24 chars>
```

Optional:

```text
FAR2_CODE_AGENT_HOST=127.0.0.1
FAR2_CODE_AGENT_PORT=43101
FAR2_CODE_AGENT_CAPTURE_TIMEOUT_MS=90000
FAR2_CODE_AGENT_IDENTITY_TIMEOUT_MS=2500
```

Start:

```powershell
pnpm code:agent
```

For a second Windows user session on the same host, use a different port, for example `43102`.

The built-in Agent is plain HTTP and defaults to loopback only. Do not expose it directly to a LAN/Internet. For a VM/remote host, put it behind HTTPS/VPN/reverse proxy. `FAR2_CODE_AGENT_ALLOW_INSECURE_REMOTE=1` exists only as an explicit lab override.

### 2. Map each FAR2 account UIN to exactly one endpoint

Example `FARM_CODE_PROVIDER_TARGETS`:

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

Then set the referenced token variables separately:

```text
FAR2_CODE_PROVIDER_TOKEN_A=<same token as Agent A>
FAR2_CODE_PROVIDER_TOKEN_B=<same token as Agent B>
```

Using `tokenEnv` is preferred over placing a token directly inside the JSON mapping.

Remote `http://` Provider URLs are rejected by default. `https://` is accepted. Loopback `http://127.0.0.1/...` is accepted for separate Windows user sessions on the same machine.

## Provider Agent transport

Authenticated private endpoints:

```text
GET  /v1/health
POST /v1/code/refresh
```

`/v1/health` never returns Farm Code.

`/v1/code/refresh` is the private Provider transport and necessarily returns the fresh Code to FAR2 after all local identity checks pass. This endpoint is not exposed through the normal FAR2 admin API/WebUI.

Normal FAR2 logs, CodeManager status API and WebUI must never contain plaintext Code.

## Local non-QQ self-test

A pure simulated test was added:

```powershell
pnpm code:provider-selftest
```

It does **not** open QQ, scan a QR code, press Ctrl+R, restart a renderer, or call real `qq.login()`.

It verifies:

- UIN A routes only to endpoint A;
- UIN B routes only to endpoint B;
- account/Session UIN mismatch calls no Provider endpoint;
- Provider-reported UIN mismatch is rejected;
- remote plaintext HTTP is rejected by default;
- Agent rejects multiple QQ main processes in its Windows Session;
- Agent rejects an observed runtime UIN mismatch.

## Safe targeted acceptance probe

Before enabling the global CodeManager scheduler, use the explicit Provider probe for one UIN at a time.

Health-only mode:

```powershell
pnpm code:provider-check -- <QQ UIN>
```

This does not mint a Code.

Explicit one-shot mint verification:

```powershell
pnpm code:provider-check -- <QQ UIN> --refresh
```

`--refresh` invokes only the exact UIN-mapped isolated Agent. The returned Code is validated in memory and immediately discarded. The command prints only masked UIN, result/source and Code length. It does not print or persist the Code, mutate any FAR2 account, or stop/start any worker.

Use this probe to establish that each isolated environment can independently mint a fresh Code before `FARM_CODE_AUTO_REFRESH=1` is ever enabled.

## Current safety state

The Provider implementation now exists, but **real Provider acceptance is still pending**.

Do not enable unattended refresh yet:

```text
FARM_CODE_AUTO_REFRESH=1
```

The global switch remains off until the real isolated Windows environments pass the acceptance checklist below for both accounts.

The development execution sandbox used for the implementation cannot resolve GitHub and this repository currently has no GitHub Actions runs, so the newly added self-test has not been claimed as executed here. Run it in the Windows checkout before the first real Agent test.

## Recommended first real topology

Use separate Windows user sessions on the same host first because it preserves the existing machine-wide Desktop Session Registry while giving each Agent a distinct user-owned `APPDATA/QQEX` runtime and a distinct Windows SessionId.

Example:

```text
Windows user/session A
  one QQ A
  Code Agent :43101

Windows user/session B
  one QQ B
  Code Agent :43102

main FAR2
  UIN A -> 127.0.0.1:43101
  UIN B -> 127.0.0.1:43102
```

A VM/remote topology is still suitable for Provider isolation, but the current CodeManager hard gate also requires its bound Desktop Session to be online. Do not weaken or bypass that gate merely to make a remote VM test pass; extend Session reporting separately if a fully remote topology is chosen later.

## Provider acceptance checklist

A production provider is not ready until all of these pass:

- `pnpm code:provider-selftest` passes locally.
- Health-only probe is READY for account A's exact UIN and exact endpoint.
- One-shot `--refresh` probe mints a Code for account A without printing/persisting it.
- Repeat the same two probe steps for account B.
- Refresh account A while account B stays unchanged.
- Refresh account B while account A stays unchanged.
- No account chooser appears during unattended refresh.
- Agent sees exactly one QQ main process in its own Windows Session.
- Captured runtime UIN is verified before Code is released.
- Provider is never called for an offline Session.
- Provider is never called for a mismatched account/Session UIN.
- Provider endpoint identity mismatch is rejected.
- Provider returns only a fresh Code for the requested account.
- Existing worker stays running when provider availability fails.
- Existing worker is stopped only after a fresh Code has already been obtained.
- Old worker fully exits before the new worker starts.
- Account B worker/code is untouched while account A refreshes, and vice versa.
- No plaintext Code is emitted to normal logs, CodeManager API or WebUI.

Only after both accounts pass should `FARM_CODE_AUTO_REFRESH=1` be enabled for scheduled unattended refresh.

## Rejected paths remain rejected

Do not re-run or reintroduce these as Provider fallbacks without genuinely new evidence:

- old QQ miniapp IDE QR exchange (`-3000 校验失败`);
- QZone QR as a Farm Code source;
- PC cookie -> miniapp bridge;
- dual-scan experiment;
- shared-desktop global `tencent://` targeting;
- target-window Ctrl+R;
- renderer kill/restart;
- process injection / internal IPC hooking / cookie extraction.

# FAR2 Project State / Handoff

> Last updated: 2026-08-12
>
> Repository: `xianyumht-cmd/far2`
>
> Branch: `main`
>
> Targeted Provider implementation/docs anchor before this state update: `69105c825e19a8c180f0dfc5c85201691636b967`

## 1. Current task goal

Implement safe unattended QQ Farm Code refresh for multiple QQ accounts without cross-account refreshes, without using the shared-desktop QQ account chooser, and without guessing account identity by PID/process/window order.

Architecture:

```text
FAR2 / CodeManager
        |
        +-- exact QQ UIN A -> fixed Provider A -> isolated Windows QQ runtime A
        |
        +-- exact QQ UIN B -> fixed Provider B -> isolated Windows QQ runtime B
```

The orchestration layer is already complete. This work implemented the first production-shaped **targeted isolated QQ runtime Provider**. The remaining blocker is real Windows acceptance/E2E, not another Provider architecture rewrite.

---

## 2. Verified account/session mapping

Last real binding audit before Provider implementation passed with `issueCount=0`.

| FAR2 account | Account ID | QQ/UIN | Binding |
|---|---:|---|---|
| `4476` | `1` | `44****56` | online, exact UIN match |
| `232` | `2` | `23****72` | online, exact UIN match |

Rules:

- Full QQ numbers remain in account/session data and are intentionally not written into docs.
- Durable identity is QQ/UIN.
- Runtime PID, farm root PID and window/process order are not identity.
- Session Registry may recover changed PIDs by saved UIN.

---

## 3. Previously solved and verified orchestration

### Desktop Session Registry

`core/src/services/desktop-session-registry.js`

Already supports:

- read-only Windows process snapshot through CIM;
- top-level QQ and Farm mini-program discovery;
- UIN extraction from QQ/Farm descendant annotations;
- persisted account -> QQ/UIN -> runtime Session binding;
- PID/channel recovery by saved UIN after Farm restart;
- offline / `needsRebind` state when runtime disappears.

Provider work additionally added **Windows SessionId** discovery:

- process snapshot includes `SessionId`;
- `scanMainQqProcesses()` exposes top-level QQs with Windows SessionId;
- `scanRuntimeSessions()` exposes Farm runtime Windows SessionId;
- `getCurrentWindowsSessionId()` identifies the Agent's own Windows login session.

This is used as a real isolation boundary and is not a replacement for the UIN guard.

### Multi-account CodeManager

`core/src/services/code-manager.js`

Already verified behavior:

- per-account schedule / single-flight / retry / state;
- `ws_400` and kickout only affect the corresponding account;
- offline Session does not stop an existing worker;
- unavailable Provider does not stop an existing worker;
- Provider must return a fresh Code **before** CodeManager stops the old worker;
- CodeManager persists Code, waits for old worker exit, then starts the new worker;
- no automatic fallback to global `tencent://`.

### Hard anti-cross-account backend guard

Before any Provider call CodeManager verifies:

1. account has valid UIN/QQ;
2. bound Session has valid UIN;
3. account UIN equals bound Session UIN exactly.

A mismatch blocks before Provider invocation and leaves the worker/Code untouched. Existing fake CodeManager self-test previously passed this path with `sessionIdentityHardGuard=true`.

### Account-level config

Both real accounts were configured:

```text
codeRefreshEnabled=true
codeRefreshMode=windows_session
```

### API / WebUI

Completed:

```text
GET  /api/code-manager/status
GET  /api/code-manager/config
POST /api/code-manager/config
POST /api/code-manager/refresh
```

Web page:

```text
/code-manager
```

API permission isolation and credential privacy self-test previously passed. Web build/admin startup previously passed. WebUI already blocks manual refresh on Provider unavailable or Session/UIN mismatch.

---

## 4. Proven fresh Code source

`core/src/services/windows-runtime-code.js` is the existing proven single-QQ runtime mint mechanism.

A previous real diagnostic proved:

- QQEX Farm `game.js` can be patched temporarily;
- the real QQ Farm mini-program executes `qq.login()`;
- a usable fresh Farm Code is captured;
- Farm WebSocket probe passes;
- patched files are restored afterward.

The old problem was **targeting**: machine-wide `tencent://` on one shared Windows desktop can show the QQ chooser when multiple QQ identities are logged in.

Provider work does not try to solve that ambiguity inside the shared desktop. It moves the proven single-QQ mint flow into an isolated Windows environment where exactly one QQ identity is possible.

`windows-runtime-code.js` now accepts a configurable mini-program close delay. Default behavior remains the prior short delay; isolated Agent uses a longer delay only so it can verify the live runtime UIN after `qq.login()` returns and before releasing the Code.

---

## 5. Implemented targeted isolated-runtime Provider

### 5.1 Main FAR2 Provider adapter

New file:

```text
core/src/services/isolated-runtime-code-provider.js
```

Provider name:

```text
isolated_qq_runtime
```

Configuration is exact-UIN keyed through:

```text
FARM_CODE_PROVIDER_TARGETS
```

Each UIN maps to one fixed endpoint. Example shape only:

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

Safety behavior:

- exact `account.uin/qq === binding.qqUin` re-check before network call;
- exact UIN -> exact endpoint lookup only;
- no target means unavailable/error, never another-account fallback;
- `/v1/health` response UIN must equal requested UIN;
- `/v1/code/refresh` response UIN is verified again;
- returned Code is format-validated;
- bearer token required;
- remote plaintext HTTP rejected by default;
- HTTPS accepted;
- loopback HTTP accepted for same-machine separate Windows user sessions;
- no plaintext Code in normal FAR2 logs/API/WebUI.

### 5.2 Isolated Windows Code Agent

New files:

```text
core/src/services/isolated-code-agent.js
core/scripts/qq-isolated-code-agent.js
```

Agent must run under the same interactive Windows user/session that owns that QQ/QQEX environment.

Required environment:

```text
FAR2_CODE_AGENT_UIN=<full QQ UIN>
FAR2_CODE_AGENT_TOKEN=<random secret, >= 24 chars>
```

Optional:

```text
FAR2_CODE_AGENT_HOST=127.0.0.1
FAR2_CODE_AGENT_PORT=43101
FAR2_CODE_AGENT_CAPTURE_TIMEOUT_MS=90000
FAR2_CODE_AGENT_IDENTITY_TIMEOUT_MS=2500
```

Start command:

```powershell
pnpm code:agent
```

Agent hard checks:

- Windows only;
- identifies its own Windows SessionId;
- requires exactly one top-level QQ process in that Windows login session;
- if a known top-level QQ UIN differs from configured UIN -> block;
- if any observed Farm runtime UIN in that Windows Session differs -> block;
- requires local QQEX Farm cache;
- after fresh Code capture, keeps Farm alive briefly and requires the observed runtime UIN to equal the configured UIN before releasing Code;
- identity unknown after the verification window -> fail closed;
- captured wrong-account/unknown-account Code is never returned to FAR2;
- plaintext Code is not logged.

Private authenticated transport:

```text
GET  /v1/health
POST /v1/code/refresh
```

The built-in HTTP listener defaults to loopback. For a remote VM/host, use HTTPS/VPN/reverse proxy rather than exposing the plain Agent HTTP service.

### 5.3 Production startup wiring

`core/client.js` now creates the isolated Provider from environment and injects it into `createRuntimeEngine({ codeRefreshProvider })`.

Important safe default:

- if `FARM_CODE_PROVIDER_TARGETS` is absent, no new Provider is injected;
- CodeManager continues to expose the safe `targeted_provider_pending` fallback;
- this work did **not** set or enable `FARM_CODE_AUTO_REFRESH=1`.

### 5.4 Simulated anti-cross-account self-test

New:

```text
core/scripts/qq-isolated-code-provider-selftest.js
pnpm code:provider-selftest
```

Pure simulation only; it does not open QQ or call real `qq.login()`.

It covers:

- UIN A routes to endpoint A only;
- UIN B routes to endpoint B only;
- account/Session mismatch does not make any Provider request;
- Provider identity mismatch is rejected;
- remote plaintext HTTP is rejected by default;
- Agent rejects multiple QQ main processes in one Windows Session;
- Agent rejects observed runtime UIN mismatch.

**Execution status:** script was added but not claimed as executed in the implementation environment. The available execution container could not resolve GitHub to obtain the checkout, and this repository currently has no GitHub Actions runs. Run this test in the real Windows checkout before first Agent acceptance.

### 5.5 Safe targeted Provider acceptance probe

New:

```text
core/scripts/qq-isolated-code-provider-check.js
pnpm code:provider-check
```

Health only:

```powershell
pnpm code:provider-check -- <QQ UIN>
```

Explicit one-shot mint verification:

```powershell
pnpm code:provider-check -- <QQ UIN> --refresh
```

This tool exists specifically to test the isolated Provider **without enabling the global CodeManager scheduler**.

`--refresh`:

- invokes only the endpoint mapped to the supplied exact UIN;
- obtains/validates one fresh Code in memory;
- prints only masked UIN, source and Code length;
- immediately discards Code;
- does not print or persist Code;
- does not modify any FAR2 account;
- does not stop/start any worker.

---

## 6. Current production safety state

The targeted Provider implementation now exists.

It is **not yet production-accepted** because the real isolated Windows environments have not been exercised through the new Agent/Provider path.

Therefore unattended refresh remains OFF.

**DO NOT leave enabled yet:**

```text
FARM_CODE_AUTO_REFRESH=1
```

Current distinction:

- Session identity: solved/verified.
- Account/Session anti-cross guard: solved/verified.
- CodeManager/API/WebUI: solved/verified.
- Targeted Provider implementation: implemented.
- Targeted Provider simulated self-test: added, execution pending on Windows checkout.
- Real one-account isolated mint acceptance: pending.
- Real Provider -> CodeManager -> persist -> worker reconnect E2E: pending.
- Two-account unattended soak: pending.

---

## 7. Recommended first real topology

Use **separate Windows user sessions on the same host** first.

Why:

- each user owns a different `APPDATA/QQEX` runtime;
- each Agent has a distinct Windows SessionId;
- each login session can run exactly one QQ identity;
- ports can be separate (`43101`, `43102`);
- the current machine-wide Session Registry can still observe runtime sessions;
- no weakening of CodeManager's existing online Session/UIN guard is required.

Target layout:

```text
Windows user/session A
  exactly one QQ A
  Agent A :43101

Windows user/session B
  exactly one QQ B
  Agent B :43102

main FAR2
  exact UIN A -> 127.0.0.1:43101
  exact UIN B -> 127.0.0.1:43102
```

A fully remote VM is still a valid later Provider isolation boundary, but the current CodeManager hard gate requires its bound Desktop Session to be online. Do not bypass/weaken that safety gate just to make a remote VM topology work; remote Session reporting would be a separate feature.

---

## 8. Exact next steps

Do these in order. Do not go back to the rejected QR/Ctrl+R/renderer experiments.

### Step 1 — update the real Windows checkout and run non-QQ self-test

```powershell
pnpm code:provider-selftest
```

Expected result is all isolated Provider anti-cross checks PASS. If it fails, fix the new Provider code before touching real QQ.

### Step 2 — prepare isolated Windows session A

- log into a separate Windows user/session;
- run **only account A's QQ** in that login session;
- open QQ经典农场 once so that user's QQEX Farm cache exists;
- configure Agent UIN/token and port `43101`;
- start `pnpm code:agent` in that same Windows user session;
- initial status must not report multiple QQ or runtime identity mismatch.

Do the equivalent for account B on port `43102` after A is proven.

### Step 3 — configure exact UIN -> endpoint mapping in main FAR2

Set `FARM_CODE_PROVIDER_TARGETS` and token environment variables. Do not put real tokens into the repository.

Keep:

```text
FARM_CODE_AUTO_REFRESH=0
```

for this stage.

### Step 4 — health-only Provider probe

For account A's full UIN:

```powershell
pnpm code:provider-check -- <QQ UIN>
```

Must return `READY` and must not mint Code.

### Step 5 — one-shot isolated mint acceptance

For account A only:

```powershell
pnpm code:provider-check -- <QQ UIN> --refresh
```

Acceptance:

- no QQ account chooser;
- Agent confirms its isolated Windows Session has exactly one QQ;
- live Farm runtime UIN is verified as requested UIN;
- command reports `refresh: PASS` with source/code length only;
- no plaintext Code in logs;
- FAR2 account records/workers unchanged.

Then repeat Steps 4-5 for account B.

### Step 6 — controlled CodeManager E2E

Only after both isolated mint probes pass:

1. make only the account under test eligible for refresh (temporarily disable the other account's refresh if needed);
2. enable the global refresh gate only for this controlled acceptance window;
3. manually trigger account A;
4. verify Provider returns fresh Code before worker stop;
5. verify only account A Code persists;
6. verify account A old worker exits before replacement starts;
7. verify Farm Login succeeds;
8. verify account B Code/worker never changes;
9. repeat with roles reversed.

Do not move to scheduled unattended mode if either account fails any isolation/identity check.

### Step 7 — unattended soak

After both controlled E2E tests pass:

- enable both account refresh configs;
- enable scheduled global refresh;
- observe at least multiple refresh cycles;
- confirm no chooser, no cross-account change, no leaked Code, and independent retry behavior.

---

## 9. Provider acceptance checklist

Production-ready only when all pass:

- [ ] `pnpm code:provider-selftest` passes in real checkout.
- [ ] Agent A runs in a Windows Session containing exactly one QQ A.
- [ ] Agent B runs in a Windows Session containing exactly one QQ B.
- [ ] Health-only exact-UIN probe READY for A.
- [ ] One-shot mint probe PASS for A, no chooser/code leak/account mutation.
- [ ] Health-only exact-UIN probe READY for B.
- [ ] One-shot mint probe PASS for B, no chooser/code leak/account mutation.
- [ ] Provider never runs for offline Session.
- [ ] Provider never runs for account/Session UIN mismatch.
- [ ] Provider-returned UIN mismatch is rejected.
- [ ] Account A controlled CodeManager refresh changes/restarts A only.
- [ ] Account B controlled CodeManager refresh changes/restarts B only.
- [ ] Worker is stopped only after fresh Code exists.
- [ ] Old worker fully exits before replacement worker starts.
- [ ] New worker logs into Farm successfully.
- [ ] Normal logs/API/WebUI contain no plaintext Code.
- [ ] Multi-cycle unattended soak passes.

---

## 10. Failed/rejected approaches — do not repeat

Do not retry or reintroduce these as Provider fallbacks unless genuinely new evidence changes the technical facts.

### Old QQ miniapp IDE QR exchange

Final exchange returned:

```text
-3000
校验失败
```

Not a Farm Code; never store it.

### QZone QR / PC cookie bridge / dual scan

These authenticate or combine unrelated login state but did not produce a usable targeted Farm Code. The old IDE exchange still failed.

### Shared-desktop machine-wide `tencent://` targeting

Usable for the proven single-account diagnostic only. With multiple QQs it can show the QQ chooser and is not production targeting.

### Target-window Ctrl+R

Previously tested: no Code captured within the test window. Do not rerun.

### Renderer kill/restart

Previously tested: `renderer_not_respawned`. Do not rerun.

### Process injection / internal IPC hooking / cookie extraction

Not the selected FAR2 path. Do not add Frida/process-hooking/internal credential extraction or renderer kill mechanisms.

---

## 11. Files changed in the targeted Provider implementation pass

```text
core/client.js
core/package.json
package.json
core/src/services/desktop-session-registry.js
core/src/services/windows-runtime-code.js
core/src/services/isolated-runtime-code-provider.js
core/src/services/isolated-code-agent.js
core/scripts/qq-isolated-code-agent.js
core/scripts/qq-isolated-code-provider-selftest.js
core/scripts/qq-isolated-code-provider-check.js
docs/CODE_REFRESH_PROVIDER.md
PROJECT_STATE.md
```

Provider/docs implementation commits were made directly on `main`. The latest pre-state handoff anchor is `69105c825e19a8c180f0dfc5c85201691636b967`; this `PROJECT_STATE.md` update is the final handoff record for this pass.

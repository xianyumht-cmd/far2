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

## Current state

The built-in provider remains `targeted_provider_pending`; therefore real automatic refresh is intentionally disabled.

The current same-Windows-session multi-QQ implementation is considered complete only for:

- Session discovery.
- UIN-based account binding.
- PID recovery after farm window restart.
- Multi-account scheduling and single-flight isolation.
- API and WebUI state/configuration.
- Account/Session hard identity guard.

It is **not** considered solved for fresh Code acquisition from a specific QQ Session.

## Recommended production topology

For unattended multi-account operation, prefer one isolated QQ runtime per account so each provider instance has exactly one possible QQ identity. Suitable isolation boundaries include:

- separate Windows user sessions;
- separate virtual machines;
- another supported isolated QQ runtime profile where the QQ client itself keeps the account context unambiguous.

The isolation boundary should be responsible for obtaining a fresh Code through a supported local flow. Far2 should only receive the result through a provider adapter and then perform the existing hard UIN check before applying it.

Do not silently fall back to a machine-wide `tencent://` launch when multiple QQ accounts are present.

## Provider acceptance checklist

A production provider is not ready until all of these pass:

- Refresh account A while account B stays unchanged.
- Refresh account B while account A stays unchanged.
- No account chooser appears during unattended refresh.
- Provider is never called for an offline Session.
- Provider is never called for a mismatched UIN.
- Provider returns only a fresh Code for the requested account.
- Existing worker stays running when provider availability fails.
- Existing worker is stopped only after a fresh Code has already been obtained.
- Old worker fully exits before the new worker starts.
- No plaintext Code is emitted to normal logs or API responses.

# FAR2 P4-002 User/Security Persistence Hardening — 2026-08-20

## Expanded finding

The persistence audit originally identified direct overwrites for `login-logs.json` and `login-attempts.json`. Full `user-store.js` review showed the same pattern also existed for:

- `users.json`;
- `cards.json`;
- `card-claim.json`.

The risk is larger than a single partial write. Several loaders catch JSON parse failures and replace runtime state with empty/default values. For `users.json`, that can reach default-admin initialization; for cards it can look like empty inventory; for login attempts it can erase active lockout/rate-limit state; for card-claim state it can erase the 24-hour claim history.

The audit also found two follow-on correctness gaps:

1. syntactically valid but structurally invalid critical JSON (for example `{}` instead of `{ users: [...] }`) could still be interpreted as empty state;
2. critical save helpers caught persistence errors and only logged them, so API/business callers could continue as if a user/card/security mutation had been persisted when the atomic replace actually failed.

## Fix

This branch is stacked on P4-001 / PR #61.

- `user-store.js` uses the shared atomic JSON writer for users, cards, login attempts, login logs and card-claim state.
- Critical reads for users/cards/login-attempts/card-claim use `readJsonFile()` and propagate `critical_json_corrupt` rather than resetting to an empty/default state.
- `json-db.js` extends the critical basename set to those authoritative/security files and validates their minimum top-level shape.
- Existing but empty/malformed/invalid-shape critical files fail closed and preserve a corrupt backup.
- Critical save failures for users/cards/login-attempts/card-claim now propagate to callers instead of being reported as successful mutations.
- `login-logs.json` intentionally remains tolerant on read and non-blocking on write because loss of an audit log should not prevent authentication; its writes are still atomic when successful.
- Missing critical files retain first-run/bootstrap behavior.

## Regression

`core/scripts/user-store-persistence-selftest.js` runs against a temporary data directory by intercepting only the runtime-path dependency before importing `user-store.js`.

It verifies:

- first-run default admin file is valid JSON;
- login attempts are persisted as valid JSON;
- login logs are valid JSON;
- card creation persists valid JSON;
- card-claim settings persist valid JSON;
- no atomic `.tmp` files leak after successful writes;
- an injected atomic rename failure propagates, cleans the temp file and leaves the authoritative users file unchanged;
- corrupt `login-attempts.json` and `card-claim.json` fail closed;
- syntactically valid but invalid-shape `users.json` / `cards.json` fail closed;
- rejected critical files preserve backup bytes.

Command: `pnpm -C core persistence:user-store-selftest`.

## Merge order

This is a stacked PR and depends on PR #61 because it extends the critical JSON mechanism introduced there. Merge/rebase order must preserve that dependency; production deployment remains a later separate gate.

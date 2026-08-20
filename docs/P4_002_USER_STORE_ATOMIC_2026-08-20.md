# FAR2 P4-002 User/Security Persistence Hardening — 2026-08-20

## Expanded finding

The persistence audit originally identified direct overwrites for `login-logs.json` and `login-attempts.json`. Full `user-store.js` review showed the same pattern also existed for:

- `users.json`;
- `cards.json`;
- `card-claim.json`.

The risk is larger than a single partial write. Several loaders catch JSON parse failures and replace runtime state with empty/default values. For `users.json`, that can reach default-admin initialization; for cards it can look like empty inventory; for login attempts it can erase active lockout/rate-limit state; for card-claim state it can erase the 24-hour claim history.

## Fix

This branch is stacked on P4-001 / PR #61.

- `user-store.js` now uses the shared atomic JSON writer for users, cards, login attempts, login logs and card-claim state.
- Critical reads for users/cards/login-attempts/card-claim use `readJsonFile()` and propagate `critical_json_corrupt` rather than resetting to an empty/default state.
- `json-db.js` extends the critical basename set to those authoritative/security files.
- `login-logs.json` intentionally remains tolerant on read because loss/corruption of an audit log should not prevent authentication; its writes are still atomic.
- Missing critical files retain first-run/bootstrap behavior; only an existing unreadable/empty/malformed file fails closed.

## Regression

`core/scripts/user-store-persistence-selftest.js` runs against a temporary data directory by intercepting only the runtime-path dependency before importing `user-store.js`.

It verifies:

- first-run default admin file is valid JSON;
- login attempts are persisted as valid JSON;
- login logs are valid JSON;
- card creation persists valid JSON;
- card-claim settings persist valid JSON;
- no atomic `.tmp` files leak after successful writes;
- corrupt `login-attempts.json`, `cards.json`, `card-claim.json` and `users.json` all fail closed and preserve a corrupt backup.

Command: `pnpm -C core persistence:user-store-selftest`.

## Merge order

This is a stacked PR and depends on PR #61 because it extends the critical JSON mechanism introduced there. Merge/rebase order must preserve that dependency; production deployment remains a later separate gate.

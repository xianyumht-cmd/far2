# FAR2 P4-001 Critical JSON Fail-Closed — 2026-08-20

## Problem

The shared tolerant JSON reader historically returned the same fallback for a missing file, an empty file, a read failure, or malformed JSON. This is convenient for caches, but unsafe for `accounts.json`.

`store.loadAccounts()` uses an empty account list as its first-run fallback. If an existing `accounts.json` becomes partial/corrupt and is silently read as the empty fallback, a later account mutation can persist that fallback and overwrite the recoverable corrupt bytes.

A second edge case exists when the JSON is syntactically valid but has the wrong top-level shape, for example `{}` without an `accounts` array. Treating that as an empty account state has the same overwrite risk.

## Fix

`json-db.js` now treats `accounts.json` as critical state while preserving tolerant behavior for non-critical cache/artifact JSON files.

Behavior:

- missing `accounts.json` still returns the first-run fallback;
- valid `{ accounts: [...] }` JSON parses normally;
- existing empty/malformed/unreadable JSON or invalid top-level shape throws `critical_json_corrupt` instead of returning an empty account list;
- when bytes are readable, the rejected file is copied once to a deterministic `.corrupt-<mtime>-<size>.bak` path before the error is returned;
- repeated reads of the same corrupt version do not create backup spam;
- non-critical JSON readers keep the historical tolerant fallback contract.

This intentionally makes account mutations fail closed when the authoritative file exists but cannot be trusted. It is safer to surface a recovery error than to erase account state.

## Regression

`core/scripts/critical-json-fail-closed-selftest.js` covers:

- first-run missing critical file;
- valid account JSON;
- malformed account JSON rejection;
- empty critical file rejection;
- syntactically valid but invalid-shape account JSON rejection;
- exact rejected-byte backup;
- repeat-read backup deduplication;
- tolerant non-critical JSON fallback.

The self-test is exposed as `persistence:critical-json-selftest`.

## Boundary

This fix does not globally make all JSON strict. User/security/card files are handled in the stacked P4-002 PR because `user-store.js` historically used direct writes and its own tolerant loaders.

Production deployment remains a separate gate.

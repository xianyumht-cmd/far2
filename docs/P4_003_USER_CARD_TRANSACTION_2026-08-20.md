# FAR2 P4-003 User/Card Cross-File Transaction — 2026-08-20

## Finding

P4-002 made each individual user/card/security JSON write atomic, but `registerUser()` and `renewUser()` still update **two authoritative files** as one business operation:

```text
users.json
cards.json
```

The old sequence was:

```text
mutate users + cards in memory
-> saveUsers()
-> saveCards()
```

Atomic rename protects each file separately, but it does not make the pair transactional. A process crash or second-file write failure after `users.json` is committed can leave users and card inventory disagreeing. In registration/renewal that can mean a granted entitlement while the card file still appears unused.

## Fix

This branch is stacked on P4-002 / PR #62.

A new `user-card-transaction.js` service adds a small crash-recovery journal:

```text
prepare journal (before + next snapshots)
-> atomically write users.json
-> atomically write cards.json
-> remove journal
```

`registerUser()` and `renewUser()` now take before-snapshots, mutate in memory, and persist the pair through this transaction helper. If persistence throws, in-memory state is restored to the before-snapshot and the error propagates.

## Crash recovery rules

On the next user/card load, a leftover journal is reconciled before the authoritative file is consumed:

- both files match `next` -> transaction had committed; remove journal;
- both files match `before` -> nothing committed; remove journal;
- one file is `next` and the other is `before` -> compensate both back to `before`, then remove journal;
- current files match neither expected snapshot -> fail closed with `user_card_transaction_inconsistent` and preserve journal evidence.

The transaction journal itself is critical JSON and must have the expected `version/before/next` array structure.

## Regression

`core/scripts/user-card-transaction-selftest.js` covers:

- normal two-file commit;
- crash after only `users.json` reached next-state -> rollback to before-state;
- crash after both files reached next-state but before journal cleanup -> recognize commit;
- crash before either authoritative write -> prepared no-op;
- injected second-file write failure -> compensating rollback succeeds;
- unexpected divergent state -> fail closed and leave journal for manual recovery.

Audit sandbox result: `node --check` + transaction self-test **PASS**. No production files were touched.

Command: `pnpm -C core persistence:user-card-transaction-selftest`.

## Dependency order

This is a stacked repair and depends on:

```text
#61 P4-001 critical accounts JSON
  -> #62 P4-002 user/security/card atomic + critical persistence
     -> this P4-003 cross-file transaction
```

Production merge/deployment remains a separate authorization gate.

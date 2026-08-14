# Activity Wire Evidence — 2026-08-14

## Purpose

Discover official ActivityService write methods without guessing a generic `Operate` protobuf.

## Capture filter

The official-client capture hook records only outgoing Gate requests where:

```text
service == gamepb.activitypb.ActivityService
message_type == request
method != List
method != GetGroup
```

Therefore the capture file does not intentionally include login/auth, farm, friend, task, shop, or other service traffic.

## Captured data

For each matching request:

- timestamp;
- transport label;
- service;
- method;
- encrypted business-body length;
- encrypted business-body hex.

After the cache files are restored, FAR2 locally decrypts only those filtered business bodies using the existing TSDK WASM and emits a generic protobuf-wire view.

No field gets a business name until independent evidence proves its meaning.

## Safety boundary

- FAR2 itself sends no ActivityService write during capture.
- The user must perform one intended action in the official farm client to create evidence.
- Known reads `List` and `GetGroup` are excluded.
- The capture hook temporarily modifies up to the 3 newest QQ farm `game.js` caches and restores the original bytes in `finally`.
- Captured data is stored under `%TEMP%/FAR2-ACTIVITY`.
- A captured method/body is evidence only; it does not automatically enable writes.

## Graduation to automatic adapter

For each activity structure, automatic execution still requires:

1. exact official method name;
2. repeatable request-wire shape;
3. business-field semantics supported by more than numeric coincidence;
4. read-side precondition proving the action is currently valid;
5. post-write read verification;
6. no automatic retry when write result is uncertain.

Until all six conditions are satisfied, `autoOperate=false` remains the default.

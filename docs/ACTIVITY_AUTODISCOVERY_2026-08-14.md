# Activity Auto-Discovery — 2026-08-14

## Goal

Move FAR2 from activity-specific hardcoding toward structure-driven discovery while keeping unknown activity writes fail-closed.

## Baseline

`activitypb.proto` currently exposes only:

- `ActivityService.List`
- `ActivityService.GetGroup`

There is intentionally no generic `Operate` request in FAR2. This remains the safety boundary until an official client request is captured and its business fields are proven.

## P5C-B: deep read-only discovery

The discovery chain is:

```text
ActivityService.List
  -> choose active root groups (visible first)
  -> ActivityService.GetGroup for each selected root
  -> normalize full ActivityNode tree
  -> classify capabilities and structure fingerprints
  -> collect potential seed/reward item IDs
  -> surface potential actions as autoOperate=false
```

Default safety/resource boundary:

- no more than 12 active root `GetGroup` reads per discovery pass;
- reads are sequential;
- one group failure does not abort the remaining groups;
- hidden-but-active root groups remain discoverable after visible roots;
- not-yet-active groups are not probed by default.

## Capability model

A node may expose:

- random shop;
- exchange shop;
- draw pool;
- JSON or raw payload;
- child activity nodes.

The classifier emits a structural fingerprint from activity type, capability set, payload keys, and child types. This is intended to let future adapters match structures rather than hardcoded event titles or IDs.

## Potential action model

Read-only state may reveal candidates such as:

- remaining free draw count;
- random-shop entries with remaining stock;
- exchange entries not yet owned;
- item/seed IDs referenced by rewards or payload.

These are only **signals**. Every candidate has:

```text
autoOperate=false
reason=activity-write-schema-unproven
```

A future adapter may become writable only after evidence proves:

1. official service + method;
2. exact request wire fields;
3. server-side precondition that makes the write valid;
4. a post-write read that can verify the result;
5. retry policy that never duplicates an uncertain write.

## P5C-C: write evidence layer

Next evidence work should capture outgoing official-client `gamepb.activitypb.ActivityService` requests while excluding known read methods `List` and `GetGroup`.

The evidence collector should:

- record method names and encrypted business bodies only;
- decrypt bodies locally with the existing FAR2 TSDK WASM;
- generic-wire parse fields without inventing protobuf names;
- avoid login/auth traffic and credentials;
- restore modified QQ miniapp cache files after capture.

Only captured/proven activity structures can graduate to an automatic write adapter. Unknown activity structures remain read-only.

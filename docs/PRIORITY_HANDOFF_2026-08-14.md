# FAR2 Priority Handoff — 2026-08-14

## Accepted baseline

### P7E dog-food / pet-care

- COMPLETE / ACCEPTED.
- PR #46 merged to `main`.
- Real E2E: `DogService.AddFood` with 3-day food `90005`, inventory `9 -> 8`, post-read verification passed.
- Field 2 business semantics remain unproven; FAR2 only reproduces the observed fixed value `1`.
- Do not continue expanding pet features unless a regression or explicit new requirement appears.

### Friend patrol observability / post-EXP help backoff

- COMPLETE / ACCEPTED.
- PR #47 merged to `main` as merge commit `0ae4b2dea489fc61adb08ed14c241ef6fb7adca9`.
- User confirmed stealing itself works and accepted the logging/backoff behavior.
- Stealing core logic was not redesigned.

### Event/activity seed auto-discovery + priority planting

- COMPLETE / ACCEPTED.
- PR #48 merged to `main` as merge commit `ab2480960fe81e8b80a90936be3a5cee74836790`.
- Windows validation ran against exact PR head `5e59fa81130084c76433b77eb7d12f31908740c3`.
- New event-seed suite, existing 2x2, planting-service, farm-orchestrator, Activity readonly, syntax and diff checks all passed.
- FAR2Farm restarted and remained `Running` during natural runtime observation.
- No unknown seed footprint is trial-planted.
- QQ-cache learning requires direct same-object `seed_id/seedId + size` evidence.
- Learned 1x1/2x2 special seeds can be consumed before ordinary shop fallback without requiring `bag_priority`.
- Pending 2x2 seeds reserve only necessary land footprint; unrelated empty land can continue normal planting.

## Active priority — automatic activity discovery / participation / claiming

Current branch:

`feature/activity-autodiscovery-20260814`

Goal:

```text
new activity
  -> discover structure
  -> classify capability / reward / seed references
  -> match only a proven write adapter
  -> revalidate server precondition
  -> perform one proven action
  -> post-read verify
  -> event seed enters the already-accepted seed-learning / priority-planting chain
```

Unknown activity structures remain read-only.

### P5C-B — deep read-only discovery

Implemented on the current branch.

Existing `/api/activities` / Worker `listActivities` path is preserved. The old List-only top-level contract remains compatible, while the readonly module now adds deep discovery through:

```text
ActivityService.List
  -> choose active root groups (visible first)
  -> ActivityService.GetGroup, sequential, max 12 roots per scan
  -> normalize full ActivityNode trees
  -> structure fingerprints
  -> capability / reward / seed-like item classification
```

Capabilities currently classified:

- random shop;
- exchange shop;
- draw pool;
- JSON/raw payload;
- child activity nodes.

Potential actions such as free draw / exchange / random-shop opportunities are surfaced as signals only:

`autoOperate=false`

No generic activity write RPC has been added.

Compatibility / resource rules:

- current `activity-readonly.js` path is a thin compatibility wrapper;
- the previously accepted List implementation is copied unchanged to `activity-readonly-base.js`;
- deep discovery failure falls back to the old List-only response;
- successful deep discovery is cached for 60 seconds;
- one GetGroup failure does not abort remaining groups;
- not-yet-active roots are not probed by default.

### P5C-C — official ActivityService write evidence capture

Implemented on the current branch, not yet used for a real activity action.

Tool:

`pnpm -C core activity:wire-capture`

It temporarily instruments up to the 3 newest official QQ Farm `game.js` caches and captures only outgoing requests where:

```text
service == gamepb.activitypb.ActivityService
message_type == request
method != List
method != GetGroup
```

The capture contains only method + encrypted ActivityService business body. FAR2 itself sends no activity write during capture.

After the official action finishes, the tool restores the original QQ cache bytes before decoding evidence. A dedicated selftest verifies the restore path with temporary files.

Captured request bodies are decrypted locally with the existing TSDK WASM and generic-wire parsed without assigning guessed business field names.

### Write-adapter graduation rule

An activity structure may become automatically writable only after all of these are proven:

1. exact official service + method;
2. repeatable request-wire shape;
3. business semantics for required fields;
4. readonly server precondition proving the action is valid now;
5. post-write readonly verification;
6. no automatic retry when the write result is uncertain.

Until then, `autoOperate=false`.

## Current validation target

Before merging the activity branch:

1. run `activity:readonly-selftest`;
2. run `activity:discovery-selftest` including the wire-capture parser/restore selftest;
3. run event-seed regressions to ensure the new activity wrapper remains compatible with seed discovery;
4. build WebUI / syntax / diff checks;
5. restart FAR2Farm on the branch and query `/api/activities` once;
6. save the real List+GetGroup discovery snapshot;
7. keep the PR Draft until the readonly runtime result is reviewed.

The write-evidence capture is a separate later action because it requires one real action in the official client. Prefer a free/claimable harmless activity action; do not use a paid draw or paid exchange merely for evidence.

## Priority rule

Do not return to pet expansion. Do not reopen stealing core unless a real regression appears.

Current order:

1. validate and merge deep activity discovery / evidence tooling;
2. use official-client evidence to prove the first safe activity write adapter;
3. expand adapters by structure fingerprint, not by hardcoded event title/ID.

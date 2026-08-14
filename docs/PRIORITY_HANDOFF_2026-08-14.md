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

## Active priority — event/activity seeds in bag

Current branch:

`feature/event-seed-autodiscovery-20260814`

Goal:

- recognize activity/event seeds already present in the bag before buying ordinary shop seeds;
- support both 1x1 and 2x2 event crops;
- work under normal account planting strategies, not only `bag_priority`;
- automatically learn new seed mappings from official local evidence when possible;
- fail closed for genuinely unknown mappings: never trial-plant an unknown footprint.

### A-stage — discovery + pre-shop priority

Implemented on the feature branch.

Evidence sources:

- Bag items;
- existing Plant config / proven static fallbacks;
- ItemInfo seed metadata;
- readonly `ActivityService.List` structures;
- normal seed-shop membership.

Behavior:

- known special/event 1x1 seed -> plant from bag before ordinary shop fallback;
- known special/event 2x2 seed -> existing four-land PlantService path before ordinary shop fallback;
- unresolved high-confidence seed -> zero trial writes, preserve the opportunity and record evidence;
- namespace-only medium candidate -> record/learn, but do not permanently stall a healthy farm without stronger evidence.

Runtime discovery state:

`core/data/seed_discovery/<account>.json`

### B-stage — official QQ-cache automatic learning

Implemented on the feature branch.

For an unresolved seed-like item, FAR2 can inspect local official QQ Farm miniapp cache:

`%APPDATA%\QQEX\miniapp\temps\miniapp_src\1112386029_3_*`

Strict readonly proof rule:

- `seed_id=<target>` / `seedId=<target>` and `size` must be **direct fields at the same object level**;
- nested parent/child fields cannot be combined;
- raw `size=0/1` -> 1x1;
- raw `size=2` -> 2x2;
- conflicting/unsupported values -> reject;
- a numeric ID coincidence alone is never enough.

Positive deterministic mappings are persisted to:

`core/data/seed_discovery/qq_cache_learned.json`

Negative scans are memory-cached for 10 minutes to avoid repeatedly scanning QQ cache every farm tick.

Learned mappings are injected only into the bag/event-seed priority layer. They do not automatically become ordinary shop-buy candidates.

### 2x2 reservation safety

A pending learned/special 2x2 seed does not lock every empty land.

The shop wrapper reuses the existing 2x2 reservation planner:

- reserve only the needed 2x2 footprint;
- let unrelated empty land continue the original planting strategy;
- if the unlocked layout cannot form a reservable 2x2 group, do not permanently stall normal planting;
- real 1x1 special-seed partial/write failures remain fail-closed for that cycle.

### Offline verification

Unified command:

`pnpm -C core event-seed:selftest`

It covers discovery, shop classification, activity evidence, persistence, zero-write unknowns, known 1x1/2x2 priority planting, QQ-cache direct-field proof/rejection, learned mapping integration, confidence guard, and 2x2 reservation behavior.

Before merging this feature branch:

1. run the unified event-seed selftest;
2. run existing 2x2 / planting-service / farm-orchestrator regressions;
3. run syntax/diff checks;
4. perform one natural Windows FAR2 runtime observation on the feature branch;
5. inspect any generated `core/data/seed_discovery/*.json` and logs before deciding merge.

## Next priority — automatic activity participation / claiming

After event-seed identification/priority planting is accepted:

- discover new activity groups/nodes/rewards/seed sources from readonly activity structures;
- classify activity structures instead of hardcoding every activity ID;
- automatically execute only activity write schemas that have been proven;
- keep unknown activity structures readonly and collect evidence;
- cover activities that provide both 1x1 and 2x2 seeds.

## Priority rule

Do not return to pet expansion. Do not reopen the stealing-core investigation unless a real regression appears.

Current order:

1. finish and accept event-seed auto-discovery / priority planting;
2. automatic activity discovery / participation / claiming.

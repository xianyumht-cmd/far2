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
- Post-EXP help targets are narrowed to current help-needed guard-dog friends; no eligible target backs off help scans.
- Steal idle/status logs are low-noise and rate-limited.

## Active priority — event/activity seeds in bag

Current branch:

`feature/event-seed-autodiscovery-20260814`

Goal:

- recognize activity/event seeds already present in the bag before buying ordinary shop seeds;
- support both 1x1 and 2x2 event crops;
- work under normal account planting strategies, not only `bag_priority`;
- automatically learn new seed mappings from official local evidence when possible;
- fail closed for unknown mappings: preserve the item and never trial-plant an unknown footprint.

### A-stage — discovery + pre-shop priority layer

Implemented on the feature branch.

The new event-seed pre-shop layer combines evidence from:

- Bag items;
- existing Plant config / proven static fallbacks;
- ItemInfo seed metadata;
- readonly `ActivityService.List` structures;
- normal seed-shop membership.

Behavior:

- known special/event 1x1 seed -> plant from bag before ordinary shop fallback;
- known special/event 2x2 seed -> use existing four-land planting path before ordinary shop fallback;
- unresolved high-confidence seed -> do not trial-plant; protect the seed opportunity and record evidence;
- unresolved namespace-only medium candidate -> record/learn, but do not permanently stall a healthy farm when stronger evidence is absent.

Runtime discovery evidence is stored under:

`core/data/seed_discovery/<account>.json`

### B-stage — local QQ-cache automatic learning

Implemented on the feature branch.

For an unresolved seed-like item, FAR2 can inspect local official QQ Farm miniapp cache:

`%APPDATA%\QQEX\miniapp\temps\miniapp_src\1112386029_3_*`

Readonly proof rule:

- the same containing official-cache object must contain exact `seed_id=<target>` / `seedId=<target>`;
- exactly one non-conflicting `size` must be present;
- `size=0/1` -> 1x1;
- `size=2` -> 2x2;
- conflicting/unsupported size -> reject learning;
- a numeric ID coincidence alone is never enough.

Positive deterministic mappings are persisted to:

`core/data/seed_discovery/qq_cache_learned.json`

Negative scans are memory-cached for 10 minutes to avoid repeatedly scanning QQ cache every farm tick.

The learned mapping is injected only into the bag/event-seed priority layer. It does not automatically add a new seed to ordinary shop-buy candidates.

### Safety/resource boundaries

- no new Farm/Shop RPC schema is invented;
- actual planting reuses the already-validated `PlantService.Plant` chain;
- unknown footprint -> zero Plant write;
- max QQ-cache file size: 32 MiB;
- max files per learning scan: 300;
- max bytes per learning scan: 192 MiB;
- newest three farm cache folders only;
- static known seeds do not trigger cache scanning;
- obvious non-seed items do not trigger cache scanning.

### Offline verification on the feature branch

Unified command:

`pnpm -C core event-seed:selftest`

It covers:

- unknown 20xxx item is retained rather than silently discarded;
- known / unresolved seed separation;
- normal seed-shop membership classification;
- readonly activity references as discovery evidence;
- discovery-state persistence;
- unresolved seed causes zero plant writes;
- known non-shop 1x1 seed is consumed before ordinary shop strategy;
- known non-shop 2x2 seed uses the four-land path;
- locked special seed is not consumed;
- QQ cache same-object `seed_id + size` learning for 1x1 and 2x2;
- numeric coincidence / conflicting size rejection;
- learned mapping enters the event-seed priority path;
- high-confidence unknown vs namespace-only medium shop-block safety gate.

Before merging this feature branch, run existing planting/farm regression tests as well and perform one natural Windows runtime observation.

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

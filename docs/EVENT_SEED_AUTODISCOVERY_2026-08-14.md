# Event seed auto-discovery / priority planting — 2026-08-14

## Goal

When FAR2 has activity/special seeds in the bag, use them before buying ordinary seed-shop seeds.

The implementation must support:

- known 1x1 activity/special seeds;
- known 2x2 activity/special seeds;
- new bag item IDs that look like seeds but are not yet present in local Plant.json;
- readonly activity metadata as additional discovery evidence;
- future learning without requiring a new hardcoded activity-ID branch every time.

## Current root cause

Before this change, the planting path depended on `getPlantBySeedId(seedId)`.

If the local `Plant.json` did not know a new event seed, `warehouse.getBagSeeds()` discarded the item. Normal strategies such as `max_exp` then continued to the regular seed shop and bought ordinary seeds.

There was also a second gap: known 1x1 bag seeds were only consumed first when the whole account strategy was `bag_priority`. The independent prepass covered 2x2 seeds, not normal-size event seeds.

## A-stage architecture

This stage adds a pre-shop guard in the farm facade. It does not replace the existing planting engine.

Flow:

1. The normal farm orchestrator finds empty land.
2. Existing 2x2 prepass keeps running unchanged.
3. Immediately before the ordinary seed-shop fallback, `event-seed-priority.js` runs.
4. It reads the bag and builds seed evidence from:
   - existing Plant config / proven seed fallback;
   - ItemInfo type=5;
   - ItemInfo `interaction_type=plant`;
   - seed-like item name;
   - seed ID namespace (`20xxx`) as a non-writing candidate heuristic;
   - readonly ActivityService.List references;
   - membership in the normal seed shop.
5. A seed is automatically planted only when its Plant mapping is already resolved and its footprint is known as 1x1 or 2x2.
6. Resolved seeds that are activity-referenced or absent from the normal seed shop are consumed before the ordinary shop strategy.
7. Unresolved candidates are never trial-planted. They block ordinary shop fallback for that cycle and are written to:
   `core/data/seed_discovery/<account>.json`
8. The remaining empty land is passed back to the original shop strategy only when the prepass says it is safe.

## Safety boundary

Unknown item IDs are evidence, not write permission.

An unresolved 20xxx item can cause FAR2 to delay ordinary shop planting, but cannot cause PlantService.Plant.

No new RPC is introduced. Actual planting reuses the already-tested `PlantService.Plant` implementation from `planting-service.js`.

For 2x2 seeds, the same existing `selectReady2x2Groups` / `plant2x2Seed` chain is reused.

If bag inspection fails, the pre-shop guard fails closed for that cycle rather than buying ordinary seeds with incomplete evidence.

Level-locked resolved special seeds are not consumed and do not block normal planting.

## Learning state

`seed_discovery/<account>.json` keeps evidence across runs:

- seed ID and last count;
- first/last seen time;
- resolved or unresolved;
- known footprint;
- ItemInfo evidence;
- activity reference;
- whether the item appears in the normal seed shop;
- whether it is currently considered a special/event candidate;
- confidence/evidence list.

The state file is runtime data and is not committed.

## Next B-stage

A-stage deliberately does not guess the footprint of a never-seen seed.

B-stage should enrich unresolved entries automatically from local official-client evidence:

1. inspect QQ miniapp cache/config for the unresolved seed ID;
2. extract nearby plant metadata when available (`seed_id`, plant name, footprint/size, level);
3. correlate activity payload/group metadata;
4. promote an unresolved entry to a learned mapping only when evidence is deterministic;
5. keep the learned mapping account-independent where the official config proves it;
6. continue fail-closed when footprint cannot be proven.

After B-stage, a new event should ideally progress:

`Bag new seed -> discover -> official config evidence -> learn 1x1/2x2 -> priority plant`

without requiring a new FAR2 release for every activity.

## Test contract

`core/scripts/event-seed-priority-selftest.js` must remain offline.

It covers:

- unknown 20xxx item is retained instead of silently discarded;
- normal shop membership classification;
- readonly activity reference collection;
- discovery evidence persistence;
- unresolved candidates perform zero plant writes and block shop fallback;
- known non-shop 1x1 seed plants before shop;
- known non-shop 2x2 seed uses the four-land path;
- level-locked special seed is left untouched without blocking normal planting.

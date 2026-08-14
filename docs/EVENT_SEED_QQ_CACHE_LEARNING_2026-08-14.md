# QQ-cache seed learning — 2026-08-14

## Purpose

This is the B-stage for event seed auto-discovery.

When a bag item looks like a seed but local `Plant.json` has no mapping, FAR2 may inspect the local official QQ miniapp cache and learn the seed footprint without requiring a hardcoded FAR2 update.

This is a local readonly process. It does not call QQ Farm RPC and does not modify QQ cache files.

## Trigger boundary

Runtime learning is attempted only when the static plant resolver misses and the item is seed-like:

- ItemInfo `type == 5`; or
- ItemInfo `interaction_type == plant`; or
- ItemInfo name contains `种子`; or
- the ID is in the normal seed namespace `20000..29999`.

Known static seeds never trigger the cache scanner.

Non-seed bag items never trigger the cache scanner.

A negative scan result is cached in memory for 10 minutes, so an unresolved ID does not rescan the whole QQ cache every farm tick.

Positive learned mappings are persisted in:

`core/data/seed_discovery/qq_cache_learned.json`

and are reused without rescanning.

## Official-cache scan limits

The scanner only reads the newest three QQ Farm miniapp cache folders matching:

`%APPDATA%\QQEX\miniapp\temps\miniapp_src\1112386029_3_*`

Candidate file extensions:

- `.js`
- `.mjs`
- `.cjs`
- `.json`

Safety/resource limits:

- max single file: 32 MiB
- max files per scan: 300
- max total bytes per scan: 192 MiB
- likely plant/config/item files are examined first

## Strict proof rule

A numeric match is not enough.

FAR2 only learns a footprint when **the same direct object level** has both:

- exact direct field `seed_id: <target>` or `seedId: <target>`; and
- exactly one non-conflicting direct field `size`.

Nested fields are masked before proof extraction. Therefore these are rejected:

- parent `size` + child `seed_id`;
- parent `seed_id` + child `size`;
- `item_id=<target>` with an unrelated `size`;
- two conflicting direct `size` values.

Accepted footprint mapping:

- raw `size = 0` -> 1x1
- raw `size = 1` -> 1x1
- raw `size = 2` -> 2x2

Other values are rejected.

If multiple official-cache hits disagree on the footprint, learning fails closed.

The learner may also collect direct `name` and `land_level_need` when they are unambiguous, but these are not required to prove the footprint.

## Runtime use

`learned-seed-resolver.js` keeps the original static config first.

Resolution order:

1. existing `Plant.json`;
2. existing proven static fallback such as seed `20046`;
3. persisted deterministic QQ-cache mapping;
4. one bounded readonly QQ-cache scan;
5. unresolved / no write.

A learned mapping is only injected into the event-seed pre-shop priority layer. It is not added to the ordinary seed-shop candidate list.

Therefore a learned event seed can be planted from the bag, but FAR2 will not start buying that seed from the normal shop unless the normal shop itself exposes it.

## Medium vs high confidence unknowns

A pure `20xxx` namespace match is only medium confidence.

If cache learning fails and there is no stronger ItemInfo/activity evidence, FAR2 records the candidate but does not permanently stop ordinary farming.

High-confidence unresolved candidates remain protected:

- ItemInfo proves seed semantics; or
- readonly activity metadata references the item.

The outer shop guard honors the protective block for high-confidence unknowns and for known-seed write/probe failures.

## 2x2 waiting behavior

A learned/special 2x2 seed must not make every empty land stay empty indefinitely.

`event-seed-shop-wrapper.js` reuses the existing `select2x2Reservations` planner:

- reserve only the land footprint needed by the pending 2x2 seed;
- allow unrelated empty land to continue through the user's original shop strategy;
- if the currently unlocked farm layout cannot form any reservable 2x2 group, allow normal planting instead of permanently stalling the farm;
- a real 1x1 special-seed partial/write failure remains fail-closed for that cycle.

## Tests

Unified offline command:

`pnpm -C core event-seed:selftest`

It includes:

- `event-seed-priority-selftest.js`
- `qq-seed-config-learner-selftest.js`
- `learned-seed-resolver-selftest.js`
- `event-seed-shop-guard-selftest.js`
- `event-seed-shop-wrapper-selftest.js`

The QQ-cache parser tests explicitly cover parent/child field-crossing rejection in addition to 1x1/2x2 positive fixtures and conflicting-hit rejection.

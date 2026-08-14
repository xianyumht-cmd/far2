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

## Proof rule

A numeric match is not enough.

FAR2 only learns a footprint when the same containing object has:

- exact `seed_id: <target>` or `seedId: <target>`; and
- exactly one non-conflicting `size` value.

Accepted footprint mapping:

- raw `size = 0` -> 1x1
- raw `size = 1` -> 1x1
- raw `size = 2` -> 2x2

Other values are rejected.

If multiple cache hits disagree on the footprint, learning fails closed.

The learner may also collect `name` and `land_level_need` when they are unambiguous, but these are not required to prove the footprint.

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

## Tests

Offline tests:

- `core/scripts/qq-seed-config-learner-selftest.js`
  - 1x1 parse
  - 2x2 parse
  - conflicting-size rejection
  - numeric-coincidence rejection
  - minified-bundle object extraction
  - inconsistent-hit rejection

- `core/scripts/learned-seed-resolver-selftest.js`
  - known static seeds do not scan
  - non-seed items do not scan
  - unknown seed upgrades only with deterministic evidence
  - learned mapping enters the existing event-seed priority planting path

- `core/scripts/event-seed-shop-guard-selftest.js`
  - known-seed failures remain fail-closed
  - high-confidence unknowns block shop
  - namespace-only medium candidates do not permanently block
  - activity references preserve the protective block

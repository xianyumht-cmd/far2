# Official configuration import — 2026-11-16

Source: `FAR2_RUNTIME_EVIDENCE_2026-11-15.zip` (user-captured QQ classic farm mini-program
`1112386029`, client `1.16.3.8`). These tables were decoded from the client's own config TextAssets,
so they are the authoritative game data for this build — not a fork snapshot, and not a hand-edited
table. No other repository's 318/1066 tables were used.

## Imported tables

| Table | Records | Imported SHA256 | Bytes | Source SHA256 |
|---|---|---|---|---|
| `core/src/gameConfig/Plant.json` | 318 | `d83aacb7238f0cfc…` | 325,032 | `60ee10265e369e96…` |
| `core/src/gameConfig/ItemInfo.json` | 1,066 | `52ed33587eece591…` | 843,505 | `f9639ffda2e816a1…` |

Full digests, field lists and per-table policy are recorded in
`core/src/gameConfig/OFFICIAL_CONFIG_SOURCE.json` (schema `far2.official-config-import/v1`).

Field policy: **official field names and raw values are preserved**. No renaming, no value back-fill,
no synthetic defaults. Where the official row set differs from the previous hand-maintained table, the
official row wins and the difference is documented below.

## Structural facts

- `Plant.size` only ever contains `null` (295 rows) or `2` (23 rows). `null` is the single-tile crop;
  `2` is the four-tile crop. 87 rows have `seed_id: null` (golden variants, tower/dairy constructs).
- 2×2 crops that carry a real `seed_id` (7): `29998` 哈哈南瓜, `20046` 爱心果, `20416` 哈哈南瓜,
  `21032` 琉璃宝荷, `29003` 星语铃花, `29004` 泡泡棉花糖, `29005` 森野黄金芽.
- All 31 historically unresolved seed ids are present in the official table (31/31).
- `ItemInfo` holds 240 `type=5` seed rows; **9 of them have no `Plant` row** in this build
  (`20040, 20092, 20111, 20114, 20118, 20123, 20130, 20136, 20219`). Those 9 are the genuine
  configuration gaps and are the only ids that should reach the "config missing" record.

## Code compatibility notes

- `plant.mutant` is read by nothing in `core/src` (0 references), so the official table not carrying
  that legacy field is safe.
- `item.price` / `priceUnit` are display-only (`warehouse.js`, `catalog-api.js`,
  `appearance.js`); `Number(undefined) || 0` degrades to `0` instead of throwing. Official
  `ItemInfo` has no `price` column, so item prices now render as `0/未提供` rather than a stale
  hand-maintained value. Shop prices still come from the live `ShopInfo` response.
- `size` decoding already normalises `null` to `1` (`Math.max(1, Number(plant.size) || 1)`), so no
  migration shim is needed.

## ID adjudications carried over from the evidence pack

- `20264` = **帝王血** (official). "红色郁金香" is an unlock-card alias (`item 30264`, same `Crop_264`
  asset), which is why the old hand-maintained table displayed it.
- `26032 月见草`, `21353 紫薇`, `21050 萱草` — all `size: null`, i.e. ordinary 1×1 crops.
- `29999` = 白萝卜种子 (`size: null`, item level 1). It is a real crop row, but it is **not** in the
  current seed shop (152 listings span 20001–21111), so it can never be auto-purchased; it can only be
  planted if the account already holds it.
- `ItemInfo.level` is **not** a planting gate (Lv104 accounts in the field are growing crops whose
  item level is 200). Planting eligibility continues to use `Plant.land_level_need`, and
  `event-seed-priority.js` no longer substitutes `ItemInfo.level`.

## Verification

`core/scripts/official-config-seed-regression-selftest.js` (registered as
`pnpm official-config:selftest` and appended to `test:regression`) asserts, against these real tables:

1. table sizes, `size` domain, 31/31 coverage, exact 2×2 seed list;
2. `size:null → 1×1`, `size:2 → 2×2`;
3. a normal store seed resolves as `proven-config` and never enters unknown learning;
4. a genuine config gap is recorded but neither blocks the shop fallback nor invents a level gate;
5. absence from the shop does not make a 2×2 seed an event seed; a known non-seed item is not a
   seed candidate; ids that `ItemInfo` cannot describe still surface as namespace hints;
6. a live 2×2 footprint (server `slave_land_ids`) is detected and its slave plots are never selected
   for a new group;
7. a zero 2×2 budget releases the reservation;
8. 2×2 plant replies with a missing master or wrong slave ownership are rejected (no blind retry).

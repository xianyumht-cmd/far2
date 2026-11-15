# FR3GB: verified seed configuration and land recovery

Scope: dev/fr3gb only. Never overwrite the running `D:\project2\far2` tree as part of source development.

## Evidence package

`FAR2_RUNTIME_EVIDENCE_2026-11-15.zip` (user-supplied QQ PC miniapp 1.16.3.8 snapshot):
- `01_official_configs/plants/Plant.official.json`: 318 rows;
- `01_official_configs/items/ItemInfo.official.json`: 1,066 rows;
- 31 previously unresolved seed IDs are present in the captured Plant table;
- `29003`, `29004`, `29005` are confirmed size 2; most others have null (normal 1x1).
- `02_crop_identity/` and `03_farm_runtime/` contain identity and 2x2 evidence.
- The historical deployed files were 129 Plant rows and 451 ItemInfo rows.

**Do not substitute another fork's 318/1066 tables:** same record counts do not guarantee identical records. The user-supplied captured files are the source of truth for the upcoming import.

## Current guard fix

- Known non-seed items are not discovered by numeric ID alone.
- Missing Plant metadata no longer borrows `ItemInfo.level`.
- Unknown seed-like inventory is recorded as `config_missing_seed`, not automatically treated as a special 2x2 crop.
- Unresolved seeds never reserve any land; shop planting remains eligible.
- Explicit known 1x1/2x2 write or probe failure still blocks unsafe same-cycle fallback.
- Verified 2x2 seeds continue to use the existing four-land geometrical path.

## Next local import using the source ZIP

1. Extract the ZIP under an isolated directory, not the running FAR2 tree.
2. Compare the decoded Plant/ItemInfo files against `core/src/gameConfig/` using seedId, plantId, fruitId, size and item identity; detect duplicate/conflicting IDs.
3. Import the **captured** 318 Plant and 1066 ItemInfo arrays into `D:\project2\fr3gb\core\src\gameConfig\`, retaining the JSON schema unchanged.
4. Validate `size:null` as the game's single-tile default and `size:2` as the four-tile crop; keep both raw tables unaltered.
5. Run `node core/scripts/event-seed-priority-selftest.js`, `node core/scripts/event-seed-shop-guard-selftest.js`, `node core/scripts/event-seed-shop-wrapper-selftest.js`, `node core/scripts/event-seed-empty-farm-regression-selftest.js` and `pnpm -C core test`.
6. Commit and push only on `dev/fr3gb` with no forced rewrite, then publish a digest and discrepancy summary.

No production deployment is implied by this work.

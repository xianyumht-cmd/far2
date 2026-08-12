# P2B/P2C Source Scope

- Lv5 is treated as purple land in runtime fertilizer filtering.
- Legacy four-type all-selected fertilizer scope remains equivalent to all lands after upgrade.
- Bag-priority planting can consume known 2x2 seeds only when a complete legal 2x2 empty group exists.
- Seed 20046 (爱心果) has an explicit 2x2 fallback because the old local Plant.json does not contain it.
- 2x2 shop auto-purchase stays disabled until bag 2x2 live acceptance passes.
- No destructive land operation is required for acceptance; wait for natural harvest and an empty 2x2 group.

# FAR2 Priority Handoff — 2026-08-14

## Accepted baseline

- P7E dog-food / pet-care current chain is complete and accepted.
- PR #46 merged to `main`.
- Real E2E: `DogService.AddFood` with 3-day food `90005`, inventory `9 -> 8`, post-read verification passed.
- Field 2 business semantics remain unproven; FAR2 only reproduces the observed fixed value `1`.
- Do not continue expanding pet features unless a regression or explicit new requirement appears.

## Active priority

### 1. Friend patrol observability / post-EXP help backoff

Stealing itself has been checked in the live backend and is working. Do **not** redesign stealing.

Current task:
- stop repeated post-EXP help loops caused by “any cached guard dog exists” when no current guard-dog friend actually needs help;
- preserve guard-dog help priority;
- after EXP cap and no current eligible guard-dog help target, back off help scanning to at least 60 seconds;
- keep steal scheduling independent;
- add low-noise steal status:
  - no stealable friends;
  - daily steal limit reached;
  - targets found but no successful steal;
- idle steal logs should emit on state change, otherwise no more than once every 5 minutes.

## Next priorities

### 2. Existing event seeds in bag: identify and plant first

Goal:
- recognize unknown activity/event seeds already present in bag instead of buying ordinary shop seeds;
- support both 1x1 and 2x2 event crops;
- prefer safe automatic discovery/learning from Bag + ItemInfo + plant/seed config + activity readonly data;
- fail closed for unknown mappings: preserve the item, do not consume or guess;
- event/bag seeds should be considered before ordinary shop purchase where safely identified.

### 3. Automatic activity discovery / participation / claiming

Goal:
- reduce hardcoded per-activity updates;
- discover new activity groups/nodes/rewards/seed sources from readonly activity structures;
- classify known structures and execute only proven write schemas;
- unknown activity structures stay readonly and collect evidence;
- support activities that provide both 1x1 and 2x2 seeds.

## Priority rule

Do not return to pet expansion after P7E. Finish the active friend/log task first, then event-seed recognition/planting, then activity participation/claiming.

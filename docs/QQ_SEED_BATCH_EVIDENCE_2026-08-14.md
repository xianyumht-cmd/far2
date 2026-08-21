# QQ 背包未知种子批量证据扫描（2026-08-14）

## 目标

一次只读扫描最近 QQ 经典农场小程序缓存，对多个 seed-like ID 同时收集证据，避免每个 ID 重复读取同一批缓存文件。

当前实机目标：

- 20264（背包已显示“红色郁金香”）
- 21037
- 21050
- 21221
- 21251
- 26032
- 29003

80001“化肥(1小时)”只作为负面边界：活动引用、item_id 或普通数字出现都不能证明它是种子。

## strict proof

只有同一个对象的直接字段同时满足以下条件，才允许写入 `core/data/seed_discovery/qq_cache_learned.json`：

1. `seed_id:<target>` 或 `seedId:<target>`；
2. 同层只有一个不冲突的 `size`；
3. `size=0/1` 解释为 1x1；`size=2` 解释为 2x2；其它值拒绝。

禁止：

- 父对象 `size` + 子对象 `seed_id` 拼接；
- 子对象 `size` + 父对象 `seed_id` 拼接；
- 仅 `item_id` 命中；
- 仅数字巧合；
- 同层 `size` 冲突；
- 跨文件 footprint 冲突时猜测。

## 批量报告

`core/scripts/qq-seed-batch-scan.js` 默认扫描当前 7 个 ID，也接受命令行 ID。

每个 ID 输出：

- `proven`：是否已经达到 strict proof；
- `name`：直接对象名称线索或 ItemInfo 名称；
- `plantSize`：仅 proven 时为 1/2；
- `numericOccurrences`：数字出现次数，仅作诊断；
- `directSeedIdClueCount`：同层 direct `seed_id` 线索数；
- `validDirectHitCount`：满足 strict proof 的命中数；
- `clueNames / clueRawSizes`；
- `sourceFiles / sourceFolders`；
- unresolved reason。

报告写入 `%TEMP%\FAR2-SEED\qq-seed-batch-scan-*.json`。

## 安全边界

- 不连接 QQ 网络；
- 不发送任何 RPC；
- 不购买；
- 不发送 PlantService.Plant；
- 不修改 QQ 小程序缓存；
- 只允许将 proven 结果持久化到 FAR2 自己的 learned cache；
- 未证明 footprint 的 ID 继续由现有事件种子保护/预留逻辑处理，绝不盲试种。

## 与现有运行时的关系

一旦 proven mapping 写入 `qq_cache_learned.json`，现有 `learned-seed-resolver.js` 会优先复用该持久化映射，并生成 runtime learned plant。随后现有 event-seed pre-shop priority 会在普通商店补种前优先消费已识别的特殊/活动背包种子。

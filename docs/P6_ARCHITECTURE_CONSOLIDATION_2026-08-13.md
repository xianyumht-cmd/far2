# FAR2 P6 — Farm 架构收口计划 — 2026-08-13

状态：**P6A IMPLEMENTED + VALIDATED / P6B+ PLANNED**

## 背景

P0～P5 的主要安全功能扩展完成后，继续增加功能的边际收益已经低于结构治理收益。

当前 FAR2 的主要结构债是 `core/src/services/farm.js` 仍承担过多职责：

- Farm RPC；
- 土地 DTO / master-slave 分析；
- 土地生命周期判断；
- 施肥策略；
- 商店选种；
- 背包种植；
- 2x2 前置种植；
- 自动收获后的状态判断；
- 巡田 orchestrator；
- scheduler；
- 化肥购买定时器。

成熟实现已经把同一领域拆成：

```text
farm.js                 -> 纯聚合导出 / public facade
farm-api.js             -> Farm/Shop 原始 RPC
farm-land-analyzer.js   -> 土地 DTO / 生命周期 / master-slave
farm-fertilizer.js      -> 施肥目标与策略
planting-service.js     -> 商店/背包/2x2 种植
farming-orchestrator.js -> 一轮巡田业务编排
farm-scheduler.js       -> 循环 / push 触发
```

FAR2 P6 的目标不是照抄文件，而是采用同样的**职责边界**，保留 FAR2 已验收行为。

## 核心约束

1. **不做一次性大重写。** 每个 PR 只迁移一块职责。
2. **先契约测试，再搬代码。** 迁移 PR 不顺带改业务策略。
3. **对外 API 不变。** 现有 `require('./farm')` / Worker 调用不需要跟着每次内部迁移修改。
4. **`farm.js` 最终变 facade/barrel，但不是第一步直接替换。**
5. CodeManager、V4 好友采集、Catalog、P2/P3/P4/P5 已验收链不参与 P6 重构。
6. 每次完整验证至少包含对应新 selftest + 受影响历史 selftest + Web build。
7. Actions 安装后的工作区永远不提交；验证 workflow 只读并通过 GitHub API 单独删除。

## P6A — 纯土地分析层

**IMPLEMENTED / VALIDATED**

新增：

```text
core/src/services/farm-land-analyzer.js
core/scripts/farm-land-analyzer-selftest.js
```

从 `farm.js` 迁移：

- `getSlaveLandIds`；
- `hasPlantData`；
- `getLinkedMasterLand`；
- `getDisplayLandContext`；
- `isOccupiedSlaveLand`；
- `buildSlaveToMasterMap`；
- `summarizeLandDetails`；
- `getLandTypeByLevel`；
- `getCurrentPhase`；
- `buildLandMap`；
- `getLandLifecycleState`；
- `classifyHarvestedLandsByMap`。

`farm.js` 继续调用并继续导出原有 public helper；调用方无需迁移。

契约测试覆盖：

- Lv5→purple；
- 2x2 master/slave context；
- 非法 slave linkage 不误判；
- 土地摘要；
- 当前阶段选择；
- empty/dead/growing 生命周期；
- 收获后 removable/growing/unknown 分类。

完整回归已通过：

```text
pnpm farm:land-analyzer-selftest
pnpm land:controls-selftest
pnpm planting:2x2-selftest
pnpm mutation:readonly-selftest
pnpm build:web
node --check core/src/services/farm-land-analyzer.js
node --check core/src/services/farm.js
git diff --check
```

P6A 的目标是纯结构迁移，不改变 Farm RPC、巡田顺序、施肥或种植策略。

## 后续顺序

### P6B — Farm/Shop RPC transport

目标：抽 `farm-api.js`。

只迁移原始 RPC 编码/解码：

- `AllLands`；
- Harvest / Water / Weed / Insecticide；
- RemovePlant；
- Unlock / Upgrade；
- ShopInfo / BuyGoods；
- 其他无策略的 raw request。

注意：operation-limit callback、账号状态、日志语义需要先定义清晰边界，不能为了“纯 API”破坏现有回调。

### P6C — Fertilizer service

目标：抽 `farm-fertilizer.js`。

迁移：

- 普肥/有机肥执行；
- 土地类型范围过滤；
- smart/final/multi-season 目标；
- 化肥策略日志与统计。

不在同一个 PR 改施肥算法。

### P6D — Planting service

目标：把现有种植链统一到 `planting-service.js`：

- shop selection；
- bag priority；
- independent 2x2 prepass/reservation；
- Plant 编码/回包校验；
- fallback strategy。

P2C 已验收设计必须保留：2x2 不依赖 `bag_priority`。

### P6E — Orchestrator + scheduler

在底层职责拆开后，再把：

- `runFarmOperation`；
- `checkFarm`；
- harvest→post-harvest→plant→fertilize→upgrade 编排；
- push trigger；
- farm check loop；
- fertilizer-buy timer；

拆成 orchestrator / scheduler。

### P6F — `farm.js` facade/barrel

最后一步才把 `farm.js` 收成稳定 public facade：

```text
module.exports = {
  ...farmApi,
  ...landAnalyzer,
  ...farmFertilizer,
  ...plantingService,
  ...orchestrator,
  ...scheduler,
}
```

届时调用方仍通过同一个 public surface 使用 Farm 功能，避免全仓库 import churn。

## P6 成功标准

不是“文件数量变多”，而是：

- RPC transport 不知道业务策略；
- analyzer 不发网络请求；
- fertilizer 不负责选种；
- planting 不负责巡田 scheduler；
- orchestrator 只编排，不重新实现底层规则；
- `farm.js` 不再成为所有 Farm 变化的唯一冲突点；
- 已验收行为和外部 API 保持兼容。

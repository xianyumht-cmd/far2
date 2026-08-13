# FAR2 P6 — Farm 架构收口验收记录 — 2026-08-13

状态：**COMPLETED / VALIDATED**

最终 `main` 基线：`cd8cb196b59a2c4c55c6193e706578ea7961406b`

## 1. 目标

P0～P5 的主要安全功能扩展完成后，FAR2 最大的结构债是 `core/src/services/farm.js` 同时承担 Farm RPC、土地分析、施肥、种植、巡田编排、scheduler 和 WebUI 读模型。

P6 的目标不是重写已经验收的业务逻辑，而是按成熟实现的职责边界逐层拆分，同时满足：

- 对外 `require('./farm')` public surface 保持兼容；
- CodeManager、V4 好友采集、Catalog、P2/P3/P4/P5 不参与重构；
- 每一步先有契约 selftest，再迁移；
- 每个 PR 只迁移一个职责；
- 不在结构 PR 中顺带修改种植、施肥、scheduler 策略；
- 所有依赖 `AllLands` operation-limit callback 的生产读链继续经过 `farm.js` facade wrapper；
- Actions 安装后的工作区不提交，临时验证 workflow 验证后单独删除。

## 2. 最终架构

P6 完成后的 Farm 领域结构：

```text
farm.js
  -> stable public facade / dependency assembly
  -> getAllLands operation-limit callback wrapper

farm-api.js
  -> raw Farm / Shop RPC transport

farm-land-analyzer.js
  -> pure land DTO helpers
  -> master/slave / phase / lifecycle analysis

farm-fertilizer.js
  -> normal / organic fertilizer execution
  -> fertilizer scope / smart targets

planting-service.js
  -> Plant wire encoding
  -> 1x1 / 2x2 execution
  -> bag priority / fallback
  -> shop seed selection / purchase / planting

farm-orchestrator.js
  -> one Farm operation / checkFarm business orchestration
  -> post-harvest state resolution

farm-scheduler.js
  -> farm loop
  -> landsChanged push debounce
  -> external scheduler mode
  -> fertilizer-buy timer

farm-query-service.js
  -> getAvailableSeeds read model
  -> getLandsDetail read model
```

`farm.js` 现在只负责：

1. 组装这些模块；
2. 保留 `getAllLands()` operation-limit callback 副作用边界；
3. 继续提供原来的稳定 exports。

不再在 `farm.js` 内实现种植、施肥、巡田、scheduler 或土地 DTO 逻辑。

## 3. P6A — 土地分析层

**COMPLETED / VALIDATED**

PR：#24  
合并基线：`bb6b3a8ad71808c62d2c4c877f7e4c191b19ef31`

新增：

```text
core/src/services/farm-land-analyzer.js
core/scripts/farm-land-analyzer-selftest.js
```

迁移：

- master/slave 关联；
- display context；
- 土地摘要；
- Lv5→purple 分类；
- 当前阶段；
- land map；
- empty/dead/growing 生命周期；
- 收获后 removable/growing/unknown 分类。

没有网络请求，没有 Farm RPC。

## 4. P6B — Farm / Shop RPC transport

**COMPLETED / VALIDATED**

PR：#25  
合并基线：`acb04acbcc3cd2d171d16a0aa32cbae46345b470`

新增：

```text
core/src/services/farm-api.js
core/scripts/farm-api-selftest.js
```

迁移 raw transport：

- AllLands；
- Harvest；
- WaterLand；
- WeedOut；
- Insecticide；
- RemovePlant；
- UpgradeLand；
- UnlockLand；
- ShopInfo；
- BuyGoods。

`farm.js#getAllLands()` 仍包住 `getAllLandsRaw()`，继续触发好友模块设置的 operation-limit callback；transport 本身不知道好友业务。

契约测试使用真实 protobuf 编解码 + fake `sendMsgAsync`，验证 service / method / request body，不连接 QQ。

## 5. P6C — Fertilizer service

**COMPLETED / VALIDATED**

PR：#26  
合并基线：`f29f769b0601d87811325c3bc1c57bd2224cc636`

新增：

```text
core/src/services/farm-fertilizer.js
core/scripts/farm-fertilizer-selftest.js
```

迁移：

- 普通肥；
- 有机肥循环；
- Lv5 purple 范围兼容；
- 土地类型过滤；
- 有机肥目标；
- fast-mature / smart 目标；
- `runFertilizerByConfig`；
- 原有日志与 `recordOperation`。

生产实例显式注入 facade `getAllLands`，没有绕过 operation-limit callback。

本轮没有顺带修施肥算法；smart 分支既有生产语义原样保留。

## 6. P6D — Planting service

**COMPLETED / VALIDATED**

PR：#28  
合并基线：`c3c04bf4bab45648ad54140ff73c5a868296f57c`

新增：

```text
core/src/services/planting-service.js
core/scripts/planting-service-selftest.js
```

迁移：

- Plant wire encoding；
- 单块 Plant loop；
- 2x2 Plant execution；
- 背包种子排序与消费；
- bag fallback；
- 商店选种；
- BuyGoods 后种植。

P2C 已验收边界保持：

- 独立 2x2 prepass 不依赖 `bag_priority`；
- 商店自动购买仍只允许 1x1；
- 2x2 商店自动购买没有被打开；
- 背包 2x2 探测仍通过 facade `getAllLands`。

## 7. P6E1 — Farm orchestrator

**COMPLETED / VALIDATED**

PR：#29  
合并基线：`a6a2858861b04d879b5d0e4476f376ca5fe67a7a`

新增：

```text
core/src/services/farm-orchestrator.js
core/scripts/farm-orchestrator-selftest.js
```

迁移：

- `analyzeLands`；
- `autoPlantEmptyLands`；
- 收获后状态补拉/分类；
- `runFarmOperation`；
- `checkFarm`；
- `isCheckingFarm / isFirstFarmCheck` 内部状态。

执行顺序保持：

```text
clear
 -> harvest
 -> post-harvest classification
 -> plant
 -> multi-season fertilizer
 -> unlock / upgrade
 -> smart fertilizer
```

同时保留 `farmHarvested` event、`recordOperation` 和并发 busy guard。

## 8. P6E2 — Farm scheduler

**COMPLETED / VALIDATED**

PR：#30  
合并基线：`8f09c9c9ba8cc07ffd917c37719a837a3931283c`

新增：

```text
core/src/services/farm-scheduler.js
core/scripts/farm-scheduler-selftest.js
```

迁移：

- farm loop；
- `landsChanged` push；
- external scheduler mode；
- fertilizer-buy timer / check。

原有时序锁定不变：

- 首次巡田：2000ms；
- push debounce：500ms；
- push delayed check：100ms；
- refresh 默认：200ms；
- 正常循环：`CONFIG.farmCheckInterval`。

删除了只有声明、没有读写的 `lastFertilizerBuyCheckAt` 死状态。

## 9. P6F — Query service + final facade

**COMPLETED / VALIDATED**

PR：#31  
最终合并基线：`cd8cb196b59a2c4c55c6193e706578ea7961406b`

新增：

```text
core/src/services/farm-query-service.js
core/scripts/farm-query-selftest.js
```

迁移最后两个只读职责：

- `getAvailableSeeds()`；
- `getLandsDetail()`。

保留：

- 商店种子 required level / locked / soldOut DTO；
- WS400 时安静使用本地种子列表；
- 2x2 master/slave 展示；
- 土地等级/季数/成熟时间；
- mutation 只读展示；
- slave land 不重复显示 mutation；
- summary 语义。

`getLandsDetail` 同样注入 facade `getAllLands`，operation-limit callback 不丢失。

完成后 `farm.js` 成为真正的 facade / composition root。

## 10. 最终完整验证

P6F 合并前执行了完整回归：

```text
pnpm farm:query-selftest
pnpm farm:scheduler-selftest
pnpm farm:orchestrator-selftest
pnpm planting:service-selftest
pnpm planting:2x2-selftest
pnpm farm:fertilizer-selftest
pnpm farm:api-selftest
pnpm farm:land-analyzer-selftest
pnpm land:controls-selftest
pnpm mutation:readonly-selftest
pnpm activity:readonly-selftest
pnpm build:web
node --check core/src/services/farm-query-service.js
node --check core/src/services/farm.js
git diff --check
```

全部通过。

验证 workflow 只给 `contents: read`，完成后通过 GitHub Contents API 单独删除，没有把 `node_modules` 或构建产物提交进分支。

## 11. P6 成功标准结果

当前结果满足：

- RPC transport 不知道业务策略；
- analyzer 不发网络请求；
- fertilizer 不负责选种；
- planting 不负责巡田 scheduler；
- orchestrator 负责业务编排，不持有 loop timer；
- scheduler 不重新实现 Farm 业务；
- query service 只负责读模型；
- `farm.js` 不再是所有 Farm 变化的唯一冲突点；
- 已验收 P2 2x2 / P3 mutation / operation-limit callback / scheduler 时序保持兼容；
- Worker/Admin/Web public 调用不需要迁移。

## 12. 后续原则

P6 到这里结束。

**不要默认继续 P7 式架构重构，也不要为了让文件更小继续拆模块。**

后续只有在下面情况才继续调整架构：

1. 新业务功能确实需要新的职责边界；
2. 真实生产缺陷证明现有边界有问题；
3. 某个模块再次出现明显耦合/冲突成本。

默认下一步重新回到产品价值：审计当前 `main` 与成熟实现之间剩余的**业务能力、真实稳定性问题和可验证协议差异**，按价值、风险和真实证据决定下一项。
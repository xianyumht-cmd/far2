# FAR2 P3A — 变异只读展示 — 2026-08-13

状态：**SOURCE + BUILD COMPLETE / LIVE VISUAL ACCEPTANCE PENDING**

## 目标

P3A 只解决“看见服务器已经存在的变异信息”。

明确不包含：

- 自动刷变异；
- 变异重试/重置；
- 新增变异写 RPC；
- 新增任何变异购买或消耗；
- 恢复历史版本已删除的“自动刷变异”功能。

## 协议来源

FAR2 原有 `plantpb.proto` 已经包含所需字段，不需要新增 RPC：

```text
PlantInfo.mutant_config_ids
PlantPhaseInfo.mutants
MutantInfo.mutant_time
MutantInfo.mutant_config_id
MutantInfo.weather_id
```

数据继续来自现有 `AllLands` 读取链。

## 当前实现

### 1. 静态效果元数据

新增：

```text
core/src/gameConfig/MutantEffect.json
```

当前记录 10 种已知效果：

- 冰冻；
- 爱心；
- 暗化；
- 湿润；
- 黄金；
- 哈哈；
- 塔塔；
- 荷华；
- 月华；
- 绵绵。

首版只使用名称、说明、标签等文本元数据，不复制额外变异图片资源。

### 2. 纯只读解析层

新增：

```text
core/src/services/farm-mutation.js
```

职责：

```text
PlantInfo / current PlantPhaseInfo
  -> 合并 mutant config IDs
  -> 去重
  -> 已知效果映射
  -> unknownConfigIds
  -> 当前阶段 MutantInfo 事件标准化
```

返回结构：

```text
active
configIds
known effects
unknownConfigIds
events(mutantTime/configId/weatherId)
```

未知 ID 不会静默丢弃，前端显示为 `未知变异 #ID`。

### 3. 土地 DTO

`getLandsDetail()` 在已有只读土地详情中增加：

```text
mutation
mutantConfigIds
mutantEffects
mutantEvents
```

2x2 合种副地不重复展示主地的变异信息；只有主地展示。

### 4. WebUI

`web/src/components/LandCard.vue`：

- 有变异时增加轻量粉色提示边框；
- 显示“变异”只读信息块；
- 已知效果显示名称 + 说明；
- 未知 ID 显示 `未知变异 #ID`；
- 没有新增任何变异操作按钮。

## 验证

新增：

```text
pnpm mutation:readonly-selftest
```

自测覆盖：

- 已知 ID 元数据读取；
- 重复 ID 去重；
- 未知 ID 保留；
- 当前阶段 `MutantInfo` 标准化；
- 无变异状态保持 inactive；
- 测试不连接 QQ、不调用 Farm RPC、不执行写操作。

完整 GitHub Actions 验证已经通过：

```text
pnpm install --frozen-lockfile
pnpm mutation:readonly-selftest
pnpm build:web
node --check core/src/config/gameConfig.js
node --check core/src/services/farm-mutation.js
node --check core/src/services/farm.js
git diff --check
```

正式合并提交：

```text
be9c263202b57f65adcee673db73c5f7693faa25
```

## 真实验收

真实验收不需要制造变异，更不能为了验收恢复自动刷变异。

保持正常运行。当账号的 `AllLands` 自然返回一个带变异信息的作物时，“个人 -> 我的农场”对应主土地应显示变异徽标和效果说明。

如果当前所有作物都没有 `mutant_config_ids` / `mutants`，页面不显示变异信息属于正常状态，不算失败。

在自然出现真实变异画面前，P3A 保持：**源码/构建完成，真实视觉验收待自然条件**。

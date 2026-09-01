# FAR2 下一步接续交接 — 2026-09-01 08:11

> 用途：供下一次 GPT / Codex 会话直接接续当前 FAR2 工作。本文汇总本轮至今已经完成、已验证、失败方案及原因、禁止重复路线、当前代码/提交与生产环境、未完成问题和下一步操作。
>
> 事实优先级：本文为当前交接基线；旧 handoff 中与本文冲突的历史状态、推测或未验收结论不得覆盖本文。

## 1. 当前目标与阶段判断

FAR2 已经不处于“继续搭地基”阶段。当前主要目标是：

1. 保持已经稳定运行的 QQ 农场生产链；
2. 修复真实生产暴露出的正确性/安全性问题；
3. 完成微信 Farm WMPF runtime 的稳定 live evidence，并据此验证 QQ Mystery Shop 是否可以在微信侧共享；
4. 只补“协议已验证、实现仍有效、风险可控”的成熟功能，不再进行无收益的架构重写；
5. 将 mock/selftest 验证逐步提升为真实 QQ / 微信运行验证。

当前总体判断：QQ 主链已具备较完整功能并有真实运行证据；大部分已知成熟功能已经存在。剩余高价值工作主要是生产可靠性、微信实机闭环、少量真实生产缺口，而不是继续扩框架。

---

## 2. 唯一生产身份与环境状态

### 2.1 Canonical FAR2 根目录

```text
D:\project2\far2
```

不要重新创建、恢复或把 `far2-test`、`far2-main-sync`、probe、backup 等目录当作生产根目录。生产身份必须以 Windows 服务、进程、计划任务、命令行和监听端口确认。

### 2.2 QQ 生产链

```text
Windows 服务 FAR2Farm
  -> NSSM
  -> D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe
  -> D:\project2\far2\core\client.js
  -> 0.0.0.0:3007
  -> Runtime Engine / QQ Worker

QQ Code Agent
  -> 计划任务 FAR2CodeAgent-2320006072
  -> D:\project2\far2\scripts\windows\run-code-agent-hidden.ps1
  -> 127.0.0.1:43101
```

共享 Node 运行时 `D:\project2\napcatplugin` 是外部公共依赖，不是第二份 FAR2 项目。

### 2.3 微信旁路

```text
计划任务 FAR2 WeChat Resident Agent
  -> D:\project2\far2\agent\scripts\windows\run-wechat-resident-agent-autostart.ps1
  -> agent/core/scripts/wechat-isolated-code-agent.js
  -> WeChatAppEx WMPF 25510
  -> 127.0.0.1:43201  鉴权 Code Provider
  -> 127.0.0.1:9421   Resident CDP/WMPF Bridge
```

目标微信 Farm AppId：

```text
wx5306c5978fdb76e4
```

Windows Session：`1`。

### 2.4 最新 QQ 生产状态

2026-09-01 20883 修复批次中，为使最终源码进入生产，完成两次必要的 `FAR2Farm` 正常重载：

- 中间 Node PID `8848` 曾遇到 `WS 400 / 需要更新 Code`；
- 最终 Node PID `21796` 于 `2026-09-01 08:13:53` 启动；
- `08:13:57` 成功登录 QQ 并完成作物同步；
- 服务保持 `Running`；
- 生产入口仍为 `D:\project2\far2\core\client.js`。

短观察窗口没有新的 `20883`、`unknown_reserved`、`unresolved_seed_guarded` 或重复锁定告警，但这只能证明修复加载后短窗口未复现，不能冒充完整 Bag 自然回归。

### 2.5 微信最新有效状态

最后一轮微信侧已经定位并修复错误 peer 接受问题，但修复后尚未取得新的稳定真实 Farm renderer/context。因此微信 Mystery Shop 仍是：

```text
BLOCKED — no stable runtime
```

不得把端口存在、hook armed、WeChatAppEx 存在、窗口标题、旧 context hint 或短暂 ready 当成微信成功。

---

## 3. 云端仓库与提交状态

仓库：

```text
https://github.com/xianyumht-cmd/far2.git
```

本轮一直使用的远端分支：

```text
feature/qq-seed-batch-evidence-20260814
```

写入本文之前，该远端分支 HEAD 为：

```text
7b01cf392219b24a3d178da6c8fb7c3777464eaa
```

提交说明：

```text
docs: add FAR2 feature completeness matrix
```

其父提交：

```text
1dc9cf9965e59f003c03749913c82a575034b0af
```

用于生产链路文档同步。

重要：最近多轮真实源码修复主要仍保留在本地 `D:\project2\far2` dirty worktree 中，尚未作为一组经过清理的源码 commit 推送。不要把“云端 handoff 文档已提交”误认为“全部本地源码修复已经推送”。

本地分支此前已确认与远端同名分支存在分叉；不得通过 reset/clean/强推/整目录覆盖来“同步”。

---

## 4. 已完成：QQ / 微信 Mystery Shop 共享边界

### 4.1 QQ 已验证协议

QQ Mystery Shop 当前已真实验证：

```text
Service: gamepb.mysteryshoppb.MysteryShopService
Methods: GetActiveNPC, Buy
```

核心链路：

1. `GetActiveNPC` 只读探测；
2. 从动态响应结构提取购买 ID；
3. 校验 active、活动开始/结束时间和 ID 合法性；
4. protobuf varint 生成 `Buy` 请求；
5. 服务端成功后才记统计；
6. 账号级/活动级 guard 防止重试导致重复购买；
7. 明确服务端拒绝与 timeout/断线等不确定结果分开处理。

已观察 wire 例子：`Buy(1004)` 请求体 `08ec07`。该 ID 只是协议证据，禁止永久硬编码。

### 4.2 已完成共享化

近期本地源码已经把 Mystery Shop 从 QQ-only 调整为：

- QQ 默认允许；
- 微信仅在显式环境变量开启时允许；
- 未知平台拒绝；
- 共享业务层继续负责动态 ID、时间窗口、guard、统计、日志；
- 微信仅保留 platform/session/WMPF/Resident 生命周期等平台差异。

微信开关：

```text
FARM_MYSTERY_SHOP_WECHAT_ENABLED=1
```

未设置时微信安全跳过，不发送 Mystery Shop probe/Buy；QQ 默认行为不变。

### 4.3 尚未完成的 live 结论

微信端还没有在修复后的稳定 Farm runtime 中执行唯一一次 `GetActiveNPC` read-only，因此目前只能确认“代码层可共享”，不能宣称：

```text
LIVE VERIFIED — shared implementation valid
```

也不能宣称 incompatible。

在 live read 前禁止微信 `Buy`。

---

## 5. 已完成：微信 Resident Agent 根因与修复

### 5.1 已失败/已排除的旧路线

旧实现曾出现：

```text
available=true
residentState=resident_connected
connected=true
exactAppContextSelected=true
contextCount=0
```

原因包括两类已修复问题：

1. 历史 context hint 被误当成当前连接的 live context；
2. `9421` shared debug redirect 接受了 WeChat network utility，而不是目标 Farm renderer。

因此以下路线不要再重复：

- 不得用历史 context ID 作为 live truth；
- 不得在 `contextCount=0` 时返回 ready；
- 不得为了“能连上”而放宽到任意 WMPF context；
- 不得接受 `WeChatAppEx.exe --type=utility --utility-sub-type=network.mojom.NetworkService` 作为 miniapp bridge；
- 不得把正确 AppId 的 renderer 进程存在等同于它已经连接 9421；
- 不得反复重启整个 FAR2Farm 来碰运气。

### 5.2 已定位真实 peer 根因

旧运行证据中：

- 目标 renderer：`WeChatAppEx.exe --type=renderer --wmpf-appid=wx5306c5978fdb76e4` 仍存活；
- 当前 9421 TCP client 却属于 network utility；
- 旧 bridge 把 utility 提升为 current miniapp，清空 context 并持续得到空 inventory。

因此已确认的核心根因是：

```text
wrong peer / redirect acceptance
```

而不是目标 renderer 已退出，也不是 AppId 应该放宽。

### 5.3 已实施 Resident 修复

近期本地源码包括：

- `agent/core/src/services/wechat-wmpf-resident-capture.js`
  - 从 Windows TCP client tuple 查询实际连接所属进程；
  - 只接受 `WeChatAppEx.exe` + `--type=renderer` + 精确目标 `--wmpf-appid`；
  - utility、非 renderer、其他 renderer 全部拒绝并关闭；
  - 没有实时 context 时 fail-closed；
  - selected ID 必须仍属于当前连接 inventory；
  - stale socket 晚到消息不能修改当前 context map；
  - `captureFreshCode` 不接受不属于当前连接的 selected ID。
- `agent/core/scripts/wechat-resident-agent.js`
  - 增加脱敏 peer/error/disconnect 诊断。
- `agent/core/scripts/wechat-isolated-code-agent.js`
  - bootstrap retry 不再把“connected 但无当前 context”当 ready。
- `agent/core/src/services/wechat-code-agent.js`
  - health 保留 `selectedContextId`。
- `agent/core/scripts/wechat-resident-context-selftest.js`
  - 覆盖精确 peer、utility/无关 renderer 拒绝、旧 hint、context gap、延迟替换、disconnect 等场景。

已通过对应 context selftest 和 Node syntax check。

### 5.4 当前微信阻塞

修复后 Agent 已 armed，但仍需要一次“新的真实 Farm renderer -> 9421 -> 当前 context inventory”的连接证据。

只有同时满足以下条件才算 ready：

```text
available=true
residentState=resident_connected
connected=true
exactAppContextSelected=true
contextCount>0
selectedContextId 属于当前实时 inventory
当前 context AppId 精确匹配
wx.login API 存在
版本元数据有效
```

满足后仅执行一次 `GetActiveNPC` read-only；不执行 `Buy`。

---

## 6. 已完成：生产正确性缺口修复

以下问题均来自“功能看似存在，但真实代码路径存在正确性/安全性缺口”的审计。

### 6.1 Mall / 化肥购买

发现：

- `core/src/services/mall.js` 读取不存在的 `userState.ticket`；
- FAR2 网络层实际维护的是 `userState.coupon`（背包物品 1002）；
- 价格/余额保护失效时旧逻辑可能继续最多 100 轮；
- 有机化肥成功日志引用未定义 `type`，可能把已经成功的结果吞成外层 0。

已修复：

- 统一使用 `coupon`；
- 无法解析价格时不发 Purchase；
- 余额不足时不发 Purchase；
- 数量受实时单价、余额、目标数量和每轮上限共同约束；
- 有机化肥日志固定 `type=organic`。

新增：`core/scripts/mall-purchase-safety-selftest.js`。

### 6.2 邮箱自动领取

发现自动路径可能先批量、后逐封，导致重复 claim。

已修复 `core/src/services/email.js`：每封 claimable email 自动路径只调用一次 `ClaimEmail`；显式 `batchClaimEmail` 保留但不接入自动路径。

新增 `core/scripts/email-claim-safety-selftest.js`。

### 6.3 好友 mutation 不确定结果重放

已修复 `core/src/services/friend.js`：

- 只有明确服务端 `code=N` 拒绝才允许逐项 fallback；
- timeout、断链、发送失败、解码失败等不确定结果不再盲目 replay；
- 两个直接偷菜批量 fallback 统一走安全 helper。

新增 `core/scripts/friend-retry-safety-selftest.js`。

### 6.4 smart 有机施肥土地范围

已修复 `core/src/services/farm-fertilizer.js`：smart organic target 真正应用 `fertilizer_land_types`。

对应 fertilizer selftest 增加覆盖。

### 6.5 自动商店种植价格边界

已修复 `core/src/services/planting-service.js`：

- 自动商店种子选择拒绝 0 / 非有限价格；
- 购买边界再次 fail-closed。

对应 Planting Service selftest 增加零价格场景。

### 6.6 微信 gateway Windows 打包启动回归

第一次生产激活曾暴露：

```text
wechat-gateway-profile.js 使用未定义 wsPath
```

已完成最小修复，显式解析 `ws` 模块路径，并通过 gateway selftest、Worker bootstrap smoke、语法检查和 Windows core build；第二次生产重载后未再出现该启动失败。

不要恢复旧的动态/未定义 `wsPath` 路线。

---

## 7. 最新真实生产问题：20883 未知背包物品 / 活动种子误判

### 7.1 真实日志症状

2026-08-31 生产日志反复出现：

```text
疑似种子#20883(20883)x19
unknown_reserved 4 块地
```

并反复输出当前等级未解锁特殊种子：

```text
银杏树苗#20025
蝴蝶兰#20109
风信子#20112
```

好友偷菜日志还出现：

```text
偷18(植物1020883)
```

最初存在 `20883 -> 1020883` 映射猜测，但当前证据不足，已经明确禁止硬编码。

### 7.2 已确认事实

`20883` 当前不在：

- `core/src/gameConfig/Plant.json`
- `ItemInfo.json`
- 账号 2/3 crop registry
- QQ `miniapp_src` 的结构化证据

现有持久化 entry 只有 `seed-id-namespace`，没有直接：

- `seed_id`
- 类型
- 名称
- 尺寸
- 对应 plant 记录

QQ 缓存也不存在 `1020883`；好友分析链仅把服务端土地 `plant.id` 展示为文本，没有通过数值偏移建立 seed 映射。

因此：

```text
20883 -> 1020883
```

目前不是可接受协议结论。

### 7.3 根因

最终分类：

```text
ROOT CAUSE FOUND / FIXED
```

真实根因：

1. 20xxx namespace fallback 把普通任务/邮件奖励也误判成 unresolved seed；
2. wrapper 对所有 unresolved 项都做“可能 2x2”的 4 地预约；
3. 日志/学习告警去重主要只在进程内生效，重载后重复。

### 7.4 已实施修复

#### `core/src/services/event-seed-priority.js`

- namespace-only 仍保留 read-only discovery；
- 但 `actionable=false`，不再阻断普通商店策略；
- 只有强种子元数据才进入 actionable unknown：
  - `type=5`
  - plant interaction
  - 明确种子名称
- 增加 discovery signature；
- 增加逐项 `lastChangedAt`；
- 日志 signature/时间持久化，支持跨服务实例/重载去重；
- unknown reservation 只允许强证据且证据最近 10 分钟发生变化。

#### `core/src/services/event-seed-shop-guard.js`

- stale / invalid / non-actionable unknown 释放普通种植；
- 已知种子写入/探测失败仍 fail-closed。

#### `core/src/services/event-seed-shop-wrapper.js`

- 只有 prepass 明确给出 fresh reservation 才预留可能的 2x2 footprint；
- reservation 日志沿用持久化节流。

### 7.5 回归覆盖

更新/新增：

- `event-seed-priority-selftest.js`
- `event-seed-shop-guard-selftest.js`
- `event-seed-shop-wrapper-selftest.js`
- `event-seed-empty-farm-regression-selftest.js`

覆盖：

- 同一个 unknown 重复观察；
- evidence deduplication；
- 持久化 reload；
- reservation 创建；
- reservation 过期/释放；
- locked-seed 日志去重；
- 已知 1x1 / 2x2 场景。

### 7.6 验证

通过：

```text
pnpm -C core event-seed:selftest
pnpm -C core farm:orchestrator-selftest
pnpm -C core farm:scheduler-selftest
pnpm -C core planting:service-selftest
```

目标文件 ESLint 通过；`node --check` 和 `git diff --check` 通过。

上述测试没有连接 QQ，没有发送 Shop/Plant RPC，没有未知物品消费或试种。

生产最终进程加载修复后短窗口目标事件计数为 0；还需要下一次自然 Bag/farm loop 做完整 live 验收。

### 7.7 该问题不要重复的路线

- 不硬编码 `20883 -> 1020883`；
- 不为了确认 20883 而购买、消费或试种未知物品；
- 不因为 namespace 是 20xxx 就直接当活动种子；
- 不让长期 unresolved/stale 项永久预留 4 块地；
- 不用“把日志关掉”代替修正确认/持久化/过期逻辑；
- 不为这个问题再次重启 FAR2Farm；
- 只有出现直接 `seed_id` / plant / size / config 证据，才进入 registry/learner 精确映射。

---

## 8. QQ 真实运行验证状态

已经具有真实 QQ 运行证据的能力包括：

- Farm 主循环；
- 收获；
- 种植（历史真实证据）；
- 浇水；
- 好友帮助：除草/除虫/浇水；
- 偷菜巡查与真实成功偷菜；
- 启动时照料；
- QQ Worker 在生产服务重载后恢复运行；
- QQ Code Agent endpoint / exact-UIN 保护存在真实运行证据。

最近一轮生产观察中没有自然触发以下路径，因此只能继续标记：

```text
CODE/SELFTEST VERIFIED
```

而不是新的 live 验证：

- 邮箱自动领取幂等；
- smart organic fertilizer land filter；
- 自动种植零价格保护；
- Mall coupon/price/balance 保护；
- 部分 event-seed 新逻辑完整 Bag 回归。

不得把“代码已经被生产 Node 加载”误写成“该具体业务分支已经真实触发验收”。

---

## 9. QQ Code Agent 当前诊断与禁止路线

此前累计 `core/data/code-agent-43101.log` 统计：

```text
refresh start=151
refresh ok=91
refresh failed=59
capture_timeout=50
agent_capture_identity_unverified=15
```

当前链路：

```text
临时 patch 缓存 game.js
  -> 打开 QQ miniapp URI
  -> 等待 _code.txt / clipboard
  -> process-tree exact-UIN 身份确认
```

自动触发来自 `ws_400` / kickout；已有 Agent 内 refresh 去重和 CodeManager 账号级 in-flight 去重。

最强现有证据：Farm renderer 已运行时，打开 URI 可能只是复用/聚焦现有 renderer，临时 patch 没有被重新加载，从而 `capture_timeout`；identity_unverified 则是捕获后限定时间内 process tree 没看到目标 Farm root。

当前不要重复以下路线：

- 不削弱 exact-UIN identity verification；
- 不因为一次 timeout / ws_400 就重启整套生产链；
- 不关闭不相关 QQ 会话；
- 不主动高频触发 refresh 只为了统计；
- 在没有证明“安全关闭当前 Farm renderer、保留 QQ 主进程并重新加载 patch”的方案前，不贸然改自动刷新生命周期。

下一步只观察自然 `ws_400` / refresh；如果要修，必须先证明操作不会影响其他 QQ 会话和账号绑定。

---

## 10. 已恢复的参考项目与功能完整度结论

已恢复/核对的参考来源：

1. 本机参考源码 `D:\project2\farm`（无 Git 元数据，但可逐文件核对）；
2. README 记录：`https://github.com/XyhTender/qq-farm-automation-bot`；
3. 文档记录 QQ Classic Farm Gitee 更新日志：`https://gitee.com/xlzcandy/qq-classic-farm-update-log`。

逐项审计后，与当前协议/架构相符的成熟路径大部分已经存在 FAR2，包括：

- 主循环；
- 收获；
- 种植/作物选择；
- 1x1 / 2x2；
- 浇水；
- 施肥；
- 除草/除虫；
- 好友帮助/偷菜/巡查；
- 土地；
- 背包/仓库；
- 普通商店；
- 邮箱；
- 任务/活跃度；
- 每日礼包；
- 月卡；
- 会员；
- 分享；
- 邀请；
- 活动只读；
- 宠物/生涯只读；
- 调度；
- 限流；
- 状态持久化与恢复。

因此不要继续做“泛泛的功能列表审计”或为了功能数量而移植未知模块。

当前继续保持 `PROTOCOL UNKNOWN` / `UNSAFE` 的领域：

- Orders；
- Rankings；
- Energy/Stamina；
- Exchange 写操作；
- 未知活动写操作。

没有当前协议证据就不实装。

---

## 11. 已执行验证清单

近期批次已经通过的重点检查包括：

### Mystery Shop / Farm 基础

- `mystery-shop:selftest`
- Farm/Shop protobuf contract selftest
- Farm scheduler/orchestrator selftest
- Planting Service selftest
- Event Seed selftests
- Startup Account Scope / Crop Registry selftests

### 生产安全修复

- `mall:purchase-safety-selftest`
- `email:claim-safety-selftest`
- `friend:retry-safety-selftest`
- `farm:fertilizer-selftest`
- `planting:service-selftest`

### WeChat runtime

- `wechat:resident-context-selftest`
- WeChat gateway profile selftest
- relevant Node syntax checks

### 构建

- `pnpm build:web`（历史批次通过；存在既有 Carbon 图标警告，不影响成功）
- `pnpm -C core build:win`
- Worker bootstrap smoke（针对 wsPath 修复批次）

### 20883 批次

- `pnpm -C core event-seed:selftest`
- `pnpm -C core farm:orchestrator-selftest`
- `pnpm -C core farm:scheduler-selftest`
- `pnpm -C core planting:service-selftest`
- target ESLint
- `node --check`
- `git diff --check`

必须继续区分：

- STATIC VERIFIED
- SELFTEST VERIFIED
- BUILD VERIFIED
- REAL QQ VERIFIED
- REAL WECHAT VERIFIED
- BLOCKED

不得拿 mock/selftest 冒充 live evidence。

---

## 12. 失败方案及原因汇总

### 12.1 微信：用端口/进程/窗口判断 ready

失败原因：端口、WMPF、窗口存在并不代表 exact Farm runtime/context 存在。

禁止重复。

### 12.2 微信：接受历史 context hint

失败原因：旧 context 已不属于当前 bridge，曾制造 `contextCount=0` 但 ready 的假健康。

已修复，禁止回退。

### 12.3 微信：接受 network utility 作为 bridge

失败原因：9421 被 utility 接管后 inventory 为空，目标 renderer 虽存活却未成为当前 bridge。

已修复为 exact renderer + exact AppId 过滤，禁止放宽。

### 12.4 微信：不断重启整个生产链碰 context

失败原因：不能解决 peer / renderer debug attachment 根因，反而影响健康 QQ 主链。

禁止重复；最多只对有明确必要的 WeChat side component 做受控 reload。

### 12.5 QQ Code：削弱 UIN 身份校验换成功率

失败原因：错误账号 Code 比 refresh 失败更危险。

禁止。

### 12.6 20883：通过数值猜 `20883 -> 1020883`

失败原因：当前 Plant/Item/registry/cache 均无直接证据，好友日志只是服务端 plant.id 展示。

禁止硬编码。

### 12.7 20883：试种/消费来识别

失败原因：未知写操作可能浪费资源并污染真实状态。

禁止。

### 12.8 Git：reset/clean/强推/整目录覆盖

失败风险：本地工作树包含用户既有改动、源码修改、运行数据、依赖、Agent 文件和历史交接；分支也已经分叉。

严格禁止。

---

## 13. 当前本地代码改动边界

近期 Codex 批次涉及的主要源码/自测候选包括（不是“云端已同步清单”）：

### Mystery Shop / gateway

- `core/src/services/mystery-shop.js`
- `core/scripts/mystery-shop-selftest.js`
- `core/src/core/worker.js`
- `core/src/services/wechat-gateway-profile.js`
- root/core `package.json` 相关 script entries

### Mall / Farm correctness

- `core/src/services/mall.js`
- `core/scripts/mall-purchase-safety-selftest.js`
- `core/src/services/email.js`
- `core/scripts/email-claim-safety-selftest.js`
- `core/src/services/friend.js`
- `core/scripts/friend-retry-safety-selftest.js`
- `core/src/services/farm-fertilizer.js`
- `core/scripts/farm-fertilizer-selftest.js`
- `core/src/services/planting-service.js`
- `core/scripts/planting-service-selftest.js`

### WeChat Resident

- `agent/core/src/services/wechat-wmpf-resident-capture.js`
- `agent/core/scripts/wechat-resident-agent.js`
- `agent/core/scripts/wechat-isolated-code-agent.js`
- `agent/core/src/services/wechat-code-agent.js`
- `agent/core/scripts/wechat-resident-context-selftest.js`

### Event Seed 20883

- `core/src/services/event-seed-priority.js`
- `core/src/services/event-seed-shop-guard.js`
- `core/src/services/event-seed-shop-wrapper.js`
- relevant Event Seed regression selftests

这些文件必须和“用户原本已有的 dirty changes”逐文件区分，不能假设整个 diff 都属于本轮。

明确排除任何未来提交：

- `agent/state`
- `core/data`
- runtime logs
- account state
- tokens/passwords/cookies/login codes
- `node_modules`
- `dist`
- generated runtime artifacts

---

## 14. 当前未完成问题

### P0 — 20883 自然生产回归

等待正常 QQ Farm / Bag 自然循环，验证：

- 20883 可以继续被 read-only 观察；
- 不再升级为 `unknown_reserved`；
- namespace-only 不再阻断普通商店补种；
- locked special seed 同样事件不再每轮刷屏；
- reservation 在证据 stale/invalid/non-actionable 后释放；
- 如果出现新的直接 seed/plant/size metadata，才进入精确 registry learner。

不为该项再次重启 FAR2Farm，不试种未知物品。

### P1 — 微信 Farm renderer 新连接

当前真正要验证的是：在 exact peer filter 修复后，目标 Farm renderer 是否真实连接 `127.0.0.1:9421`。

若 renderer 不连，下一层问题不是 context selector，而是 renderer debug redirect / bootstrap / inheritance / client lifecycle。

### P2 — 微信 `GetActiveNPC` 唯一一次 live read

只有 readiness 全满足后调用一次：

```text
gamepb.mysteryshoppb.MysteryShopService.GetActiveNPC
```

比较 QQ/WX：service、method、request/response wire、dynamic ID、active/time window、错误语义、gateway/session 差异。

然后分类：

- `LIVE VERIFIED — shared implementation valid`
- `LIVE VERIFIED — small WeChat adapter required`
- `INCOMPATIBLE — separate implementation required`
- `BLOCKED — no stable runtime`

本阶段仍禁止 `Buy`。

### P3 — QQ Code Agent 自然 refresh 继续观察

仅观察新的自然 `ws_400` / auto refresh 证据；不要高频主动刷新。

如继续出现大量 `capture_timeout`，下一步必须先证明“只安全重建当前 Farm renderer 而不影响 QQ 主进程/其他会话”的方案，才能改 lifecycle。

### P4 — 将近期本地源码改动安全提交/同步

在功能和生产验证足够后，单独做一次 source inventory/reconciliation：

1. 区分 recent Codex source fixes vs pre-existing user dirty changes；
2. 排除 state/logs/data/deps/dist/secrets；
3. 逐文件 review；
4. 选择安全源码、自测、文档提交；
5. 由于本地/远端分叉，禁止强推，需采用安全的 branch/reconciliation 流程。

---

## 15. 下一会话建议执行顺序

1. 先读本文以及 `PROJECT_STATE.md`、`docs/PRODUCTION_RUNTIME_CHAIN_2026-08-31.md`、`docs/FEATURE_COMPLETENESS_MATRIX_2026-08-31.md`。
2. 先读取当前 FAR2Farm、QQ Code Agent、WeChat Resident health 和最新脱敏日志，不先重启。
3. QQ：等待自然 farm/Bag loop 验收 20883 修复；只根据新运行证据升级状态。
4. 微信：Agent armed 后让真实微信农场重新打开/刷新，确认 exact Farm renderer 是否连接 9421。
5. 若微信 readiness 全满足，执行唯一一次 `GetActiveNPC` read-only；不要 `Buy`。
6. QQ Code：只读下一次自然 refresh；不要削弱 exact-UIN，不要因单次 timeout 重启生产链。
7. 如果 20883、微信或 QQ Code 出现新的具体软件缺陷，做最小修复 + focused selftest；不要再做泛架构重写。
8. 等主要 live evidence 完成后，再规划本地 dirty source 的安全提交/云端同步。

---

## 16. 硬性禁止事项

- 不使用 `git reset --hard`；
- 不使用 `git clean`；
- 不 force push；
- 不整目录覆盖；
- 不批量删除 dirty/untracked；
- 不手工修改/清空账号运行 state 来制造成功；
- 不输出 Token、密码、Cookie、raw `wx.login` Code 或完整账号凭据；
- 不把端口存在等同于微信 ready；
- 不接受 stale context 或 utility peer；
- 不开启微信自动 Mystery Shop 购买，直到 live read 完成并获得后续明确授权；
- 不为识别 20883 做未知物品购买/试种；
- 不硬编码 `20883 -> 1020883`；
- 不削弱 QQ exact-UIN 身份保护；
- 不继续实现无当前协议证据的 Orders / Rankings / Energy/Stamina / Exchange writes / unknown event writes；
- 不把旧测试结果或 mock 结果写成新的真实运行证据。

---

## 17. 下一位 GPT / Codex 的成功标准

下一阶段优先完成的不是“更多代码量”，而是以下真实闭环：

1. 20883 修复获得自然 QQ Bag/farm loop 运行验证；
2. 微信 exact Farm renderer 在修复后的 peer filter 下建立稳定 current context；
3. 微信唯一一次 `GetActiveNPC` read-only 完成，得出明确 QQ/WX 共享分类；
4. QQ Code Agent 新的自然 refresh 证据被正确分类，必要时才修 lifecycle；
5. 所有修改继续保持 fail-closed、幂等、账号隔离和不确定结果不盲重放；
6. 最后再安全整理/提交近期源代码，而不是用破坏性 Git 操作覆盖现有工作树。

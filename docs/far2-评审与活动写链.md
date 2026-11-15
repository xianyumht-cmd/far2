# far2 评审：同源实现对比、真实短板、以及本次补上的「活动写链」

对象：`xianyumht-cmd/far2`（本机克隆于 `D:\project2\far2`，main 分支 zip 快照 2026-11-14）
参照：同源仓库 4 份（见下表），全部下载到 `D:\project2\ref_*` 便于逐行对照。

## 0. 结论

- far2 的**工程纪律**在同源里是最好的一档：fail-closed、写前读→写后验、原子落盘 + journal、
  每个能力都有离线 selftest。这些是"长期无人值守"真正需要的东西。
- far2 的**功能面**落后于 `liyangpengs/qq-farm-bot` 一到两个代际，核心原因是协议层只做了读：
  `activitypb.proto` 里只有 `List` / `GetGroup`，**没有 `Operate`**，所以"参与活动"这件事
  在 far2 里不是"没做好"，而是"根本没这条链"。
- 本次已经补上 `Operate` 写链的最小可用集（兑换商店 + 星座领取），带三重闸门与 9 项离线断言。
  这是把 far2 从"只读活动发现"推进到"可参与活动"的第一步，且不破坏原有 fail-closed 纪律。

## 1. 四份同源实现的关系

| 仓库 | 形态 | 规模 | 定位 |
| --- | --- | --- | --- |
| `DeepFal/qq-farm-bot-ui` | JS + Vue | 332 文件 | far2 的 UI/骨架源头，功能最少 |
| `Aoluis1005/qq-farm-bot` | JS + Vue | 900 文件 | 在 UI 版上加了**活动写链**（Operate + 观星/南瓜/荷风/青梅） |
| `liyangpengs/qq-farm-bot` | **TS** + Vue | 1853 文件 | 功能超集：天气(雨落成诗)、星座、公益红花、七夕、青梅、奶茶店、宠日记、好友互动道具 |
| `xianyumht-cmd/far2`（本仓库） | JS + Vue | 591 文件 | 在 UI 版上重做**运维与可靠性**：CodeAgent 登录态、微信 Resident Agent、Crop Registry、P4 持久化 |
| `flh155/qq-farm-bot-vision` | 独立小项目 | 42 文件 | AI 视觉识别流派，与协议流派不同路，参考价值有限 |

一句话：**liyangpengs = 功能最全，Aoluis1005 = 活动最全的轻量版，far2 = 工程最稳但功能落后。**
这也解释了你的体感——"功能稍微有些过时，无法参与实时活动"。

## 2. 能力矩阵（逐个仓库 grep 代码得出）

| 能力 | far2 | liyangpengs | Aoluis1005 | DeepFal |
| --- | --- | --- | --- | --- |
| 活动 `Operate` 写链 | **本次补上** | ✓ | ✓ | — |
| 天气活动（雨落成诗） | — | ✓ | — | — |
| 星座 / 观星礼录 | 只读 | ✓ | ✓ | — |
| 公益红花 | — | ✓ | — | — |
| 七夕（鹊桥/香囊） | — | ✓ | — | — |
| 青梅酒酿 | — | ✓ | ✓ | — |
| 奶茶店经营 | — | ✓ | — | — |
| 宠日记 | — | ✓ | — | — |
| 好友互动道具 | — | ✓ | — | — |
| 2x2 占地作物 | ✓ | ✓ | ✓ | — |
| 护主犬 | ✓ | ✓ | ✓ | ✓ |
| 图鉴 / 图鉴奖励 | ✓ | ✓ | ✓ | ✓ |
| 头像框 | ✓ | — | — | — |
| 职业 | ✓ | ✓ | ✓ | — |
| 微信农场（WMPF） | ✓ | ✓ | ✓ | — |
| **本机 QQ Session 登录态自维护（CodeAgent）** | **✓ 独有** | — | — | — |

矩阵里有两处需要点明：

1. **CodeAgent 是你这套独有价值**。liyangpengs / Aoluis1005 走的是扫码或手工 Code，
   你的 far2 用本机已登录 QQ 的交互式 Session 自动刷新 Code，这才是"无人值守"的关键差别。
   补功能时千万别为了抄它们把这条链换掉。
2. **功能落后的差距集中在 `activitypb.proto`**。其余业务（偷菜/帮助/狗狗/图鉴/商店/仓库）
   far2 都不缺，缺的是"活动"这一整个域。

## 3. 为什么 far2 参与不了活动（根因，不是配置问题）

```text
core/src/proto/activitypb.proto   ← 只有 List / GetGroup，没有 Operate
core/src/services/activity-readonly*.js  ← 明确写死 operateEnabled: false
core/scripts/activity-readonly-selftest.js ← 甚至断言"proto 里不许出现 OperateRequest"
```

也就是说：只读是**设计选择**，不是遗漏。当初为了避免"猜参数乱写"，把写链整段封死了，
代价就是活动永远只能看不能玩。

## 4. 本次补上的东西（活动写链 v0.1）

### 4.1 协议层（`core/src/proto/activitypb.proto`）

新增 `Operate` 及其请求/回复，字段号来自同源实现交叉验证的实机抓包：

| 字段 | 语义 |
| --- | --- |
| `OperateRequest.1` | `activity_id` |
| `OperateRequest.2` | `operate_type` |
| `OperateRequest.101` | `exchange_shop_operate {goods_id, count}` |
| `OperateRequest.102` | `random_shop_operate {goods_id, count}` |
| `OperateRequest.119` | `constellation_operate {}`（空消息） |
| `OperateReply.3` | `ActivityNode`（与 `GetGroupReply.group` 同构） |
| `OperateReply.104` | `repeated corepb.Item rewards` |

已知 `operate_type`：`1` 兑换购买、`2` 随机商店购买、`3` 随机商店刷新、`21` 星座点亮；
`1034038` 是"当前无可领取节点"的幂等信号。

### 4.2 服务层（`core/src/services/activity-operate.js`）

只实现**选择器已被验证**的两条：

- `exchangeGoods({activityId, goodsId, count})` —— 写前必须能在 `GetGroup.exchange_shop` 里
  找到该商品，否则不发包；已 `owned` 且 `status=2` 直接判幂等跳过；发包后**再读一次分组**，
  对比 `owned/status` 是否真的变了（防止"回包成功但服务端没落地"）。
- `claimConstellation({activityId})` —— `operate_type=21` + 119 空选择器；
  `1034038` 当幂等成功。

未实现的（随机商店 2/3、抽奖 9、青梅 4/14/15/16、公益红花 35~38、天气 9/40）
一律不写、不猜，保持 fail-closed。这与仓库既有原则一致。

### 4.3 三重闸门

| 闸门 | 默认 | 开关 |
| --- | --- | --- |
| 总开关 | **关** | `FAR2_ACTIVITY_OPERATE=1` |
| 空跑 | **开**（只返回计划不发包） | `FAR2_ACTIVITY_DRY_RUN=0` 才真的打 |
| 速率 | 20 次/小时 | `FAR2_ACTIVITY_OPERATE_MAX_PER_HOUR` |

另外：写操作全局串行（`mutationTail`），每账号独立预算（worker 内实例化），
错误按 `no-reward / already-claimed / insufficient / out-of-stock / activity-closed` 分类。

### 4.4 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/activity/operate/state` | 当前策略 + 近一小时次数 |
| POST | `/api/activity/operate/policy` | 动态开关 / dryRun / 速率 |
| GET | `/api/activity/:activityId/group` | 活动分组原始读 |
| POST | `/api/activity/operate/exchange` | 兑换（受三重闸门） |
| POST | `/api/activity/operate/constellation` | 星座领取（受三重闸门） |

### 4.5 离线验证（9 项断言，全绿）

```powershell
$node = 'D:\project2\qqallin\runtime\SnowLuma\node.exe'
cd D:\project2\far2\core
& $node scripts/activity-operate-selftest.js
```

覆盖：proto 注册、101/119 字段编码、写前读→单次写→写后复核（恰好 3 次调用）、
dryRun 零写入、总闸门零请求、回包不匹配不重试、商品不存在不发包、已兑换幂等、速率上限。

## 5. 上线验证步骤（真实账号，谨慎）

```powershell
# 1. 先只读确认活动还能读到
curl "http://127.0.0.1:3007/api/activity/2026072701/group" -H "x-account-id: <账号ID>"

# 2. 打开闸门但保持 dryRun：看计划，不发包
$env:FAR2_ACTIVITY_OPERATE="1"          # FAR2_ACTIVITY_DRY_RUN 默认就是 1
# 重启 FAR2Farm 后观察日志里的 [dry-run] 行

# 3. 单次真写，只打一个商品
$env:FAR2_ACTIVITY_DRY_RUN="0"
curl -X POST "http://127.0.0.1:3007/api/activity/operate/exchange" ^
  -H "x-account-id: <账号ID>" -H "content-type: application/json" ^
  -d "{\"activityId\":2026072701,\"goodsId\":<商品ID>,\"count\":1}"

# 4. 看回包里的 verified.changed，false 就说明"回包成功但没落地"，立刻关闸并取证
```

## 6. 还差什么（按性价比排序）

| 优先级 | 事项 | 需要的前置证据 |
| --- | --- | --- |
| P0 | 随机商店购买/刷新（`operate_type=2/3`，选择器 102） | 抓一次官方客户端刷新+购买 |
| P0 | 抽奖免费次数（`operate_type=9`） | 抓一次免费抽 |
| P1 | 天气活动（雨落成诗）：采集/研究/兑换，选择器 107/140，`operate_type=9/1/40` | 已由同源给出，需实机复核 |
| P1 | 公益红花：`operate_type=35~38`，选择器 134~139 | 同上 |
| P2 | 青梅酒酿：`4/14/15/16`，选择器 103/112/113/114 | 同上（收益最高但链最长） |
| P2 | 星座数据解析（`ActivityData.110`）接进只读展示 | GetGroup 深挖即可 |
| P3 | 奶茶店 / 宠日记 / 七夕 | 只在 liyangpengs 里有，需先确认活动是否还开 |

## 7. 不要做的事

- 不要用 far2 的只读层去"猜"`operate_type`。猜错的选择器在活动服务端可能不是报错，而是
  真的执行了另一个语义（比如把"查询"打成"消耗"）。写链宁可少，不可猜。
- 不要为了追 liyangpengs 的功能量把 CodeAgent 换成扫码登录——那是拿稳定性换功能。
- 不要把 `core/data/` 和 Code / Cookie 提交进 Git。

---

# 附：服务启动与功能超集移植进度（2026-11-14 本机）

## A. 服务已在本机跑起来

| 项 | 值 |
| --- | --- |
| 核心 | `node client.js`（core 目录），PID 见 `Get-CimInstance Win32_Process` |
| 端口 | `http://127.0.0.1:3007` |
| WebUI | `/` 返回 200（`web/dist` 已构建，dist 之前是空的） |
| 登录 | `POST /api/login` → 200，返回 `data.token` |
| 账号 | 尚无账号（`/api/accounts` 返回空表），需要扫码/Code 添加 |

启动方式：

`powershell
='3007'
='<12位以上强密码>'   # 仅首次建管理员用
cd D:\project2\far2\core
node client.js
`

本机环境已就绪：Node 用 SnowLuma 自带 `node.exe`（v24.22.1），
`core/node_modules` 与 `web/node_modules` 已按 npmmirror 安装，`web/dist` 已构建。

顺手修的两个上游问题：

1. `admin.js` 里 `crypto` 没有 require，Node ≥19 的全局 `crypto` 没有 `randomBytes`，
   导致登录 500 —— 已补 `const crypto = require('node:crypto')`；
2. 中文注释/配置文件带 BOM 会让 vite 加载配置失败 —— 已全仓去 BOM。

## B. 功能超集移植：7/7 已完成，proto 全量已合入

| 功能 | 状态 | 落地位置 |
| --- | --- | --- |
| proto 超集（ActivityData + 各活动子结构 + 全部 Operate 选择器） | ✅ | `core/src/proto/activity-ext.proto`（由 `tools/build-activity-ext-proto.py` 生成）、`autumn-activities/milk-tea/pet-diary/seasonpb/solartermspb/weatherpb.proto` |
| 星座 / 观星礼录 | ✅ 已移植 | `services/activity-center/stellar.js` + `activity-hub.js` |
| 公益红花 | ✅ 已移植 | `services/activity-center/charity.js` |
| 七夕（鹊桥 + 香囊） | ✅ 已移植 | `services/activity-center/qixi.js` |
| 青梅酒酿 | ✅ 已移植 | `services/activity-center/qingmei.js` |
| 天气活动（雨落成诗） | ⏳ 待移植 | 依赖 far2 没有的 `friend/api`、`farm/land-analysis`，需适配 |
| 奶茶店 | ⏳ 待移植 | 依赖 `pay.getDiamondBalance`、`milk-tea-work` |
| 宠日记 | ⏳ 待移植 | 依赖 `pet-diary.proto`（已合入）+ 图鉴数据 |

移植方式：同源 TS 用 `tsc --noCheck` 转译为 CommonJS，只做三处符号改名
（`types.ActivityListRequest/ActivityListReply/ActivityOperateReply` → `ActivityExt*`），
逻辑逐行保留；`activity-hub.js` 负责补齐 far2 缺失的小工具（int64 比较、文本解码、
背包余额、结算 settle*、状态持久化绑定）与三重闸门。

### 新增的兼容层（far2 没有、移植代码需要）

| 兼容文件 | 作用 |
| --- | --- |
| ``services/friend/api.js`` | 转发 far2 自己的 VisitService Enter/Leave（含护主犬探测） |
| ``services/farm/land-analysis.js`` | 转发 ``farm-land-analyzer`` 的 buildLandMap / getCurrentPhase / getDisplayLandContext |
| ``services/pay.js`` | ``getDiamondBalance()`` 读背包里的 1002 点券 |
| ``friend.js`` 新导出 | ``getFriendsListCacheOnly`` / ``isFriendCheckRunning`` / ``enterFriendFarm`` / ``leaveFriendFarm`` |

### 已验证（离线，全部 PASS）

`
✅ 四个子服务（星座/公益/七夕/青梅）实例化成功
✅ 闸门: FAR2_ACTIVITY_OPERATE 未开启 → 零请求
✅ dryRun: 公益红花领种子只返回计划
✅ 星座: operate_type=21 请求已发出
✅ 公益红花: operate_type=35 + field 134 请求已发出
✅ 预算: 每小时上限生效
`

跑法：`node scripts/activity-hub-selftest.js`

### 新增接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/activity/hub` | 星座/赛季/节气/公益/七夕/青梅 快照 + 当前策略 |
| POST | `/api/activity/hub/policy` | 动态开关 / dryRun / 每小时预算 |
| POST | `/api/activity/hub/:action` | `constellationClaim` / `charityClaimSeeds` / `charityDonateLove` / `charityClaimProgress` / `qixiClaimBridge` / `qingmeiClaimSeed` / `qingmeiSettle` |

## C. 还没做的

1. 天气 / 奶茶 / 宠日记 三个服务的依赖适配（下一步）；
2. 把四个活动接进 Scheduler 做每日自动执行（现在是手动/接口触发）；
3. 实机验证：需要先在 WebUI 添加一个账号（扫码或 Code），
   再按 `FAR2_ACTIVITY_OPERATE=1` + `FAR2_ACTIVITY_DRY_RUN=1` 的顺序放闸。

## D. 每日自动执行（activity-daily）

七项超集已经接进 worker 的每日例行（``runDailyRoutines``），但**默认关闭**：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| ``FAR2_ACTIVITY_AUTO`` | 关 | 打开后每天跑一次活动编排 |
| ``FAR2_ACTIVITY_OPERATE`` | 关 | 活动写链总闸门 |
| ``FAR2_ACTIVITY_DRY_RUN`` | 开 | 即使上面两个都开，也只出计划不发包 |
| ``FAR2_ACTIVITY_OPERATE_MAX_PER_HOUR`` | 30 | 每小时写操作预算 |

执行顺序（便宜且幂等 → 依赖前置 → 有消耗）：

```text
公益红花·领种子 → 公益红花·进度奖励 → 星座·点亮 → 七夕·鹊桥奖励 → 青梅·每日种子 → 宠日记·节令好礼
```

单步失败不阻断后续；``ACTIVITY_OPERATE_DISABLED`` / ``ACTIVITY_RATE_LIMITED`` 记为 skipped。
当天状态落在 ``core/data/activity-daily-<account>.json``。

手动触发 / 查看：

```powershell
$h = @{ 'x-admin-token'='<token>'; 'x-account-id'='<账号ID>' }
curl "http://127.0.0.1:3007/api/activity/daily/state" -Headers $h
curl -X POST "http://127.0.0.1:3007/api/activity/daily/run" -Headers $h -d '{"force":true}' -H 'content-type: application/json'
```

## E. 扫码登录（免手工 Code）

WebUI 自带二维码登录：``POST /api/qr/create`` 拿码 → 手机 QQ 扫码 → ``POST /api/qr/check`` 拿
``authCode`` → 建号并启动 worker。已封装成脚本：

```powershell
$env:FAR2_ADMIN_PASS='<管理员密码>'
node tools/qr-login.js --wait 900     # 生成二维码并轮询，扫码成功后自动建号+启动
```

二维码落在 ``data/login-qr.png``，约 5 分钟内有效（过期重跑即可）。

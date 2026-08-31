# FAR2 功能完整度与可移植性矩阵

更新时间：2026-08-31（Asia/Shanghai）

范围：当前 `D:\project2\far2` 工作树、当天 QQ 生产日志、已有自测/验收文档，以及本机恢复出的参考项目。
状态说明：`运行验证` 只用于确实有本机运行证据的能力；代码存在或 mock 通过不等于线上支持。

## 1. 恢复出的比较项目

| 参考 | 来源 | 结论 |
|---|---|---|
| QQ Farm 基础实现 | 本机 `D:\project2\farm` | 无 `.git` 元数据的本地源码副本，服务/proto/UI 基础集合与 FAR2 早期基线一致；可用于逐文件比较，但不能代表当前线上协议 |
| QQ Farm Automation Bot | FAR2 `README.md` 记录的 `https://github.com/XyhTender/qq-farm-automation-bot` | 上游/基础实现来源；本轮未把它的未知线上状态当成当前事实 |
| QQ Classic Farm 更新日志 | FAR2 `README.md` 与 `docs/FEATURE_GAP_AUDIT_2026-08-13.md` 记录的 `https://gitee.com/xlzcandy/qq-classic-farm-update-log` | 功能历史参考，不是可直接移植的实现仓库 |

本轮在当前工作区和 FAR2 现有文档中没有恢复出第二个可确认 URL 的、独立且更完整的 QQ/微信农场实现；因此没有编造仓库名称，也没有复制未经核实的外部代码。

## 2. QQ → 微信神秘商店结论

| 层次 | QQ | 微信 | 判定 |
|---|---|---|---|
| 业务调用 | `GetActiveNPC` → 解析活动 ID → `Buy` → 结果/幂等保护 | FAR2 微信 Worker 仍调用同一共享 Worker/`sendMsgAsync` 路径 | `A/B`：业务逻辑共用，微信运行开关独立 |
| 服务与方法 | `gamepb.mysteryshoppb.MysteryShopService` / `GetActiveNPC`、`Buy` | 当前代码路径使用同一服务名/方法名 | 静态兼容；微信 live read 仍待稳定 context |
| 请求编码 | 空 probe；购买请求动态 ID 的 protobuf varint，已验证 `Buy(1004)=08ec07` | 共享 `buildBuyRequest` | 直接复用 |
| 活动解析 | `top.field2.nested.field1` 作为当前 ID，校验 active/时间/范围 | 共享解析器 | 直接复用 |
| 账号保护 | `FARM_ACCOUNT_ID` 作用域 guard，成功/拒绝/不确定分别处理 | 同一进程模型可复用；开启前仍需微信运行实测 | 小适配 |
| 网关/会话 | QQ 默认网关配置 | `platform=wx`，Windows WeChat profile、WMPF 25510、Resident Agent/Code Provider | 平台特定，保持分离 |
| 运行验证 | 2026-08-24、26、28、30 有成功购买日志 | 当前 Agent `available=false`、`contextCount=0`，没有稳定微信 Farm Worker 证据 | QQ 运行验证；微信静态/自测验证，live pending |

实现策略：`core/src/services/mystery-shop.js` 现在是共享业务层；QQ 保持默认启用；微信通过 `FARM_MYSTERY_SHOP_WECHAT_ENABLED=1` 显式开启。未设置该开关时微信返回安全跳过，不发送 probe 或 Buy。

## 3. 功能矩阵

| 功能域 | FAR2 当前状态 | 证据等级 | 移植/后续判断 |
|---|---|---|---|
| 农场主循环 | 已有查询、调度、收获/种植/状态处理 | QQ 运行验证 | 已实现，不重写 |
| 收获 | 已有批量收获和成熟判断 | QQ 运行验证 | 已实现 |
| 种植 | 已有主策略、活动种子、1x1/2x2 预处理 | 源码/自测；QQ 运行日志 | 已实现，继续补 2x2 live E2E |
| 作物选择 | `max_exp / level / preferred / bag_priority` 等策略 | 源码/自测 | 已实现 |
| 浇水 | 农场循环和通知触发 | QQ 运行验证 | 已实现 |
| 施肥 | 普肥/有机、多季、土地类型选择、购买保护 | 源码/自测；QQ 运行验证 | 已实现 |
| 除草/除虫 | 土地状态分析与批量动作 | 源码/QQ 运行日志 | 已实现 |
| 偷菜/帮助/好友互动 | 好友池、巡查、护主犬优先帮助、失效 GID 处理 | QQ 运行验证 | 已实现；继续观察空目标 backoff |
| 农场扩展/土地升级 | LandCard、土地等级与升级动作 | 源码/构建/部分实机 UI | 已实现；不再扩架构 |
| 地块/土地处理 | Land analyzer、1x1/2x2 footprint、单地操作 | 源码/自测/验收文档 | 已实现；2x2 等待自然形成的 live 验收 |
| 背包/仓库 | 背包读取、种子识别、使用物品、出售 | 源码/自测/验收文档 | 已实现 |
| 种子/物品 | Item/Plant 配置、运行时 registry、活动种子学习 | 源码/自测/QQ 日志 | 已实现；未知映射 fail-closed |
| 普通商店购买 | ShopInfo、BuyGoods、缺失种子联动购买 | QQ 运行验证/验收文档 | 已实现，保持金额/限购保护 |
| 神秘商店 | QQ 动态 NPC ID、时间校验、单活动 guard、统计日志；微信共享代码但默认关闭 | QQ 运行验证；WX mock/静态 | 本批完成安全共享；微信需用户提供稳定 context 后 live read |
| 任务 | Task proto/service 与 UI 任务面板存在 | 源码/已有功能文档 | 已实现基础能力；未把外部旧任务代码直接移植 |
| 每日奖励/礼包 | daily gifts、VIP/month-card 等已有服务/UI 路径 | 源码/已有状态接口 | 已实现部分；具体奖励语义按当前协议继续核对 |
| 活动/事件发现 | Activity 只读、动态发现、事件种子优先 | 源码/自测/文档 | 已实现只读和已验证低风险部分 |
| 活动写操作 | 仅对已有证据的类型开放；未知活动只读 | 源码/安全边界 | 未验证类型不移植，避免误消费 |
| NPC/宠物系统 | 宠物只读、宠物商店、好友护主犬探测/帮助 | 源码/部分 E2E | 部分实现；狗狗资本等旧方向不移植 |
| 订单系统 | 未发现 FAR2 当前独立 Order service/UI | 未验证 | 暂不移植，先找当前 proto/流量证据 |
| 兑换/Exchange | activity proto 有 ExchangeShop 结构，当前以只读发现为主 | 静态 | 部分实现；没有购买语义证据不开放写入 |
| 自动资源使用 | 普肥/有机购买与土地动作有配置和阈值 | 源码/QQ 运行验证 | 已实现，保持限量和并发保护 |
| 冷却/定时器 | Farm/好友统一调度、RPC timeout、backoff、重试窗口 | 源码/自测/运行日志 | 已实现 |
| 能量/体力 | 未发现可确认的独立 FAR2 energy/stamina 协议路径 | 未验证 | 不移植，避免猜字段 |
| 好友系统 | QQ 好友/GID/访客/黑名单；微信申请路径有基础 proto | QQ 运行验证；WX 部分静态 | QQ 已实现；微信管理 UI/写操作暂不扩展 |
| 排行榜 | 未发现当前独立 ranking 服务/UI | 未验证 | 暂不移植 |
| 统计 | 操作统计、日切换、神秘商店状态/成功次数 | 源码/QQ 日志 | 已实现 |
| 状态持久化 | store/accounts、原子关键 JSON、账号级 guard | 源码/自测 | 已实现；禁止迁移 live SQLite/运行数据式覆盖 |
| 调度与恢复 | Runtime Engine、QQ exact-UIN CodeManager；微信 Resident Provider 部分完成 | QQ 运行验证；WX health | QQ 已实现；微信阻塞在稳定 WMPF context |
| 防重复/幂等 | 事件商店 guard、施肥重入保护、神秘商店活动 guard | 源码/自测/日志 | 已实现；任何新购买都必须沿用 |
| 限流 | rate-limiter、串行 worker API、RPC timeout | 源码/自测 | 已实现 |
| 配置/UI 暴露 | Web 面板、账号/土地/背包/活动/状态设置 | 构建/已有 UI 验收 | 已实现；微信神秘商店开关暂留运维环境变量，待 live 协议后再做 UI |

## 4. 本轮实际改动

- 将神秘商店共享业务层从“仅 QQ 运行”扩展为“QQ 默认、微信显式开启、未知平台拒绝”。
- 保留动态 ID、时间窗口、活动级 guard、服务端拒绝/不确定结果保护，不复制两套实现。
- 成功/失败日志增加 platform 标识，便于未来区分 QQ 与微信运行记录。
- 新增 QQ/WX policy、wire payload、mock RPC、成功后不重复购买的自测。
- 没有增加新的真实消费；没有调用 live 微信 Buy；没有修改账号、Token、密码或登录 Code。

## 5. 仍需本机运行验证

1. 让微信 Resident Agent 稳定选中目标农场 context，健康状态达到 `available=true`、`residentState=resident_connected`。
2. 先仅执行微信 `GetActiveNPC` 只读验证，确认服务、字段语义、ID、时间窗口和响应结构与 QQ 一致。
3. 若只读证据一致，再在明确授权和最小风险条件下设置 `FARM_MYSTERY_SHOP_WECHAT_ENABLED=1`，观察一次受 guard 保护的购买结果。
4. 验证微信 Worker 的启动、重连、状态统计和日志没有把 raw `wx.login` Code 写入普通日志。

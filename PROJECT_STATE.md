# FAR2 Project State / Handoff

> Last updated: 2026-08-13
>
> Repository: `xianyumht-cmd/far2`
>
> Branch: `main`
>
> Current authoritative baseline: `docs/PRODUCTION_BASELINE_2026-08-13.md`
>
> Current feature roadmap: `docs/FEATURE_GAP_AUDIT_2026-08-13.md`

## 1. Current status

FAR2 的 Code 自动刷新、完整好友导入、Windows 服务启动后账号自动恢复三条无人值守基础链均已完成验收。运行健康中心第一版、Provider target 范围自动启动和 P1 图鉴/种子商店主链也已完成真实 Windows 验证。

当前默认开发阶段：**P2 — 单土地控制 + 紫土地 + 2x2 背包种子**。

### Phase 1 — 单账号 Windows 无人值守 Code 自动刷新

**COMPLETED / ACCEPTED**

已经真实验证：

- FAR2Farm 作为 Windows 后台服务运行；
- Code Agent 作为隐藏交互式任务运行；
- exact-UIN Provider 定向刷新；
- WS400 / kickout 后自动恢复；
- healthy 状态采用 event-only，不做每小时主动重登；
- 新 Code 成功后再替换旧 Worker；
- Farm 自动重新登录；
- 浏览器无需保持打开；
- 正常日志/UI 不暴露明文 Code；
- 约 9 小时真实无人值守运行已通过。

正式记录：`docs/CODE_REFRESH_MILESTONE_2026-08-12.md`。

### Phase 2 — QQ 完整好友池自动导入

**COMPLETED / ACCEPTED**

已经真实验证：

- QQ Farm 启动阶段自动采集好友关系；
- 当前唯一正式采集实现为 `windows-runtime-friends-v4.js`；
- 实机采集 103 GID / 275 openId；
- Worker 最终得到 97 位当前有效好友；
- 完整好友池已经实际进入帮助 / 巡查 / 偷菜链。

正式记录：`docs/FRIEND_GID_HANDOFF_2026-08-13.md`。

### Phase 3 — Windows 服务启动后 Worker 自动恢复

**COMPLETED / ACCEPTED**

2026-08-13 已完成真实 Windows 验证：

1. FAR2Farm 服务重启；
2. 不打开浏览器、不手动点击“启动账号”；
3. FAR2 自动启动账号 `232`；
4. 首次 Farm WS 返回 HTTP 400；
5. CodeManager 自动恢复，旧 Worker 正常退出；
6. 新 Worker 自动启动并登录成功，账号恢复到 Lv112；
7. V4 好友启动导入同步恢复：103 GID / 275 openId；
8. 好友帮助与巡查实际继续运行。

正式链：

```text
FAR2Farm service restart
  -> CodeManager / friend importer ready
  -> target Worker auto-start
  -> WS400 if Code stale
  -> targeted Code refresh
  -> replacement Worker auto-start
  -> Farm login recovered
  -> V4 friend pool restored
  -> automation resumes
```

当前单机生产约束为只运行一个目标 QQ；其他保存账号不要求在同一 Windows 实例同时在线，因此不作为失败项，也不需要 Windows2 验收。

### Phase 4 — 运行健康中心

**V1 IMPLEMENTED / VISUALLY VERIFIED**

当前 `/health` 已能统一显示：

- Worker；
- Farm 在线/等级；
- Code 自动恢复；
- QQ 好友池 GID/openId；
- 最近 WS400/Code 恢复事件；
- 权限隔离后的账号汇总。

实机显示 `232`：Farm Lv112、Code 恢复可用、好友池 103 GID / 275 openId。

### P0 — Provider target 范围自动启动

**COMPLETED / ACCEPTED**

健康中心曾暴露：保存两个账号时 `4476` 与 `232` 都被拉起 Worker，而当前机器只有 `232` 是正式 Provider target。

源码已收紧并完成真实 Windows 重启验证：

- 有 `FARM_CODE_PROVIDER_TARGETS` / `_B64` 时，只自动启动 UIN 与 target key 匹配的保存账号；
- Provider targets 配置无效时 fail-closed；
- 合法但无匹配保存账号时不乱启 Worker；
- 没有 Provider targets 的通用部署仍保持“自动启动全部保存账号”；
- `FARM_AUTO_START_ACCOUNT_REFS` 可显式覆盖范围；
- WebUI 手动启动其他账号不受影响。

实机健康页已确认：

- 保存账号：2；
- Worker 运行：1；
- Farm 在线：1；
- `4476`：未运行；
- `232`：运行中 / Farm Lv112 在线。

### P1 — 图鉴 + 种子商店

**MAIN FLOW COMPLETED / ACCEPTED**

正式记录：`docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`。

已真实验收：

- 当前作物图鉴 V2：134 条；
- 已解锁：106；
- 未解锁：28；
- 图鉴积分：3820；
- 图鉴等级：Lv23；
- 当前 Tier：1；
- 当前种子/宠物/其他商店协议可读；
- Catalog 请求已按账号串行，默认打开页面只读取一次图鉴；
- 手动缺失种子分析不再压满 Farm WS 队列；
- 未再出现 `pending=5`、50 秒无响应或心跳超时；
- 同期好友 SyncAll / 偷菜 / 帮助 / 农场循环继续正常运行。

缺失种子真实购买也已通过：

```text
购买前：未解锁 28 / 背包已有 0 / 可买 1 / 预计 15432 金币
唯一可买：大王花 fruitId=40227 / seedId=20227
执行：买 1 份种子
购买后：未解锁 28 / 背包已有 1 / 可买 0 / 预计 0
```

这证明“图鉴缺失识别 → 当前商店价格 → 当前背包 → 白名单 BuyGoods → 防重复购买”真实写操作链已验收。

#### P1 保留待确认项：图鉴奖励领取

**LOCKED / NOT ACCEPTED**

当前 `has_reward` / `reward_info` 不能可靠区分“已领取”和“未领取”。真实账号以前已经领取过奖励，但服务器仍返回大量 reward flag，因此：

- WebUI 只显示“奖励状态：待确认”；
- 不再显示误导性的“可领奖 60”；
- `/api/catalog/illustrated/claim` 服务端返回 409；
- 在字段语义获得可靠实机证据前，不发送领奖 RPC。

这个待确认项不再阻塞 Roadmap 进入 P2。

### P2A — 单土地控制 / 土地等级展示

**UI ACCEPTED / WRITE ACTIONS AVAILABLE**

正式记录：`docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`。

2026-08-13 Windows 实机已确认：

- `pnpm land:controls-selftest` 通过；
- `pnpm build:web` 通过；
- “个人 -> 我的农场”能显示 `#landId · LvX`；
- 当前 #1~#8 实际返回 `Lv5`，#9 起可见大量 `Lv4`；
- Lv5 紫色视觉、Lv4 金色视觉与当前游戏土地分层一致；
- 有作物土地显示单块 `铲除 / 普肥 / 有机`；
- 顶部 `一键铲除` 已存在并保持二次确认。

当前地里没有 2x2 合种作物，因此“合种副地”没有实机画面不是失败项。用户确认背包里有过去领取的 2x2 种子，但旧 `bag_priority` 仅消费 1x1 种子，这属于 P2C 待补能力，而不是 P2A 缺陷。

### P2B — 紫土地运行时分类

**SOURCE COMPLETE / LIVE REGRESSION CHECK PENDING**

实机已证明 `Lv5` 存在；后续公开实现也明确：

```text
Lv5 = purple / 紫土地
Lv4 = gold / 金土地
Lv3 = black
Lv2 = red
else = normal
```

当前源码已把 Lv5 从旧的“>=4 全算 gold”中拆出，并对旧 `gold/black/red/normal` 四类全选配置做运行时兼容：旧配置继续等价于“所有土地”，自动补入 purple，不要求用户重存设置。

### P2C — 背包 2x2 种子识别与种植

**SOURCE COMPLETE / LIVE 2x2 ACCEPTANCE PENDING**

正式记录：`docs/P2_PURPLE_AND_2X2_2026-08-13.md`。

首版边界：

- 旧 `Plant.json` 缺失的已知种子 `20046`（爱心果）按 `plantSize=2` fallback 识别；
- fallback 只用于按 seedId / 背包识别，不注入商店自动候选；
- `bag_priority` 先尝试背包 2x2，再处理 1x1；
- 只在最新 `AllLands` 确认四块真实空地时发送 2x2 Plant；
- 24 地按 4x6 几何，master 为左下角；
- Plant 回包必须验证 master/slave 关系，异常 fail-closed；
- 不主动铲除生长中的作物制造 2x2 空位；
- 商店自动购买 2x2 暂不开放，等待背包 2x2 实机通过。

当前下一次实机验证不需要手动铲地：等待自然成熟/自动收获形成完整 2x2 空位即可。

## 2. Current production architecture

```text
Windows / FAR2Farm service start
  -> Runtime Engine
       -> CodeManager + startup friend importer ready
       -> resolve startup account scope
            -> Provider targets configured: only matching QQ UINs
            -> no Provider targets: all saved accounts (generic behavior)
       -> Worker

Interactive Windows session
  -> FAR2CodeAgent-<UIN>
       -> startup Friend Capture V4
       -> exact-UIN Code Provider

Friend path
  -> V4 GID/openId artifact
  -> FAR2 startup import
  -> SyncAll / GetGameFriends
  -> help / patrol / steal

Code recovery path
  -> WS400 / kickout
  -> exact-UIN Provider refresh
  -> new Code validated
  -> old Worker stopped
  -> replacement Worker starts
  -> Farm login recovers

Catalog path
  -> WebUI /catalog
  -> per-account Catalog queue
  -> Worker Catalog RPCs serialized
  -> Illustrated / ShopInfo / Bag
  -> guarded missing-seed purchase

P2 planting extension
  -> bag_priority
  -> recognize known missing 2x2 seed metadata
  -> latest AllLands live-empty check
  -> legal 4x6 2x2 group
  -> one Plant RPC with 4 landIds
  -> validate master/slave response
  -> continue remaining 1x1 / fallback strategy
```

## 3. Second QQ / second Windows Session

这是**可选未来扩展**，不是当前主线，不是当前完成标准，也不需要为了继续项目而去 Windows 2 做验收。

当前实际生产约束按“一台 Windows 只运行一个目标 QQ”处理。多 Session / 多 target 的部署能力已经存在；未来确实需要第二 QQ 时，再单独做第二账号实机 E2E。

`docs/MULTI_SESSION_CODE_AGENT_HANDOFF_2026-08-13.md` 只作为未来扩展参考，不得把其中“第二 QQ acceptance pending”解释成当前项目未完成。

## 4. Production code boundary

### Friend capture

正式实现：

```text
core/src/services/windows-runtime-friends-v4.js
```

生产 Agent 直接引用 V4：

```text
core/scripts/qq-isolated-code-agent.js
```

V1 / V2 / V3 已从生产基线删除，不允许重新 fallback。

### Code refresh

正式组件：

```text
core/src/services/code-manager.js
core/src/services/desktop-session-registry.js
core/src/services/isolated-runtime-code-provider.js
core/src/services/isolated-code-agent.js
core/src/services/windows-runtime-code.js
```

保留 Provider、CodeManager、Session Registry 和 runtime-code 相关安全自测/诊断工具。

### Catalog

当前正式组件：

```text
core/src/services/catalog.js
core/src/controllers/catalog-api.js
web/src/views/Catalog.vue
```

Catalog 必须继续保持：

- 按账号串行；
- 不扩大 Farm WS 全局 pending 上限；
- 写操作以前端参数不可信为原则；
- 当前服务器 ShopInfo 负责价格/解锁/限购真相；
- 未确认 reward 字段不得恢复领奖。

## 5. Removed rejected experiments

2026-08-13 收口阶段已删除：

- QQ miniapp 旧 QR mode test；
- PC bridge test；
- dual-scan test；
- renderer restart test；
- target-window reload test；
- target-session preload；
- Friend Capture V1 / V2 / V3；
- 对应已判废 pnpm 命令入口。

## 6. Do not repeat

除非出现真正新的技术证据，不要重新尝试：

- 旧 QR exchange；
- QZone / PC cookie bridge / dual scan；
- shared-desktop 全局 QQ chooser；
- Ctrl+R 目标窗口刷新；
- renderer restart / kill；
- PID / window order 猜账号；
- preload / 注入捷径绕过当前隔离设计；
- Friend Capture V1 / V2 / V3；
- 秒偷 / 蹲守 / 自动刷变异等后续版本自己已删除的功能；
- 再次把 `has_reward=true` 直接解释成“未领取奖励”。

## 7. Current feature roadmap

后续私有版功能差异审计固定到：

```text
docs/FEATURE_GAP_AUDIT_2026-08-13.md
```

当前进度：

1. **P0：Provider target 范围自动启动 Worker**：✅ 已验收；
2. **P1：图鉴 + 种子商店**：✅ 主链已验收；领奖字段单独锁定待确认；
3. **P2A：单土地控制 / 土地等级展示**：✅ UI 实机验收；
4. **P2B：Lv5 紫土地运行时分类**：🟡 源码完成，待升级后回归；
5. **P2C：背包 2x2 种子识别/种植**：🟡 源码完成，待自然空位实机 E2E；
6. **P3：变异只读展示**；
7. **P4：宠物 / 狗狗**；
8. **P5：个人生涯 / 装扮 / 通用活动框架**。

## 8. How to continue from here

后续新对话按下面优先级判断项目状态：

1. 当前 `main` 源码；
2. `PROJECT_STATE.md`；
3. `docs/PRODUCTION_BASELINE_2026-08-13.md`；
4. `docs/P2_PURPLE_AND_2X2_2026-08-13.md`；
5. `docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`；
6. `docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`；
7. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；
8. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；
9. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；
10. 其他历史文档。

**不要再把 Code 自动刷新、好友完整导入、Windows2、P0、P1 或 P2A 已验收 UI 当成默认下一步。**

当前默认动作：**验证 P2B/P2C；2x2 成功后再进入 P3 变异只读展示。**

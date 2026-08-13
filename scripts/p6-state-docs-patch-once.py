from pathlib import Path

path = Path('PROJECT_STATE.md')
text = path.read_text(encoding='utf-8')

old_status = '当前开发状态：**P2C / P3A / P4A / P5A / P5B 均已完成源码/构建，真实读取或自然条件验收不阻塞开发；当前主线进入 P5C 通用活动框架审计。**'
new_status = '当前开发状态：**P5C-A 通用活动只读发现层已完成；P6A～P6F Farm 架构收口已全部合并并完成全链构建/契约回归。P2C / P3A 等自然条件、P4A / P5A / P5B / P5C-A 等真实读取验收均不阻塞开发。当前不再默认继续架构拆分，下一步回到业务价值 / 真实稳定性差异审计。**'
if text.count(old_status) != 1:
    raise SystemExit(f'current status anchor mismatch: {text.count(old_status)}')
text = text.replace(old_status, new_status, 1)

p5b_end = '没有穿戴、使用、购买或资料修改接口。\n\n## 2. Current production architecture'
if text.count(p5b_end) != 1:
    raise SystemExit(f'P5B end anchor mismatch: {text.count(p5b_end)}')
insert = '''没有穿戴、使用、购买或资料修改接口。

### P5C-A — 通用活动只读发现层

**SOURCE + BUILD COMPLETE / LIVE READ ACCEPTANCE PENDING**

当前活动中心只走通用只读协议：

```text
活动
  -> GET /api/activities
  -> Worker listActivities
  -> ActivityService.List
  -> ActivityInfo[] / parent-child tree / payload summary
```

当前实现：

- 自动发现服务器当前活动，不在核心硬编码某个活动 ID / UID / cmd；
- 保留 title / type / parent / 起止时间 / visible / status / enabled；
- 通用读取 random shop / exchange shop / draw 摘要；
- payload 能解析 JSON 时读取结构，不能解析时保留 raw；
- adapter 注册位保留为空，只有未来出现真实特殊活动解析需求才增加；
- proto 第一版没有 `Operate`，WebUI 也没有兑换、抽奖、领奖等写按钮。

P5C-A 已完成 `activity:readonly-selftest`、`vue-tsc + vite build` 与后端语法检查。真实当前活动内容读取不阻塞后续开发。

### P6 — Farm 架构收口

**COMPLETED / VALIDATED**

正式记录：`docs/P6_ARCHITECTURE_CONSOLIDATION_2026-08-13.md`。

最终 `main` 基线：`cd8cb196b59a2c4c55c6193e706578ea7961406b`。

P6 采用分阶段迁移，不重写已验收业务：

- P6A：`farm-land-analyzer.js`；
- P6B：`farm-api.js`；
- P6C：`farm-fertilizer.js`；
- P6D：`planting-service.js`；
- P6E1：`farm-orchestrator.js`；
- P6E2：`farm-scheduler.js`；
- P6F：`farm-query-service.js` + 最终 `farm.js` facade。

最终 `farm.js` 只保留模块组装、operation-limit callback wrapper 和稳定 public exports。P2 2x2、P3 mutation、施肥、巡田顺序、scheduler 时序和 Worker/Admin/Web public 调用均保持兼容。

P6F 合并前已完成 query / scheduler / orchestrator / planting / fertilizer / API / analyzer / 单土地 / 2x2 / mutation / activity / Web build 全链验证。

**P6 到此结束，不把“继续拆文件”当成默认下一步。**

## 2. Current production architecture'''
text = text.replace(p5b_end, insert, 1)

personal_arch = '''Personal read-only extensions
  -> DogService.GetDogInfo -> 护主犬
  -> CareerService.CareerInfoGet -> 个人生涯
  -> existing ItemService.Bag type=10 -> 头像框库存
  -> all through account-scoped Worker/DataProvider/Admin GET paths
'''
if text.count(personal_arch) != 1:
    raise SystemExit(f'personal architecture anchor mismatch: {text.count(personal_arch)}')
expanded_arch = personal_arch + '''
Activity read-only discovery
  -> ActivityService.List
  -> generic ActivityInfo DTO / tree / payload summary
  -> no Operate write path in P5C-A

Farm domain after P6
  -> farm.js facade / operation-limit callback wrapper
  -> farm-api raw RPC
  -> farm-land-analyzer pure land analysis
  -> farm-fertilizer policy/execution
  -> planting-service Plant/bag/shop/2x2 execution
  -> farm-orchestrator business flow
  -> farm-scheduler loop/push/fertilizer-buy timing
  -> farm-query-service WebUI/read DTOs
'''
text = text.replace(personal_arch, expanded_arch, 1)

removed_heading = '## 5. Removed rejected experiments'
idx = text.find(removed_heading)
if idx < 0:
    raise SystemExit('removed experiments heading missing')
farm_boundary = '''### Farm domain

P6 完成后的正式组件：

```text
core/src/services/farm.js
core/src/services/farm-api.js
core/src/services/farm-land-analyzer.js
core/src/services/farm-fertilizer.js
core/src/services/planting-service.js
core/src/services/farm-orchestrator.js
core/src/services/farm-scheduler.js
core/src/services/farm-query-service.js
```

生产边界：

- `farm.js` 是稳定 facade / composition root；
- `getAllLands()` callback wrapper 不得被内部 raw transport 绕过；
- P2C 独立 2x2 prepass 不得重新绑定到 `bag_priority`；
- 商店自动购买 2x2 仍关闭；
- scheduler 的 2000ms 首次检查、500ms push debounce、100ms push delayed check 保持现有契约；
- 后续不要为了“文件更小”继续无目标拆分。

'''
text = text[:idx] + farm_boundary + text[idx:]

roadmap_start = text.find('## 7. Current feature roadmap')
continue_start = text.find('## 8. How to continue from here', roadmap_start)
if roadmap_start < 0 or continue_start < 0:
    raise SystemExit(f'roadmap anchors missing: {roadmap_start}, {continue_start}')
new_roadmap = '''## 7. Current feature roadmap

后续私有版功能差异审计固定到：

```text
docs/FEATURE_GAP_AUDIT_2026-08-13.md
```

当前进度：

1. **P0：Provider target 范围自动启动 Worker**：✅ 已验收；
2. **P1：图鉴 + 种子商店**：✅ 主链已验收；领奖字段单独锁定待确认；
3. **P2A：单土地控制 / 土地等级展示**：✅ UI 实机验收；
4. **P2B：Lv5 紫土地运行时分类**：🟡 源码/设置完成，待自然运行回归；
5. **P2C：独立 2x2 优先种植**：🟡 源码/构建完成，待自然空位实机 E2E；
6. **P3A：变异只读展示**：🟡 源码/构建完成，待自然变异作物视觉验收；
7. **P4A：护主犬状态只读**：🟡 源码/构建完成，待真实 GetDogInfo 读取验收；
8. **P4B：护主犬礼包领取**：🔒 写操作锁定，等 P4A 真实回包；
9. **P5A：个人生涯只读**：🟡 源码/构建完成，待真实 CareerInfoGet 读取验收；
10. **P5B：头像框库存只读**：🟡 源码/构建完成，当前佩戴协议仍锁定待证据；
11. **P5C-A：Activity List 通用活动只读发现层**：🟡 源码/构建完成，待真实当前活动读取验收；
12. **P6A～P6F：Farm 架构收口**：✅ 全部合并 / 全链回归通过。

P0～P6 已没有需要为了“继续项目”而强制完成的源码阻塞项。所有自然条件/真实只读验收继续作为观察项存在，但不反向阻塞新业务开发。

'''
text = text[:roadmap_start] + new_roadmap + text[continue_start:]

continue_start = text.find('## 8. How to continue from here')
if continue_start < 0:
    raise SystemExit('continue heading missing after roadmap rewrite')
new_tail = '''## 8. How to continue from here

后续新对话按下面优先级判断项目状态：

1. 当前 `main` 源码；
2. `PROJECT_STATE.md`；
3. `docs/PRODUCTION_BASELINE_2026-08-13.md`；
4. `docs/P6_ARCHITECTURE_CONSOLIDATION_2026-08-13.md`；
5. `docs/P2_PURPLE_AND_2X2_2026-08-13.md`；
6. `docs/P3_MUTATION_READONLY_2026-08-13.md`；
7. `docs/P4_P5_READONLY_2026-08-13.md`；
8. `docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`；
9. `docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`；
10. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；
11. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；
12. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；
13. 其他历史文档。

**不要再把 Code 自动刷新、好友完整导入、Windows2、P0、P1、P2A、P2C、P3A、P4A、P5A、P5B、P5C-A 或 P6 的源码实现当成默认下一步。**

P2C / P3A 等自然条件，P4A / P5A / P5B / P5C-A 等真实读取，均不阻塞开发；写操作继续按真实证据单独解锁。

当前默认动作：**重新审计当前 `main` 与成熟实现之间剩余的业务能力、真实稳定性问题和可验证协议差异，按用户价值 / 风险 / 证据强度选下一项。不要自动进入 P7 式架构重构。**
'''
text = text[:continue_start] + new_tail

path.write_text(text, encoding='utf-8')
print('PROJECT_STATE P5C/P6 completion patch applied')

from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 anchor, found {count}')
    return text.replace(old, new, 1)


path = Path('PROJECT_STATE.md')
text = path.read_text(encoding='utf-8')

text = replace_once(
    text,
    '当前默认开发阶段：**P2 — 单土地控制 + 紫土地 + 2x2 背包种子**。',
    '当前开发状态：**P2C 与 P3A 均已完成源码/构建，等待自然条件实机验收；开发主线继续 P4 宠物 / 狗狗审计。**',
    'current stage',
)

p2c_start = text.index('### P2C — 背包 2x2 种子识别与种植')
p2c_end = text.index('\n## 2. Current production architecture', p2c_start)
p2c_new = '''### P2C — 独立 2x2 优先种植

**SOURCE + BUILD COMPLETE / LIVE 2x2 E2E PENDING**

正式记录：`docs/P2_PURPLE_AND_2X2_2026-08-13.md`。

当前正式实现已经取代早期“必须 `bag_priority` 才处理 2x2”的首版设计：

- `prioritize2x2Crops` 是独立账号设置，默认开启；
- 主策略可继续保持 `max_exp / level / preferred / bag_priority`；
- 自动种植先运行独立 2x2 prepass，再把剩余空地交回原主策略；
- 已知旧配置缺失种子 `20046`（爱心果）按 `plantSize=2` fallback 识别；
- 最新 `AllLands` 负责确认真实空地和已有 master/slave footprint；
- 24 地按 4x6 几何，master 为左下角；
- Plant 回包必须验证 master/slave 关系，异常 fail-closed；
- 不主动铲除生长作物制造空位；
- 未完整 2x2 最多预留一组，而且预留跨巡田周期保持稳定；
- 预留组当前已经空出的土地不会被普通 1x1 主策略填回；
- 其他空地继续原来的主策略，不会锁死整片农田；
- 商店自动购买 2x2 仍关闭，等待背包已有 2x2 的真实 E2E。

已完成 `planting:2x2-selftest`、`vue-tsc + vite build`、后端语法检查与 diff 检查。

真实验收不需要手动铲地，也不需要切换主种植策略。等待自然成熟形成完整预留区即可。

### P3A — 变异只读展示

**SOURCE + BUILD COMPLETE / LIVE VISUAL ACCEPTANCE PENDING**

正式记录：`docs/P3_MUTATION_READONLY_2026-08-13.md`。

当前实现严格只读：

- 直接读取现有 `AllLands` 中的 `PlantInfo.mutant_config_ids`；
- 读取当前阶段 `PlantPhaseInfo.mutants`；
- 静态映射 10 种已知变异效果；
- 未知 ID 保留并显示为 `未知变异 #ID`；
- 2x2 副地不重复显示主地变异；
- LandCard 只增加变异文本徽标/说明；
- 没有新增变异写 RPC、操作按钮、自动重刷或“自动刷变异”开关。

已完成 `mutation:readonly-selftest`、`vue-tsc + vite build`、后端语法检查与 diff 检查。

真实视觉验收只等自然出现带变异信息的作物；没有变异作物时页面不显示变异属于正常状态。
'''
text = text[:p2c_start] + p2c_new + text[p2c_end:]

old_arch = '''P2 planting extension
  -> bag_priority
  -> recognize known missing 2x2 seed metadata
  -> latest AllLands live-empty check
  -> legal 4x6 2x2 group
  -> one Plant RPC with 4 landIds
  -> validate master/slave response
  -> continue remaining 1x1 / fallback strategy'''
new_arch = '''P2 planting extension
  -> independent prioritize2x2Crops prepass
  -> recognize owned 2x2 seed metadata
  -> latest AllLands / legal 4x6 footprint
  -> ready: one Plant RPC with 4 landIds + validate master/slave
  -> not ready: reserve at most one footprint
  -> remaining empty lands continue existing main strategy

Mutation read-only path
  -> existing AllLands mutant_config_ids / phase mutants
  -> farm-mutation read model
  -> known metadata + unknown IDs
  -> LandCard read-only badges'''
text = replace_once(text, old_arch, new_arch, 'architecture')

old_roadmap = '''4. **P2B：Lv5 紫土地运行时分类**：🟡 源码完成，待升级后回归；
5. **P2C：背包 2x2 种子识别/种植**：🟡 源码完成，待自然空位实机 E2E；
6. **P3：变异只读展示**；
7. **P4：宠物 / 狗狗**；
8. **P5：个人生涯 / 装扮 / 通用活动框架**。'''
new_roadmap = '''4. **P2B：Lv5 紫土地运行时分类**：🟡 源码/设置完成，待自然运行回归；
5. **P2C：独立 2x2 优先种植**：🟡 源码/构建完成，待自然空位实机 E2E；
6. **P3A：变异只读展示**：🟡 源码/构建完成，待自然变异作物视觉验收；
7. **P4：宠物 / 狗狗**：➡️ 当前开发主线；
8. **P5：个人生涯 / 装扮 / 通用活动框架**。'''
text = replace_once(text, old_roadmap, new_roadmap, 'roadmap')

text = replace_once(
    text,
    '5. `docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`；\n6. `docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`；',
    '5. `docs/P3_MUTATION_READONLY_2026-08-13.md`；\n6. `docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`；\n7. `docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`；',
    'precedence insert P3',
)
# Renumber the tail after inserting one item.
text = text.replace('7. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；\n8. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；\n9. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；\n10. 其他历史文档。',
                    '8. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；\n9. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；\n10. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；\n11. 其他历史文档。')

text = replace_once(
    text,
    '**不要再把 Code 自动刷新、好友完整导入、Windows2、P0、P1 或 P2A 已验收 UI 当成默认下一步。**\n\n当前默认动作：**验证 P2B/P2C；2x2 成功后再进入 P3 变异只读展示。**',
    '**不要再把 Code 自动刷新、好友完整导入、Windows2、P0、P1、P2A、P2C 源码实现或 P3A 源码实现当成默认下一步。**\n\nP2C 与 P3A 的真实验收都等待自然条件，不阻塞开发。当前默认动作：**进入 P4 宠物 / 狗狗的只读协议与产品能力审计。**',
    'next action',
)

path.write_text(text, encoding='utf-8')
print('PROJECT_STATE P2/P3 handoff updated')

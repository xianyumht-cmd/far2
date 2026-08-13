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
    '当前开发状态：**P2C 与 P3A 均已完成源码/构建，等待自然条件实机验收；开发主线继续 P4 宠物 / 狗狗审计。**',
    '当前开发状态：**P2C / P3A / P4A / P5A / P5B 均已完成源码/构建，真实读取或自然条件验收不阻塞开发；当前主线进入 P5C 通用活动框架审计。**',
    'current stage',
)

insert_anchor = '\n## 2. Current production architecture\n'
sections = '''
### P4A — 护主犬状态只读

**SOURCE + BUILD COMPLETE / LIVE READ ACCEPTANCE PENDING**

正式记录：`docs/P4_P5_READONLY_2026-08-13.md`。

当前正式链：

```text
个人 -> 护主犬
  -> GET /api/dog/info
  -> Worker getDogInfo
  -> DogService.GetDogInfo
```

已读取/保留：狗列表、等级、状态、激活状态、有效期、coin、保护时间、狗粮，以及 raw protobuf 顶层 field 7（若线上返回）作为 `claimableGiftCount`。

当前严格只读，没有 `ClaimSkillGifts`、喂食、切换、好友狗探测或自动狗狗操作。P4B 领取写操作必须等真实 P4A 回包后再决定。

### P5A — 个人生涯只读

**SOURCE + BUILD COMPLETE / LIVE READ ACCEPTANCE PENDING**

正式记录：`docs/P4_P5_READONLY_2026-08-13.md`。

当前链：

```text
个人 -> 个人生涯
  -> GET /api/career/info
  -> Worker getCareerInfo
  -> CareerService.CareerInfoGet
```

实现 typed protobuf 优先 + raw protobuf fallback；raw fallback 保留 UTF-8 中文昵称。UI 显示玩家等级/经验/GID、统计总量、Top3 和收获明细，并保留 decodeMode / response bytes 方便实机验收。

没有生涯领奖、资料修改或自动操作。

### P5B — 头像框库存只读

**SOURCE + BUILD COMPLETE / LIVE READ ACCEPTANCE PENDING**

正式记录：`docs/P4_P5_READONLY_2026-08-13.md`。

当前没有可靠的 `equip_avatar_frames` 内部 protobuf 定义，因此不猜“当前佩戴”。正式实现只复用已有 Bag 读链：

```text
个人 -> 头像框
  -> GET /api/appearance/avatar-frames
  -> Worker getAvatarFrames
  -> existing ItemService.Bag
  -> filter owned itemType=10
```

页面明确显示：`当前佩戴：待协议确认`。

没有穿戴、使用、购买或资料修改接口。
'''
text = replace_once(text, insert_anchor, '\n' + sections + insert_anchor, 'P4/P5 sections')

old_arch = '''Mutation read-only path
  -> existing AllLands mutant_config_ids / phase mutants
  -> farm-mutation read model
  -> known metadata + unknown IDs
  -> LandCard read-only badges'''
new_arch = '''Mutation read-only path
  -> existing AllLands mutant_config_ids / phase mutants
  -> farm-mutation read model
  -> known metadata + unknown IDs
  -> LandCard read-only badges

Personal read-only extensions
  -> DogService.GetDogInfo -> 护主犬
  -> CareerService.CareerInfoGet -> 个人生涯
  -> existing ItemService.Bag type=10 -> 头像框库存
  -> all through account-scoped Worker/DataProvider/Admin GET paths'''
text = replace_once(text, old_arch, new_arch, 'architecture extension')

old_roadmap = '''6. **P3A：变异只读展示**：🟡 源码/构建完成，待自然变异作物视觉验收；
7. **P4：宠物 / 狗狗**：➡️ 当前开发主线；
8. **P5：个人生涯 / 装扮 / 通用活动框架**。'''
new_roadmap = '''6. **P3A：变异只读展示**：🟡 源码/构建完成，待自然变异作物视觉验收；
7. **P4A：护主犬状态只读**：🟡 源码/构建完成，待真实 GetDogInfo 读取验收；
8. **P4B：护主犬礼包领取**：🔒 写操作锁定，等 P4A 真实回包；
9. **P5A：个人生涯只读**：🟡 源码/构建完成，待真实 CareerInfoGet 读取验收；
10. **P5B：头像框库存只读**：🟡 源码/构建完成，当前佩戴协议仍锁定待证据；
11. **P5C：通用活动框架**：➡️ 当前开发主线。'''
text = replace_once(text, old_roadmap, new_roadmap, 'roadmap')

text = replace_once(
    text,
    '5. `docs/P3_MUTATION_READONLY_2026-08-13.md`；\n6. `docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`；',
    '5. `docs/P3_MUTATION_READONLY_2026-08-13.md`；\n6. `docs/P4_P5_READONLY_2026-08-13.md`；\n7. `docs/P2_SINGLE_LAND_CONTROLS_2026-08-13.md`；',
    'precedence P4/P5 doc',
)
text = text.replace(
    '7. `docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`；\n8. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；\n9. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；\n10. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；\n11. 其他历史文档。',
    '8. `docs/P1_CATALOG_ACCEPTANCE_2026-08-13.md`；\n9. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；\n10. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；\n11. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；\n12. 其他历史文档。',
)

text = replace_once(
    text,
    '**不要再把 Code 自动刷新、好友完整导入、Windows2、P0、P1、P2A、P2C 源码实现或 P3A 源码实现当成默认下一步。**\n\nP2C 与 P3A 的真实验收都等待自然条件，不阻塞开发。当前默认动作：**进入 P4 宠物 / 狗狗的只读协议与产品能力审计。**',
    '**不要再把 Code 自动刷新、好友完整导入、Windows2、P0、P1、P2A、P2C、P3A、P4A、P5A 或 P5B 的源码实现当成默认下一步。**\n\nP2C / P3A 等自然条件，P4A / P5A / P5B 等真实读取，均不阻塞开发；写操作继续按真实证据单独解锁。当前默认动作：**进入 P5C 通用活动框架审计。**',
    'next action',
)

path.write_text(text, encoding='utf-8')
print('PROJECT_STATE advanced through P5B')

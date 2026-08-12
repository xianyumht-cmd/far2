# FAR2 P2A — 单土地控制 / 紫土地展示 — 2026-08-13

状态：**SOURCE COMPLETE / LIVE UI CHECK PENDING**

## 目标

按 `FEATURE_GAP_AUDIT_2026-08-13.md` 的 P2 推进个人农场交互，但先保持低风险边界：

- 单块土地铲除；
- 单块普通肥；
- 单块有机肥；
- 单块土地升级；
- 一键铲除全部已种植作物；
- 土地卡片显示原始 `level`；
- `level >= 5` 暂按紫土地展示，用实机数据确认后再进入自动施肥范围。

## 当前实现

继续复用现有：

```text
POST /api/farm/operate
  -> DataProvider.doFarmOp
  -> Worker doFarmOp
```

没有新增平行的农场写 API。

新的严格命令只有：

```text
land:remove:<landId>
land:fertilize-normal:<landId>
land:fertilize-organic:<landId>
land:upgrade:<landId>
remove-all
```

其他现有 `harvest / clear / plant / upgrade / all` 仍走原来的 `runFarmOperation()`。

## 安全边界

`core/src/services/land-controls.js` 每次写操作都会先重新读取当前 `AllLands`，不信任前端土地状态。

服务端检查包括：

- landId 必须存在；
- 土地必须已解锁；
- 铲除/施肥必须仍有真实作物；
- 有机肥在服务端返回 `left_inorc_fert_times <= 0` 时拒绝；
- 土地升级必须仍为 `could_upgrade=true`；
- 2x2 合种副地会解析回 master land，避免重复操作同一合种作物；
- 一键铲除重新读取当前土地，只处理真实有作物的 master land，并去重；
- 同一 Worker 同时只允许一个手动土地操作；
- 后台巡田 / 好友帮助 / 偷菜正在执行时，手动土地写操作直接拒绝并提示稍后再试；
- 手动土地写操作执行期间占住统一调度锁，避免与后台 Farm/Friend RPC 抢同一个游戏 WebSocket pending 队列。

UI 所有写操作都有二次确认；`一键铲除` 使用独立的危险操作文案。

## 紫土地边界

当前公开协议只有数值型：

```text
LandInfo.level
LandInfo.max_level
LandInfo.could_upgrade
LandInfo.lands_level
```

FAR2 旧 UI 已知：

```text
0 普通
1 黄土地
2 红土地
3 黑土地
4 金土地
```

后续更新日志声明加入了紫土地，但当前公开实现没有给出可靠的数值常量。

因此 P2A 只做：

- 土地卡片直接显示 `Lv<level>`；
- `level >= 5` 暂显示为紫土地视觉样式；
- **不修改** `fertilizer_land_types` 的正式持久化枚举；
- **不修改** 自动施肥里的 `getLandTypeByLevel()`。

等真实 Windows 农场页面出现 `Lv5` 土地后，再把 `purple` 作为正式自动施肥范围接入 P2B。

## 本地验收

先只做无副作用检查：

```powershell
pnpm land:controls-selftest
pnpm build:web
Restart-Service FAR2Farm
```

然后打开概览的土地详情：

1. 确认每块土地左上角能看到 `#landId · LvX`；
2. 有作物的主地块显示 `铲除 / 普肥 / 有机`；
3. `couldUpgrade=true` 的地块才显示 `升级土地`；
4. 合种副地不重复出现作物写操作；
5. 顶部新增 `一键铲除`，但首次 UI 验收不要点击；
6. 如果存在 `Lv5+`，截图确认它是否确实是当前游戏的紫土地。

UI 和 level 映射确认后，再选择一项成本/破坏可接受的单块写操作做真实 E2E；不需要为了验收直接执行一键铲除。

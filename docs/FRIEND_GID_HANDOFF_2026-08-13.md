# FAR2 QQ 好友完整导入 / GID 自动发现交接文档

日期：2026-08-13（UTC+8）
状态：**COMPLETED / ACCEPTED（当前单账号 Windows 运行范围）**
仓库：`xianyumht-cmd/far2`

> 本文是本轮“QQ 农场完整好友列表自动导入 → FAR2 好友巡查/偷菜使用”的正式交接文档。新对话继续时，优先级建议为：**当前源码 > 本文 > `docs/CODE_REFRESH_MILESTONE_2026-08-12.md` > 旧 `PROJECT_STATE.md`**。`PROJECT_STATE.md` 已知可能落后于当前里程碑，不要仅凭它判断现状。
>
> 文档内 QQ/UIN 只保留掩码，不记录完整号码。

---

## 1. 本轮目标

原问题：FAR2 QQ 好友列表长期只有约 19 个，直接限制好友巡查、帮助、偷菜；而真实 QQ 农场小程序里可以看到约 100 个好友。

最终目标：

1. 不再要求手工维护好友 GID。
2. Windows/FAR2 启动阶段自动打开 QQ 农场小程序。
3. 从小程序真实运行时采集完整好友关系数据。
4. 自动得到并持久化 GID / openId。
5. FAR2 Worker 自动使用这些数据执行 `SyncAll` / `GetGameFriends`。
6. 完整好友池实际参与帮助、巡查、偷菜。
7. 不破坏已经稳定的 CodeManager / event-only 后台运行架构。

---

## 2. 最终验收结果

### 2.1 小程序运行时采集成功

V4 实机日志：

```text
[FAR2 Friend Import] 好友采集完成 gids=103 openIds=275 methods=GetShareKey,SyncAll ...
[FAR2 Friend Import] capture ok gids=103 openIds=275 methods=GetShareKey,SyncAll
```

结论：

- 自动采集到 **103 个 GID**。
- 自动采集到 **275 个 openId**。
- 真实命中了 `FriendService.GetShareKey`、`FriendService.SyncAll` 等小程序协议。
- 用户肉眼看到的小程序好友约 100 人，103 GID 与实际规模吻合。
- `openIds=275` 不代表 275 个农场好友，它是上游关系数据集合；业务侧以有效 GID / `GetGameFriends` 返回为准。

### 2.2 Worker 已真正使用采集结果

实机日志：

```text
[好友] 已加载 QQ 小程序好友 openId：275 个，将用于 SyncAll
[好友] QQ 好友 GID 自动发现：新增 0 个，当前 103 个（SyncAll=103，GetAll=0）
```

这里 `新增 0 个` **不是失败**。原因是 103 个 GID 在启动导入阶段已经进入当前账号配置；随后 `SyncAll` 再次返回同一批好友，因此没有新增。

### 2.3 好友列表从 19 提升到 97 个有效好友

实机日志：

```text
[好友] 获取好友列表成功，共 97 位好友
```

此前稳定只有约 19 位；现在为 97 位当前有效/可访问好友。

103 GID 与 97 个最终有效好友不必严格 1:1。已观察到例如：

```text
[好友] 已将好友 Dot. 加入黑名单
[好友] 检测到封禁好友，已自动加入黑名单：Dot.
```

因此黑名单、失效关系、暂不可访问好友等会让最终 `GetGameFriends` 可用数略低于原始 GID 数。

### 2.4 偷菜/巡查业务链已实际使用新好友池

实机已经出现真实偷菜：

```text
[好友] 偷好友菜天：偷6（植物1029003/植物1021221）
[好友] 好友巡查循环巡查完成 → 偷6
```

以及大量帮助/巡查行为。因此不是“配置数字变大但业务没用”，而是完整好友池已进入实际操作链。

**最终判定：QQ 小程序完整好友自动导入 → GID 持久化 → Worker SyncAll → GetGameFriends → 帮助/巡查/偷菜，已打通并验收。**

---

## 3. 当前最终架构

```text
Windows 登录 / Code Agent 启动
        ↓
隐藏 Scheduled Task 运行 QQ Runtime Agent
        ↓
启动阶段临时注入 QQ 农场 game.js
        ↓
自动打开 QQ 农场小程序
        ↓
V4 监听真实 QQ/WX Socket / WebSocket / 结构化接口
        ↓
采集 GID + openId + FriendService 调用
        ↓
恢复原 game.js，退出临时采集
        ↓
写入 runtime-friend-gids-<uin>.json
        ↓
FAR2 主服务启动导入器读取
        ├─ 直接 GID → knownFriendGids 持久化
        └─ openId → runtime-friend-openids-<accountId>.json
        ↓
Worker 的 SyncAllRequest.create({ open_ids: [] })
由 proto bootstrap 自动注入本地采集 openId
        ↓
FriendService.SyncAll
        ↓
FriendService.GetGameFriends（按 GID 分批）
        ↓
当前有效好友列表
        ↓
帮助 / 巡查 / 偷菜
```

补充：如果采集结果在 Worker 已经运行之后才落盘，主服务会主动通知运行中的 Worker 强制重同步好友，不再要求用户重启账号。

---

## 4. 已完成代码改动

### 4.1 第一阶段：先修“已知 GID 池只能停在旧值”的问题

#### `core/src/services/interact.js`

关键改动：

- `getInteractRecords()` 在 QQ 环境下低频执行完整好友 GID 发现。
- 独立尝试 `FriendService.SyncAll(open_ids: [])` 与 `FriendService.GetAll`。
- 修复旧逻辑“SyncAll 请求成功但返回空，就不会继续 GetAll”的早退问题。
- 合并/去重已知 GID。
- Worker 内存配置立即更新。
- 通过 IPC 向主进程发送 `known_friend_gids_sync`。
- 首次发现无论是否新增都记录：
  `QQ 好友 GID 自动发现：新增 X 个，当前 Y 个 (SyncAll=A, GetAll=B)`。

相关提交：

- `d127105128bc85dde897a42da6aef17c1079bf82` — `fix: auto-discover QQ friend GIDs from full friend APIs`
- `638d63f32f78cb7098a483c4d845ef096dd9eb67` — `chore: log first QQ friend discovery result`

实机曾从 19 自动增加到 20，证明基础自动新增链有效，但旧服务器接口仍无法得到完整约 100 人好友池。

### 4.2 修复 GID 持久化 IPC

#### `core/src/runtime/worker-manager.js`

发现一个真实 bug：`friend.js` 早已有：

- `known_friend_gids_sync`
- `known_friend_gid_remove`

但主进程 `worker-manager.js` 当时根本没有处理这两个 IPC。

修复后：

- `known_friend_gids_sync` → `setKnownFriendGids(accountId, normalized)` 持久化主 store + GID cache。
- `known_friend_gid_remove` → 主 store 持久化删除。
- 保存后向 Worker 回发最新 config。
- 抽取 `syncConfigToWorker(accountId)` 复用。

提交：

- `9f09f36e193ed71392b4ad5a6699958ba5f9d3b9` — `fix: persist discovered QQ friend GIDs from workers`

这个修复也解决了之前“Worker 内存里发现了好友，但重启后又退回旧 GID”的隐患。

### 4.3 启动阶段 QQ 小程序好友采集基础链

初始实现：

- `core/src/services/windows-runtime-friends.js`
- `core/src/services/startup-runtime-friend-import.js`
- `core/scripts/qq-isolated-code-agent.js`
- `core/src/services/windows-runtime-code.js` 暴露小程序启动器
- `core/src/runtime/runtime-engine.js` 接入启动导入

相关提交：

- `0ab6404f34baa5ce642c75d218b2ac48177a51fd` — `feat: capture QQ Farm friend gids from desktop runtime`
- `fec9b64341b169d19ee329cf14a78bbbd539f816` — `refactor: expose QQ Farm miniapp launcher`
- `31b69bddbf1b266017a3ad7ff4808edbbe87f624` — `feat: capture QQ Farm friends once per Windows boot`
- `2c9a94a54f93cbb7c7154b886a9df08797a67c8a` — `feat: import startup QQ runtime friend gids into FAR2`
- `f46decdc57b394a6ca856f9147c47a3eb47a6374` — `feat: import QQ runtime friend gids on FAR2 startup`
- `3c5e80b3876610c401c348ccdaee34b3618ff5d7` — `fix: decode plaintext QQ Farm friend responses first`

协议确认：当前 FAR2 服务端响应 `msg.body` 优先按明文 protobuf 解码；decrypt 只保留 fallback。不要再默认“响应 body 必须先解密”。

### 4.4 V1 / V2 / V3 诊断增强

提交：

- `c900ae6c9017e33c9149703bef13db138a66aee9` — 扩大 QQ 农场启动好友采集范围
- `9cf546f20cfa6f9021bfafff2cb223fb3b62e063` — 延长 QQ runtime bootstrap 等待
- `64feceb780737e854209410a6abdda945b56f841` — 同时采集 GID + openId
- `6819cd17136d6fa0ac685ae146921f647978daac` — Agent 持久化 openId
- `d29d5b22b4b9dbcb829a9d626df92573054a50f7` — 主服务按账号保存 openId
- `af023679877959e4cfa88f4ac1685093625f0594` — `SyncAll` 自动注入采集 openId
- `e3c3ba5b4fccfdfc385e81289f7117210e600968` — 采集结果晚到时主动重同步运行中的 Worker
- `be10811b37b24e76000f198711bc955cdcd0acad` — V3 等待可写 runtime API
- `cd182af076d835d1b2414c1ac2a970a22fb8e7c8` — Agent 切到 V3

### 4.5 最终 V4

#### `core/src/services/windows-runtime-friends-v4.js`

V4 的关键点：

- 第一条 ready 文件改用 **已被 Code 自动刷新真实验证成功的 `writeFileSync()`**。
- 不再把 `appendFileSync()` 作为“监听器是否能安装”的前置条件。
- 后续追加不可用时可回退整文件重写。
- 等待 QQ/WX API 真正可用后再建立 sink。
- 继续捕获：
  - QQ/WX `connectSocket`
  - `onSocketMessage`
  - WebSocket
  - `request`
  - `getPotentialFriendList`
  - `getFriendCloudStorage`
  - `getGroupCloudStorage`
  - `getUserCloudStorage`
  - FriendService Gate 帧
  - `SyncAll` 请求中的 openId
  - FriendService 响应中的 GID

提交：

- `1707243ff9f01bb6834c1d997f053e7e77244f44` — `fix: use proven QQ runtime file writer for friend capture`
- `c942ce75acb61f20b5dc82bb6e49815cd360c196` — `fix: switch startup friend capture to V4 writer`

V4 是当前**唯一已通过真实环境验收的完整启动好友采集版本**。

---

## 5. 失败方案、原因及不要重复的路线

### 5.1 只依赖旧 `SyncAll(open_ids: [])` / `GetAll`

现象：

```text
QQ 好友 GID 自动发现：当前 20 个（SyncAll=1, GetAll=0）
```

原因：腾讯当前 QQ 农场的完整好友关系不是靠空 `open_ids` 的旧接口自动给全量；真实小程序会携带自己的关系数据/上游 openId。

**不要再把 `SyncAll(open_ids: []) + GetAll` 当完整好友解决方案。** 它可以做 fallback/补充，但不能替代小程序真实采集。

### 5.2 V1：只监听明显 FriendService 帧

结果：`friend_capture_timeout`。

问题：过滤太早、监听层范围太窄，且无法区分“脚本没执行”和“接口没命中”。

不要回退 V1。

### 5.3 V2：扩大到 qq + wx + WebSocket / 全帧诊断

结果反复：

```text
frames=0 observed=- hooks=-
friend_capture_timeout
```

说明不是 protobuf 解析失败，而是 runtime hook 根本没有真正建立。

不要继续调 V2 的协议解析。

### 5.4 V3：等待 API 可写后再 hook

仍然：

```text
frames=0 observed=- hooks=-
```

最终发现 V3 第一条 ready 日志使用 `appendFileSync()`；而成功的 Code 运行时注入一直使用 `writeFileSync()`。在 QQ 小程序当前 FileSystemManager 环境里，`appendFileSync` 不能作为可靠初始化前提。

不要再测试 V3，也不要把 `appendFileSync` 恢复成安装前置条件。

### 5.5 不要再走人工好友页/OCR/UI 点击路线

当前 V4 已实现**启动时零人工采集**。不要重新改成：

- OCR 好友昵称/页面；
- 鼠标自动点击好友页；
- 用户每次手工打开好友列表；
- 手工逐条录 GID。

这些都比已验收的 runtime 协议采集脆弱。

### 5.6 不要动已经稳定的 CodeManager / 后台架构

好友功能是在现有稳定 Code Runtime 之上实现的。不要为了好友列表重新做：

- QR 登录实验；
- Ctrl+R 目标窗口实验；
- renderer restart / kill 实验；
- 多账号共用机器级 `tencent://` fallback；
- PID/窗口顺序猜测；
- 注入/IPC/Frida/cookie 提取方案。

这些路线此前已被排除，当前任务没有理由重开。

### 5.7 一次性 GitHub Actions 方案已废弃

曾短暂创建 one-off workflow 试图绕开大文件编辑；Actions 没有产生有效工作流/运行，因此删除。

删除提交：

- `9becf4c2276e781bc6bb2ffc3a292eb18bfa1133` — `chore: remove unused one-off friend gid workflow`

不要再依赖该 workflow；最终好友修复全部是直接源代码提交。

---

## 6. 当前 Windows 环境与运行状态

当前验收环境：

- 本地仓库：`D:\project2\far2-test`
- Node：`D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe`
- NSSM：`D:\Program Files\nssm-2.24\nssm.exe`
- FAR2 主服务：`FAR2Farm`
  - 状态：Running
  - Startup：Automatic
  - 运行身份：LocalSystem
- Code Agent：隐藏 Scheduled Task，AtLogOn
  - QQ：`23****72`
  - Agent：`127.0.0.1:43101`
  - 必须运行在交互式 Windows Session，不能放 Session 0
- WebUI：`http://127.0.0.1:3007`
- 刷新模式：**event-only**
  - WS400 / kickout / manual 才刷新 Code
  - healthy periodic QQ Farm re-login 已关闭
- 账号：名称 `232`，account ID `2`
- 当前 known friend GID：**103**
- 当前 `GetGameFriends` 实际有效列表：**97**
- 当前采集 openId：**275**

注意：Agent 日志中部分中文仍可能因 Windows 编码显示乱码，这是**日志显示层问题**，不是当前好友功能故障。

---

## 7. 与 Code 自动刷新里程碑的关系

CodeManager / Windows 后台运行此前已经单独验收，相关正式文档：

- `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`

完成提交：

- `4cf06d28ee483a4d1c189c749d88b502ca74b52f` — Code refresh 单账号 Windows 后台里程碑完成文档

Proto 启动竞态修复：

- `7b1c99e8a3bb36057187dfb076243e2bc04d5a70`

好友任务**不要修改/回滚**上述稳定架构。

---

## 8. 已验证 vs 尚未验证

### 已验证

- 普通服务端好友 GID 自动补充能从 19 增到 20。
- Worker → master 的 GID 持久化 IPC 正常。
- V4 自动打开 QQ 农场并执行 runtime 采集。
- V4 真实采集到 103 GID / 275 openId。
- FAR2 Worker 能加载 275 openId 用于 SyncAll。
- SyncAll 返回 103。
- knownFriendGids 当前为 103。
- `GetGameFriends` 当前得到 97 位有效好友。
- 新好友池实际进入帮忙/巡查/偷菜。
- 封禁好友可自动加入黑名单。
- 无需手工打开好友页面。
- 无需人工维护 GID。

### 尚未做的非阻塞验证

**V4 完成之后，还没有专门为了验收执行一次完整 Windows 冷启动/重启机器测试。**

当前代码和安装结构已经是：AtLogOn Agent + once-per-Windows-boot 好友采集 + FAR2 自动导入；逻辑链完整，但本轮没有要求用户为此重启机器。

因此：

- “完整好友采集/导入/偷菜功能” = **已验收**。
- “V4 后从真正 Windows 冷启动开始完全无人值守再跑一遍” = **可选后续验收，不是当前 blocker**。

若以后正常重启电脑时自然观察即可，不需要现在专门重启。

---

## 9. 当前源码基线

本交接文档创建前的功能代码 HEAD：

```text
c942ce75acb61f20b5dc82bb6e49815cd360c196
fix: switch startup friend capture to V4 writer
```

关键当前文件：

- `core/src/services/windows-runtime-friends-v4.js` — **当前已验收小程序好友采集器**
- `core/scripts/qq-isolated-code-agent.js` — 启动阶段调用 V4 并保存采集 artifact
- `core/src/services/startup-runtime-friend-import.js` — 主服务读取 artifact、保存 GID/openId、必要时通知运行中 Worker 重同步
- `core/src/utils/proto.js` — `SyncAllRequest.create()` bootstrap，空 `open_ids` 时加载按账号保存的小程序 openId
- `core/src/services/interact.js` — 低频服务器侧 GID 自动补充/fallback
- `core/src/services/friend.js` — known GID → `GetGameFriends` → 帮助/巡查/偷菜
- `core/src/runtime/worker-manager.js` — GID sync/remove IPC 主进程持久化

V1/V2/V3 文件可能仍保留在仓库作为历史实现。**当前不要切回它们，也不要在功能稳定阶段急着删除。** 若以后整理代码，应先有稳定运行观察，再单独做 cleanup 提交。

---

## 10. 当前未完成问题

本轮核心好友任务没有 blocker，已完成。

剩余只属于后续/可选项：

1. **自然冷启动验收**：以后用户正常重启 Windows 时确认 V4 自动再次得到约 100 GID，不需要现在人为重启。
2. **103 vs 97 的长期变化观察**：当前差异合理，不要主动当 bug。只有未来稳定长期明显缺少大量真实好友时再调查失效/黑名单/权限过滤。
3. **旧 V1/V2/V3 cleanup**：低优先级；当前稳定后再做，不要边运行边清。
4. **Agent 中文日志乱码**：纯体验问题，低优先级。
5. **新项目功能**：用户认为后续版本很多功能偏花哨，优先继续做真正影响农场核心收益/自动化的功能，不要为了追更新日志全量照搬。

---

## 11. 下一对话建议起点

新对话第一步建议：

1. 阅读本文：`docs/FRIEND_GID_HANDOFF_2026-08-13.md`。
2. 阅读：`docs/CODE_REFRESH_MILESTONE_2026-08-12.md`。
3. 以 GitHub `main` 当前源码为最终事实来源。
4. 不要仅依赖旧 `PROJECT_STATE.md`。
5. 将好友任务视为 **COMPLETED / ACCEPTED**，除非出现新的真实回归日志。
6. 不要重新要求用户测试 V1/V2/V3，也不要重复人工好友页方案。
7. 如果用户正常重启 Windows 后顺手提供日志，可做一次冷启动自然验收；否则无需阻塞下一功能。
8. 下一功能应重新由用户指定；若继续农场核心，应优先收益/数据完整性类功能，而不是装扮、头像框等低价值功能。

推荐新对话开场：

```text
查看 docs/FRIEND_GID_HANDOFF_2026-08-13.md、docs/CODE_REFRESH_MILESTONE_2026-08-12.md 和当前 main 源码，继续 FAR2。好友完整导入已经验收，不要重做旧方案。
```

---

## 12. 最终里程碑结论

**QQ 好友完整自动导入：COMPLETED / ACCEPTED。**

已从：

```text
旧 known GID ≈ 19
GetGameFriends ≈ 19
```

升级到：

```text
QQ 小程序 V4 runtime capture
→ GID 103
→ openId 275
→ SyncAll 103
→ 当前有效好友 97
→ 实际帮助 / 巡查 / 偷菜
```

后续不要再围绕“为什么只有 19 个好友”继续排查，除非未来出现明确回归证据。

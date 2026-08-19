# FAR2 Windows 微信农场生产链完整交接 — 2026-08-20

> 交接时间：2026-08-20 00:35 +08:00  
> 仓库：`xianyumht-cmd/far2`  
> 当前微信最终合并候选分支：`feature/windows-wechat-production-20260819`  
> 当前候选 PR：#56 `Windows 微信 Resident Agent 生产支持（精简合并）`，Ready / Open / 未合并  
> 本文写入前最新功能代码提交：`41802b791e2e55c9ecea0d41e4779a906c50d04a` (`fix(wechat): cache Windows session lookup`)  
> 当前 `main` 已验证基线：`ae496dac3d96560f728396524f8761fa0d85f8c9`（PR #57 合并提交）  
> 真实生产目录：`D:\project2\far2-test`  
> 干净 main 镜像：`D:\project2\far2-main-sync`  
> 历史微信探针工作树：`D:\project2\far2-wechat-probe`  
> 本文 **取代** `docs/WECHAT_WINDOWS_PRODUCTION_HANDOFF_2026-08-19.md` 作为后续继续操作时的最新交接入口；旧文档保留历史过程，不删除。

---

## 1. 当前总状态

Windows 桌面微信版 QQ经典农场已经接入 FAR2 的真实生产链，以下关键链路已经完成并通过真实环境验证：

- Windows 微信 / WMPF exact farm runtime 识别；
- exact appId `wx5306c5978fdb76e4`；
- FAR2-native Resident Agent；
- authenticated loopback fresh Code Provider；
- `wx.login` fresh Code；
- 官方 Gateway / `platform=wx` 登录；
- `ws_400` / 有效 kickout 后 scoped fresh Code 恢复；
- FAR2Farm 重启后的 `startup_recover`；
- WebUI “使用当前已登录微信” 主路径；
- Windows 登录后的 Resident Agent 隐藏自启动；
- 微信 Code 从周期刷新改为 `on_invalid`；
- 农场窗口隐藏 / 高频窗口扫描功能已经从 `main` 删除并部署到本机；
- 微信 Resident Agent 高频 `powershell.exe` SessionId 查询已经定位、修复并实机验证为 0 次重复创建。

当前生产应按以下模型理解：

```text
Windows 登录
  -> FAR2 WeChat Resident Agent 计划任务隐藏启动
  -> Resident 进程首次查询一次 Windows SessionId 并缓存
  -> 用户手动打开一次微信里的 QQ经典农场
  -> exact WMPF farm runtime bootstrap
  -> Resident Provider 127.0.0.1:43201 ready
  -> FAR2 微信 Worker 可用
  -> 正常挂机不按时间 fresh Code
  -> ws_400 / 有效 kickout / startup_recover / web_enroll / manual 时按需 fresh Code
```

**当前仍不是完全无人值守冷启动。** Windows 重启后，用户仍需要手动打开一次微信中的 QQ经典农场，让 exact WMPF runtime 完成 bootstrap。不要把 Resident Agent 自动启动误写成农场小程序自动启动。

---

## 2. 当前 Git / PR / 提交状态

### 2.1 `main`

当前已验证 `main`：

`ae496dac3d96560f728396524f8761fa0d85f8c9`

这是 PR #57 的 merge commit：

`refactor(windows): 删除农场窗口隐藏功能`

PR #57 已于 2026-08-19 合并。

它删除了旧 `farm-window-cloak` / window-control 整套功能，并保留：

- QQ isolated Code Agent；
- UIN / Windows Session 防串号；
- Code Provider token/target；
- `ws_400` / kickout / manual 刷新；
- 事件驱动刷新策略；
- Code Agent 自己的隐藏控制台。

### 2.2 微信最终候选 PR #56

分支：

`feature/windows-wechat-production-20260819`

本文写入前最新功能提交：

`41802b791e2e55c9ecea0d41e4779a906c50d04a`

提交信息：

`fix(wechat): cache Windows session lookup`

改动文件：

`core/src/services/wechat-wmpf-resident-capture.js`

该提交在原有 `getWindowsSessionId()` 上新增：

- 成功 SessionId 进程生命周期缓存；
- 首次失败时 60 秒节流重试；
- 不再让每次 `getStatus()` 都同步启动一个 PowerShell。

PR #56 当前仍 **Open / Ready / 未合并**。不要自动 merge，除非后续得到明确合并指令并完成合并前剩余审计。

### 2.3 生产工作树

生产根目录：

`D:\project2\far2-test`

生产 Git HEAD 仍保持：

`d4c419246f0891d535280839317e694a049a71a3`

生产工作树仍是 **tracked dirty**，包含重要本地/生产运行态变更。

**绝对禁止：**

- `git clean`
- `git reset --hard`
- 对 `D:\project2\far2-test` 直接 checkout 覆盖
- 为了“和 main 一样”做 blanket overwrite
- 未审计的全仓 merge

### 2.4 干净 main 镜像

已经创建：

`D:\project2\far2-main-sync`

2026-08-19 23:55 左右实测：

`HEAD = ae496dac3d96560f728396524f8761fa0d85f8c9`

这个目录用于精确同步 `origin/main`，可以安全使用 `checkout/reset --hard/clean`；**这些操作仅允许用于这个专用干净镜像，不允许复制到生产 dirty worktree。**

---

## 3. 当前生产环境

### Windows / 运行工具

- Windows 10
- 当前桌面用户：`Administrator`
- PowerShell 7：`7.6.4`
- Windows PowerShell 5.1 仍存在并被部分计划任务/子进程使用
- Node：`D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe`
- FAR2Farm Windows Service：`FAR2Farm`
- FAR2Farm 由 NSSM 承载

### 账号状态

- QQ：2 个
- 微信：1 个
- 微信生产 account id：`3`
- 显示名：`微信农场`

### 微信运行时基线

- Windows 微信：`4.1.12.26`
- exact appId：`wx5306c5978fdb76e4`
- WMPF：`25297`
- clientVersion：`1.13.2.7`
- gatewayVersion：`1.13.2.7_20260723`
- Gateway：`wss://gate-obt.nqf.qq.com/prod/ws`
- `platform=wx`
- `os=Windows`
- Origin：`https://gate-obt.nqf.qq.com`

raw `wx.login` Code 是敏感一次性凭证：不能打印到日志、Git、命令行、报告或交接文档。

---

## 4. Resident Agent 当前生产状态

### 计划任务

任务：

`FAR2 WeChat Resident Agent`

执行：

`C:\Program Files\PowerShell\7\pwsh.exe`

runner：

`C:\Users\Administrator\AppData\Local\FAR2\wechat-agent\runtime\scripts\windows\run-wechat-resident-agent-autostart.ps1`

实际 Resident Node：

`C:\Users\Administrator\AppData\Local\FAR2\wechat-agent\runtime\core\scripts\wechat-resident-agent.js`

Provider endpoint：

`127.0.0.1:43201`

当前运行模式：Interactive Logon + Highest + Hidden runner。

### 冷启动限制

正常 Windows 重启后：

1. Agent 计划任务自动启动；
2. 微信需要已经登录；
3. 用户仍要手动打开一次 QQ经典农场；
4. exact WMPF runtime 出现后 Agent 才进入 `resident_connected`；
5. 然后 FAR2 微信 Worker 才能在需要时 fresh Code。

**未实现：** 自动导航/自动打开微信中的 QQ经典农场。

---

## 5. Code 刷新策略：最终生产规则

文件：

`core/src/services/wechat-recovery-manager.js`

策略：

`REFRESH_POLICY = 'on_invalid'`

### 正常在线

- `refreshIntervalMs = 0`
- 不再每 3 分钟 fresh Code
- 不再周期性替换微信 Worker

### 自动 fresh Code 触发

- `ws_400`
- 非版本过低类 `kickout_stop`
- FAR2Farm 启动/重启后的 `startup_recover`

### 显式触发

- `web_enroll`
- manual refresh

### Provider 暂不可用

只有在已经存在有效触发事件之后，Provider 不可用才进入 retry；retry 约 30 秒，不是周期性 Code 保鲜。

### 为什么 `startup_recover` 必须保留

`wx.login` Code 是一次性凭证。曾尝试服务重启后直接复用 accounts 中已有 Code，真实生产恢复失败。因此：

- 进程启动时 fresh 一次，用于重建会话；
- 稳定运行后才是纯事件驱动。

不要再尝试删除 `startup_recover`。

---

## 6. 农场窗口隐藏功能：已彻底退出生产路线

旧方案使用：

`scripts/windows/farm-window-cloak.ps1`

其默认约 60ms 高频扫描 QQ 进程/窗口，并把农场窗口移出屏幕，造成明显 PowerShell CPU 尖峰。

随着 Code 已改成 `on_invalid`，继续隐藏农场窗口没有价值，因此已通过 PR #57 删除。

已删除：

- `core/scripts/farm-window-control-selftest.js`
- `core/src/services/farm-window-control.js`
- `scripts/windows/farm-window-cloak.ps1`
- `web/src/views/FarmWindowControl.vue`

并修改：

- `core/src/controllers/code-manager-api.js`
- `docs/WINDOWS_AUTOSTART.md`
- `scripts/windows/run-code-agent-hidden.ps1`
- `web/src/router/menu.ts`

当前规则：

- 农场窗口正常显示；
- 不移动、不最小化、不隐藏；
- Code Agent 控制台仍隐藏；
- 不恢复 `farm-window-cloak`。

**不要重复实现农场窗口隐藏。**

---

## 7. 本次 main 同步 / 本地部署过程

目标：

- 本地拥有精确 `origin/main` 镜像；
- 同时不破坏 tracked-dirty 的生产目录；
- 将 PR #57 的“删除农场窗口隐藏功能”安全部署到生产。

最终设计：

- `D:\project2\far2-main-sync`：精确同步 main；
- `D:\project2\far2-test`：只做语义/选择性部署，保留 Git HEAD 和本地修改。

### 最终成功版本：v7

v7 完成：

- clean main sync PASS；
- production HEAD 保持 `d4c419...`；
- semantic remove window-control API；
- 删除旧 4 个窗口控制文件；
- WebUI staging build PASS；
- 旧 cloak 进程结束；
- 原运行 CodeAgent 任务恢复；
- FAR2Farm 若部署前运行则恢复运行；
- 生产未做 reset/checkout/clean。

部署备份：

`C:\Users\Administrator\AppData\Local\FAR2\deploy-backup\20260819-235559`

### 不要重复的失败版本

#### v1 / v2：CMD/UAC 启动器失败

现象：

- CMD 中文乱码；
- `ho` / `CVBS` / `runas` 片段被拆成命令；
- 窗口闪退或错误解析。

原因：批处理编码、VBS/UAC 引号组合不可靠。

结论：不要再使用 v1/v2。

#### v3：删除文件安全检查过严

停止于：

`core/scripts/farm-window-control-selftest.js`

原因：生产中该待删除文件有本地修改；v3 对所有本地修改都 fail-closed。

结果：生产未修改。

结论：对已明确退休的 window-control 文件，正确策略是备份后删除，而不是永久阻塞。

#### v4：`code-manager-api.js` 三方 merge 冲突

原因：生产 `code-manager-api.js` 有真实本地改动，同时 main #57 也修改该文件。

结果：生产未修改。

结论：不能整文件三方覆盖；必须语义删除 window-control 相关块。

#### v5：PowerShell RegexOptions 解析 bug

报错：

`System.Object[] does not contain a method named 'op_BitwiseOr'`

原因：`New-Object Regex` + enum `-bor` 参数解析不兼容。

结果：`mutationStarted=false`，生产未修改。

结论：改成正则 `(?ms)` 内联 flag + `[Regex]::new(...)`。

#### v6：WebUI staging 缺少同级 `core/package.json`

报错：

`ENOENT ...\core\package.json`

原因：`web/vite.config.ts` 会读取 `../core/package.json`，旧 staging 只复制了 `web`。

结果：发生在 mutation 前，生产未修改。

结论：隔离构建必须保留仓库相对布局，至少提供 stage sibling `core/package.json`。

#### v7：成功

v7 修复 staging 布局后完成部署。当前不需要再次运行 v1-v7 任一脚本，除非以后明确要重做 #57 controlled deploy。

---

## 8. PowerShell 高频 CPU 调查与最终修复

### 8.1 现场现象

删除旧 cloak 后，任务管理器仍偶尔/频繁看到一个 Windows PowerShell 瞬时占用较高 CPU。

最初看起来像“以前两个，现在还剩一个”。

### 8.2 诊断 v1 失败

诊断脚本使用 `$pid` 保存进程 ID。

PowerShell 变量名不区分大小写，`$PID` 是系统只读自动变量，因此报错：

`Cannot overwrite variable PID because it is read-only or constant.`

结论：诊断 v1 不要重跑。

### 8.3 诊断 v2：确认不是长期 runner 在吃 CPU

12 秒观察中：

- QQ CodeAgent runner PowerShell：长期存在，但约 0% CPU；
- WeChat Resident runner `pwsh`：长期存在，但约 0% CPU；
- 旧 cloak：`False`；
- 真正高频的是短命 PowerShell 子进程。

主要短命命令：

`(Get-Process -Id $PID).SessionId`

父进程：Node。

### 8.4 诊断 v3：根因完全定位

15 秒数据：

#### 高频组

- Kind：`SESSION_ID_QUERY`
- Parent PID：`12832`
- Parent：Resident Agent Node
- CommandLine：`wechat-resident-agent.js`
- 15 秒内不同 PowerShell PID：`8`
- 约：`0.53/sec`

父链：

```text
FAR2 WeChat Resident Agent scheduled task
 -> pwsh.exe PID 12104
 -> node.exe PID 12832
 -> powershell.exe
 -> (Get-Process -Id $PID).SessionId
```

根因文件：

`core/src/services/wechat-wmpf-resident-capture.js`

旧实现：`getStatus()` 每次返回 `windowsSessionId: getWindowsSessionId()`，而 `getWindowsSessionId()` 每次都 `spawnSync('powershell.exe', ...)`。

#### 次要组

- Kind：`PROCESS_SNAPSHOT_QUERY`
- Parent PID：`7820`
- Parent：FAR2 主 `node.exe client.js`
- 15 秒不同 PowerShell PID：`2`
- 约：`0.13/sec`
- 命令：`Get-CimInstance Win32_Process ... ConvertTo-Json`

对应生产源码主要落在：

`core/src/services/desktop-session-registry.js`

这条是 QQ / Session identity 成熟链的一部分，本次 **没有修改**。

### 8.5 代码修复

PR #56 新增提交：

`41802b791e2e55c9ecea0d41e4779a906c50d04a`

`fix(wechat): cache Windows session lookup`

规则：

- Resident Agent 生命周期内 Windows SessionId 不会变化；
- 第一次成功查询后永久缓存到当前 Resident 进程；
- 后续 status polling 不再启动 PowerShell；
- 如果首次查询失败，最多 60 秒后才重试一次，不在每次 status 调用中重试。

### 8.6 真实生产 runtime 修复

实际运行文件：

`C:\Users\Administrator\AppData\Local\FAR2\wechat-agent\runtime\core\src\services\wechat-wmpf-resident-capture.js`

注意：当时检查发现下面这个生产源码路径不存在：

`D:\project2\far2-test\core\src\services\wechat-wmpf-resident-capture.js`

因此一键修复只 patch 了实际 `%LOCALAPPDATA%` runtime；仓库对应正式源码已通过 PR #56 提交修复。

执行结果：

- runtime file PATCHED；
- Node `--check` PASS；
- `FAR2 WeChat Resident Agent` 任务重启 PASS；
- `127.0.0.1:43201` reachable；
- 修复后 12 秒 `SESSION_ID_QUERY unique spawns: 0`；
- `RESULT: FIX APPLIED`。

报告：

`C:\Users\Administrator\AppData\Local\Temp\FAR2-WeChat-Session-Cache-Fix-20260820-003044.txt`

备份：

`C:\Users\Administrator\AppData\Local\FAR2\wechat-session-cache-fix-backup\20260820-003044`

### 8.7 重启后的预期行为

下次 Windows 重启后新的 Resident 进程会：

1. 启动；
2. 第一次需要 SessionId 时短暂启动一次 PowerShell；
3. 成功后缓存；
4. 后续不再重复启动该 SessionId PowerShell。

所以重启后 **偶尔一次** `powershell.exe` 是正常的；每几秒不断出现是不正常的。

正常重启不会丢失当前 runtime patch。

**但旧版 Resident Agent 安装/修复脚本如果重新覆盖 `%LOCALAPPDATA%\FAR2\wechat-agent\runtime`，可能把本地 runtime 回滚到旧实现。不要运行旧安装包覆盖当前 runtime。**

---

## 9. 当前仍保留的 PowerShell / 不要误杀

### QQ CodeAgent runner

计划任务：

`FAR2CodeAgent-2320006072`

长期 PowerShell runner：正常。

诊断时 CPU 约 0%。

它的隐藏是“控制台隐藏”，不是农场窗口隐藏，不要删除。

### WeChat Resident runner

计划任务：

`FAR2 WeChat Resident Agent`

长期 `pwsh.exe` runner：正常。

诊断时 CPU 约 0%。

### FAR2 主进程的 PROCESS_SNAPSHOT_QUERY

FAR2 主 `client.js` 仍会偶尔通过 `desktop-session-registry.js` 启动 PowerShell 做完整 Windows 进程快照。

15 秒观察 2 次，频率远低于已修复的 Resident SessionId 查询。

当前把它列为 **后续性能优化候选**，不要在没有 QQ 回归测试的情况下直接删除，因为它参与 QQ/UIN/Session identity 安全边界。

---

## 10. 已完成且不要重复的微信路线

除非出现新的直接证据，否则以下阶段不要重跑：

- P0-P6 Windows 微信/WMPF识别、AppId、fresh Code、Gateway、真实登录；
- P7R Resident scoped recovery；
- P8 isolated stage real recovery；
- P8 controlled production runtime apply；
- P8 final production account gate；
- WebUI Resident 主路径 closeout；
- on-invalid refresh policy controlled apply；
- Resident Agent Interactive + Highest 自启动修复；
- 农场窗口 cloak 删除；
- Resident SessionId PowerShell 高频修复。

历史探针、实验 handshake、network arm、learner、P0-P8 一次性证据脚本继续留在 #55 / `feature/windows-wechat-probe-20260819`，不要重新搬进最终生产 PR #56。

---

## 11. 明确失败/不要重复的技术路线

1. **不要恢复“每 3 分钟 fresh Code”**：已经证明不需要，且增加窗口/会话扰动。
2. **不要删除 `startup_recover`**：一次性 Code 无法可靠跨 FAR2Farm 新进程再次消费。
3. **不要恢复 `farm-window-cloak.ps1`**：高频窗口扫描导致 CPU 尖峰，功能已被 PR #57 正式退休。
4. **不要为了隐藏 Code Agent 黑窗而重新隐藏农场窗口**：两者不是同一件事。
5. **不要直接三方覆盖生产 `code-manager-api.js` / WebUI 长期修改文件**：生产 tracked dirty，需要语义 overlay。
6. **不要在隔离 WebUI build 时只复制 `web/`**：`vite.config.ts` 依赖 sibling `core/package.json`。
7. **不要直接 reset/clean `D:\project2\far2-test`**。
8. **不要重新运行旧 Resident 安装包覆盖当前 `%LOCALAPPDATA%` runtime**，除非确认其中已包含 `41802b...` SessionId cache 修复。
9. **不要杀 `Weixin.exe`** 作为恢复手段。
10. **不要在日志/报告中打印 raw `wx.login` Code 或 Provider token**。
11. **不要把 #55 当最终 main 合并候选**；最终候选仍是精简 PR #56。

---

## 12. PR #56 当前未完成 / 未解决问题

截至本文写入时，PR #56 仍有 4 个未解决 Codex review thread。合并前应逐项处理或给出明确理由：

### P1：AccountModal 在 backend provider 未配置时仍可显示 Resident enrollment

文件：

`web/src/components/AccountModal.vue`

风险：非 Windows 或未配置微信 Provider 时，UI 可能先保存一个 `platform=wx`、无 Code 的不可用账号，再在后续 config 调用失败。

建议：

- UI 根据 backend capability 隐藏/禁用 enrollment；或
- 把 enrollment 改成 backend 原子操作，在创建账号前 fail-closed。

### P2：`wechat-code-agent.js` 全局 `refreshInFlight` 可能跨微信账号共享一次性 Code

风险：多个微信账号并发 refresh 时可能拿到同一个 single-use Code。

当前生产只有 1 个 wx 账号，因此现场未触发，但合并代码应修：

- 同账号 dedupe；或
- capture 串行化，但每个 account 请求生成独立 fresh Code。

### P1：Resident hook 只 attach 一次，正常登录时序可能先于 WMPF host

文件：

`core/src/services/wechat-wmpf-resident-capture.js`

风险：计划任务登录时启动，如果 WMPF host 尚未存在，`attachHook()` 一次失败后 Agent 可能退出；后续用户打开农场也不会自动恢复。

现场通过 Interactive + Highest 和当前登录顺序验证了可用，但代码层仍应加强：

- keep resident alive；
- host missing 时重试 attach；
- WMPF host 被替换时支持 reattach。

### P2：IPv6 loopback `::1` URL 构造未加方括号

文件：

`core/src/services/wechat-code-agent.js`

`http://::1:43201` 无效。

若继续声称支持 IPv6 loopback，应构造成：

`http://[::1]:43201`

或者明确只允许 IPv4 `127.0.0.1`。

---

## 13. 当前未完成问题

按优先级：

### A. PR #56 合并前收口

- 处理上面 4 个未解决 review thread；
- 将 PR #56 rebase/update 到当前 main（main 已包含 PR #57）；
- 确认更新后不会把 farm-window cloak/window-control 带回来；
- 重新检查 23 文件最终 diff；
- 对 QQ 路径做最小回归；
- 对微信 Resident / Code / startup_recover 做最小回归；
- 然后等待明确 merge 指令。

### B. 完全无人值守冷启动

仍未实现 Windows 重启后自动打开微信 QQ经典农场。

当前用户仍需要手动打开一次农场。

若后续实现，必须独立设计/验证，不要声称现有 Resident task 已完成这个能力。

### C. FAR2 主进程低频 `PROCESS_SNAPSHOT_QUERY` 优化

当前约 0.13/sec 的 PowerShell 进程快照仍存在。

如果用户继续看到 PowerShell 偶尔闪现，可下一步专门优化：

`core/src/services/desktop-session-registry.js`

但这是 QQ/Session identity 安全相关代码，必须先建立行为测试和缓存策略，再改，不要像 cloak 一样直接删除。

### D. 生产与仓库最终收敛

当前实际运行微信 runtime 已 patch，但 `D:\project2\far2-test` Git HEAD 仍旧，且对应 `wechat-wmpf-resident-capture.js` 在该生产源码路径当时不存在。

最终正确收敛应是：

1. PR #56 完成 review 修复；
2. 明确 merge 到 main；
3. main 包含 `41802b...` 等最终微信文件；
4. 使用受控 deploy 把最终 main 微信代码部署到生产；
5. 不 reset tracked-dirty 生产仓库；
6. 验证 runtime installer 不会覆盖回旧 SessionId 实现。

---

## 14. 下一次继续操作时的建议顺序

1. **先查 PR #56 当前 HEAD / 与 main 的 behind/ahead / review threads**，不要直接 merge。
2. 优先修 P1 Resident hook retry/reattach，因为它直接影响重启可靠性。
3. 修 P1 AccountModal backend capability，避免创建不可用 wx 账号。
4. 修 P2 per-account fresh Code 并发隔离。
5. 修/收窄 IPv6 loopback 支持。
6. 对 PR #56 更新到最新 main，重点确认 PR #57 的“无农场窗口隐藏”不会被分支旧代码覆盖。
7. 做最小真实回归：
   - QQ 2 个账号不受影响；
   - wx account id=3 正常；
   - Provider 43201；
   - Resident ready；
   - startup_recover；
   - scoped `ws_400`；
   - raw Code 不落日志；
   - SessionId PowerShell 不再重复产生。
8. 明确得到用户 merge 指令后再合并 #56。
9. 合并后再设计生产 controlled convergence，不要 hard reset `far2-test`。
10. 如用户仍反馈任务管理器出现 PowerShell，再专门诊断 `PROCESS_SNAPSHOT_QUERY`，不要回头动已修好的 Resident SessionId 路线。

---

## 15. 快速核对清单

继续任务前先确认：

```text
main expected baseline              ae496dac3d96560f728396524f8761fa0d85f8c9 (unless newer main exists)
PR #57 farm-window removal          MERGED
PR #56 WeChat candidate             OPEN / READY / NOT MERGED
latest functional fix               41802b791e2e55c9ecea0d41e4779a906c50d04a
production root                     D:\project2\far2-test
production git HEAD                 d4c419246f0891d535280839317e694a049a71a3
production worktree                 TRACKED DIRTY - DO NOT RESET/CLEAN
clean main mirror                   D:\project2\far2-main-sync
resident task                       FAR2 WeChat Resident Agent
resident provider                   127.0.0.1:43201
QQ CodeAgent task                   FAR2CodeAgent-2320006072
farm-window-cloak                   REMOVED / DO NOT RESTORE
periodic WeChat Code refresh        DISABLED
WeChat refresh policy               on_invalid + startup_recover
SessionId repeated PowerShell       FIXED, 0 spawns / 12s post-fix
cold-start farm auto-open           NOT IMPLEMENTED
```

如果 `main` 已经在后续出现新提交，不要继续把 `ae496dac...` 当绝对最新；先重新 fetch/compare。本文记录的是 2026-08-20 00:35 +08:00 的已验证现场状态。

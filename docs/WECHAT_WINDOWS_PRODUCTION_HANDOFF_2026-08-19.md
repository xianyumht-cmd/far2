# FAR2 Windows 微信农场生产链完整交接 — 2026-08-19

> 交接时间：2026-08-19 14:48 +08:00 之后  
> 仓库：`xianyumht-cmd/far2`  
> 微信工作分支：`feature/windows-wechat-probe-20260819`  
> PR：#55（Draft，未合并）  
> 本交接写入前的功能代码 HEAD：`ab341daddee80fa599821c9236819e809f3364a9`  
> 真实生产目录：`D:\project2\far2-test`  
> 专用微信工作树：`D:\project2\far2-wechat-probe`

## 1. 当前结论

Windows 桌面微信版 QQ经典农场已经接入 FAR2 生产链，并完成了真实生产账号、Resident Agent、WebUI、fresh Code、失效恢复和生产部署验证。

当前微信 Code 策略已经从“每 3 分钟主动刷新”改为 **`on_invalid`**：

- 正常挂机期间不主动更换 Code；
- `ws_400` 时获取 fresh Code；
- 非“版本过低/客户端版本”类 kickout 时获取 fresh Code；
- FAR2Farm 服务启动/重启时，为恢复微信 Worker 获取一次 fresh Code；
- WebUI 新增微信账号、明确手动刷新仍可触发 fresh Code；
- 由上述事件触发后如果 Provider 暂时不可用，按 retry 策略继续重试；
- 不再存在微信“每 3 分钟定时换 Code”的生产策略。

最终一次生产策略部署已 PASS：

- FAR2Farm PID：`9804 -> 8456`
- `Periodic 3-minute WeChat Code refresh: DISABLED`
- `Previously running workers recovered: True`
- 报告：`C:\Users\Administrator\AppData\Local\Temp\FAR2-WeChat-Probe\wechat-on-invalid-refresh-policy-apply-20260819-144356.json`

## 2. 当前生产环境

### Windows / 工具

- Windows 10
- PowerShell：`7.6.4`
- 当前桌面用户：`Administrator`
- FAR2Farm Windows Service：`FAR2Farm`
- 当前成功部署后的 FAR2Farm PID：`8456`
- Node（Resident Agent 当前实际日志）：`D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe`

### 生产目录 / Git 状态

- 生产根目录：`D:\project2\far2-test`
- 生产 core：`D:\project2\far2-test\core`
- 生产 Git HEAD 仍为：`d4c419246f0891d535280839317e694a049a71a3`
- 生产工作树是 **tracked dirty**。
- 微信功能是通过 rollback-safe controlled apply 选择性部署到真实生产目录，不代表生产 Git HEAD 已经 merge 到 PR #55。

**禁止对生产 `far2-test` 做：**

- `git clean`
- `git reset --hard`
- 为了“同步分支”直接 checkout 覆盖生产 dirty 文件
- 未做语义审计的 blanket merge / blanket overwrite

### 当前生产账号

- QQ：2 个
- 微信：1 个
- 微信 production account id：`3`
- 显示名：`微信农场`
- 之前终端看到的 `寰俊鍐滃満` 是控制台代码页乱码，持久化名称实际一直是 `微信农场`，不要重复“修乱码”。

### 微信运行时基线

- Windows 微信：`4.1.12.26`
- exact appId：`wx5306c5978fdb76e4`
- WMPF：`25297`
- clientVersion：`1.13.2.7`
- gatewayVersion：`1.13.2.7_20260723`
- 官方 gateway：`wss://gate-obt.nqf.qq.com/prod/ws`
- gateway query：`code,os,platform,ver`
- `platform=wx`
- `os=Windows`
- Origin：`https://gate-obt.nqf.qq.com`

raw `wx.login` Code 是敏感凭证：正常生产 credential storage 可以保存当前账号 Code，但不能打印到日志、Git、命令行参数或交接报告。

## 3. Resident Agent 当前状态

### 生产 Agent

- Provider endpoint：`http://127.0.0.1:43201/`
- Scheduled Task：`FAR2 WeChat Resident Agent`
- 运行方式：当前桌面用户 Interactive Logon
- RunLevel：`Highest`
- Session 0：否
- 第三方 WMPFDebugger：不使用
- raw Code logging：关闭

### 已修复的重启自启动问题

第一次 Windows 重启后出现：

- FAR2Farm 已起来；
- WebUI 微信 Provider 显示 `ECONNREFUSED`；
- 即 `127.0.0.1:43201` Agent 没启动。

之后执行：

`repair-wechat-resident-agent-autostart.cmd`

修复结果：

- Scheduled Task 改为 `Interactive + Highest`；
- 使用本地 runtime wrapper；
- 增加隐藏启动日志；
- endpoint 可访问；
- Task 状态 `Running`；
- 当时返回 `waiting_bootstrap`，说明 Agent 进程已成功启动，只差农场 Runtime。

修复验证输出：

- `Agent endpoint reachable: True`
- `Task state / result: Running / 267009`
- 报告：`C:\Users\Administrator\AppData\Local\Temp\FAR2-WeChat-Probe\wechat-resident-agent-autostart-repair-20260819-140642.json`
- 日志：`C:\Users\Administrator\AppData\Local\FAR2\wechat-agent\logs\resident-agent-autostart-20260819-140646.log`

日志随后真实出现：

- `runtime_connected`
- `selecting_context`
- `exact farm runtime connected and ready`

### 重要边界：Agent 自启动 != 农场小程序自动启动

当前已证明的是：**Agent 可以随 Windows 用户登录隐藏启动**。

当前尚未实现的是：**Windows 重启后自动替用户打开微信里的 QQ经典农场小程序**。

因此冷启动目前仍需要：

1. Windows 登录；
2. 微信已登录；
3. 手动打开一次 QQ经典农场；
4. Agent 从 `waiting_bootstrap / disconnected / selecting_context` 进入 `resident_connected`；
5. FAR2 微信 Worker 才具备 fresh Code 恢复条件。

如果后续目标是“重启电脑后完全无人值守自动恢复”，这里仍是一个明确未完成项。

## 4. 已完成 / 已验证阶段

### P0–P6

已完成并通过，除非出现新直接证据，否则不要重跑：

- Windows 微信 / WMPF 运行时识别；
- exact farm appId 定位；
- `wx.login` fresh Code 获取；
- 官方 gateway profile / HTTP 101；
- `platform=wx` 真实登录；
- FAR2-native WMPF capture；
- Agent / Provider 基础链。

### P7R Resident Recovery

已通过真实恢复链：

`ws_400 -> fresh Code -> 仅替换目标微信 Worker -> Gateway Login`

同时验证 QQ 对照没有被微信恢复链误停/误启动。

文档：`docs/WECHAT_P7R_PASS_2026-08-19.md`

### P8 isolated stage real recovery

已通过：

- 两次 fresh 32-char Code；
- 两次真实 login-only Worker；
- scoped `ws_400`；
- Code 发生轮换；
- production FAR2Farm / accounts / tracked worktree 未修改；
- QQ untouched。

文档：`docs/WECHAT_P8_STAGE_RECOVERY_PASS_2026-08-19.md`

### P8 controlled production runtime apply

已完成真实生产落地：

- 微信 runtime 文件选择性部署进 `D:\project2\far2-test`；
- NSSM Provider 环境变量注入；
- FAR2Farm 单次部署重启后恢复；
- accounts hash 未被迁移脚本改坏；
- QQ 未被微信路径影响。

### P8 final production account gate

已创建并验证真实 production wx account：

- account id=`3`
- 2 QQ + 1 wx
- fresh Code 真实生产刷新通过；
- scoped recovery 通过；
- QQ identity/ownership 不变；
- Resident Agent ready；
- raw Code/token 未打印。

文档：`docs/WECHAT_P8_FINAL_PRODUCTION_GATE_PASS_2026-08-19.md`

### WebUI Resident 主路径 closeout

已完成真实生产部署。

生产 WebUI 已从旧扫码/8059 主路径切到：

**“使用当前已登录微信” / Resident Agent**

主要变更：

- `web/src/components/AccountModal.vue`
  - 新微信账号不扫码；
  - 不要求手贴微信 Code；
  - 保存 `platform=wx`；
  - `codeRefreshMode=windows_wechat`；
  - exact AppId；
  - 立即走 Resident fresh Code enrollment；
  - 编辑 wx 账号时隐藏 Code 输入，只允许编辑备注。
- `web/src/stores/wx-login.ts`
  - legacy QR/8059 store fail-closed；
  - 默认 disabled；
  - 不再承担 WebUI 微信主登录路径。
- `core/client.js`
  - 新建 wx 账号且尚无 Code 时，不启动空 Code Worker；
  - 改走 `WechatRecoveryManager.triggerRefresh(id, 'web_enroll')`；
  - QQ `startAccount` 保持原逻辑委托。

WebUI controlled apply PASS：

- FAR2Farm：`28120 -> 23808`
- QQ：`2 -> 2`
- wx：`1 -> 1`
- 之前 running 的 workers 全部恢复；
- Agent before/after ready；
- WebUI dist 已实际部署；
- 主路径 legacy 8059 retired；
- rollback 未触发。

报告：`C:\Users\Administrator\AppData\Local\Temp\FAR2-WeChat-Probe\wechat-webui-closeout-apply-20260819-132458.json`

备份：`C:\Users\Administrator\AppData\Local\FAR2\wechat-webui-closeout-backup\20260819-132458`

## 5. 当前 Code 刷新策略：最终生产规则

文件：`core/src/services/wechat-recovery-manager.js`

策略标记：

`REFRESH_POLICY = 'on_invalid'`

当前规则：

### 正常运行

- 不按照时间主动 fresh `wx.login` Code；
- `refreshIntervalMs = 0`；
- 不再每 3 分钟替换 Worker。

### 自动触发 fresh Code

- `ws_400`
- 非版本类 `kickout_stop`
- FAR2Farm process/service 启动后的 `startup_recover`

### 显式触发

- `web_enroll`
- manual refresh

### 重试

上述触发已经发生，但 Provider 暂时 unavailable 时才进入 retry；retry 不是周期性“保鲜”。

### 为什么必须保留 startup_recover

`wx.login` Code 是一次性凭证。

曾尝试“只在 ws_400/kickout 时刷新，服务启动时只要 accounts.json 里还有 Code 就不刷新”，真实生产重启后 Worker 无法恢复。原因是持久化的旧 Code 虽然字符串仍存在，但已经不能作为一次新的登录凭证重新消费。

因此最终策略不是“永远只看失效事件”，而是：

- **服务进程启动时 fresh 一次用于重建会话**；
- **运行稳定后只在会话失效事件时 fresh**。

这两者不能混淆。

## 6. 失败路线、原因与处理结果

### 6.1 WebUI 三方审计冲突

`audit-wechat-webui-closeout.cmd` 曾输出：

- `AccountModal.vue` CONFLICT
- `wx-login.ts` CONFLICT
- `Web build passed: False`
- `Safe: False`

原因：production WebUI 自身已有长期修改，不能直接三方自动 merge。审计脚本因为存在 conflict，按设计没有继续真正 build，因此这个 `build false` **不能解释为新版 WebUI 本身 TypeScript/Vite 构建失败**。

最终方案：

- 生产 WebUI 作为 staging 基线；
- 只把两个 closeout 文件设为 authoritative overlay；
- 隔离 build 通过后再选择性部署。

不要回头强行三方 merge 这两个文件。

### 6.2 WebUI apply 第一次：Agent disconnected

报错：

`wechat_resident_runtime_disconnected`

结果：

- fail-closed；
- 未改生产文件；
- 未重启 FAR2Farm。

原因：Resident exact farm runtime 当时没有保持 ready。

正确操作：打开/重新打开一次 QQ经典农场，让 Agent 到 `resident_connected`，而不是删掉安全检查。

### 6.3 WebUI apply 第二次：Vite ENOENT core/package.json

报错：

`ENOENT ...\wechat-webui-closeout-apply\...\core\package.json`

原因：`web/vite.config.ts` 会读取 `../core/package.json` 取得版本号，旧 staging 只复制了 `web/`，没创建同级 `core/package.json`。

结果：发生在生产 mutation 之前，生产未修改。

修复：增加 staged-core wrapper，只复制 build 所需的 production `core/package.json` 到隔离目录。

相关提交：

- `26a8a271905a38b4ee849872d0e29ab97e72d50b`

不要再恢复到旧的无 staged core 构建方式。

### 6.4 Windows 重启后 Agent 没起来

现象：

- WebUI Provider `ECONNREFUSED`
- 43201 不通
- 微信 Worker 无法获得 fresh Code

旧安装只证明 Scheduled Task 注册成功，没有证明真实下一次 reboot/logon 能运行。

最终修复：

- Interactive user；
- Highest privileges；
- hidden wrapper；
- runtime/dependency preflight；
- 本地 autostart log。

相关功能提交：

- `41ba86f63cf11b8a82051b1c072f0900ab7dd386`

注意：没有旧任务的完整失败日志，所以不要把“唯一根因”写死为某个具体 Windows error code；已证事实是旧任务冷启动没有建立 43201，新任务 repair 后 endpoint=true。

### 6.5 on-invalid policy apply：waiting_bootstrap

第一次策略部署在 preflight 阶段返回：

`waiting_bootstrap`

结果：未改生产文件。

原因：Agent 进程已启动，但还没有 exact farm runtime。

正确处理：微信登录后手动打开 QQ经典农场一次。

### 6.6 on-invalid policy apply：Worker 210 秒未恢复，自动回滚成功

曾真实部署新 manager、重启 FAR2Farm，随后：

- 210 秒内 previously-running workers 未全部恢复；
- `Rollback attempted/succeeded: True/True`。

原因：第一版 `on_invalid` 在 service startup 看到账号还有持久化 Code，就认为无需 refresh；但 wx.login Code 一次性，服务重启后的新登录不能复用旧 Code。

修复：增加 `startup_recover`：每次 FAR2Farm process 启动时，为已配置微信账号 fresh 一次，然后回到事件驱动模式。

相关功能提交：

- `44f58b62af8f4f90eba67f58d5eb92e930aa9673`

不要恢复“启动时有字符串 Code 就直接复用”的逻辑。

### 6.7 on-invalid apply：瞬时 disconnected / selecting_context 被误判为失败

曾连续发生：

- `wechat_resident_runtime_disconnected`
- 下一次立即变成 `selecting_context`

旧 apply 脚本只检查一次 health，因此撞到 WMPF Runtime 状态机过渡阶段就直接 fail。

修复：preflight/post-restart health gate 最多等待约 60 秒让 Agent settle；仍然是 fail-closed，超过时间不 ready 才退出。

相关功能提交：

- `ab341daddee80fa599821c9236819e809f3364a9`

不要取消 readiness gate，也不要把所有 disconnected 当永久故障。

### 6.8 最终 on-invalid apply PASS

最终真实过程：

- preflight 观察到 `wechat_resident_runtime_disconnected`
- 中间短暂 `provider_health_failed`
- `selecting_context`
- 最终 Agent settle ready
- 输入 FAR2 admin 密码
- FAR2Farm 重启一次
- workers 全部恢复
- 策略 gate PASS

输出：

- `FAR2Farm PID: 9804 -> 8456`
- `Periodic 3-minute WeChat Code refresh: DISABLED`
- `Automatic refresh triggers: ws_400 / non-version kickout only`
- `Previously running workers recovered: True`

## 7. 明确不要重复的路线

除非出现新的直接证据，否则不要重复以下路线：

1. 不要重新做 P0–P6 / P7R 基础取证。
2. 不要再把 7897 当 Farm Runtime 调试端口；之前确认过是 Clash 相关，不是目标。
3. 不要恢复旧 8059 / QR 扫码作为微信 WebUI 主路径。
4. 不要依赖第三方 WMPFDebugger 作为生产链；最终是 FAR2-native Resident capture。
5. 不要做 broad SSL / WebSocket payload 抓取。
6. 不要抓聊天数据库、联系人、附件正文、Cookie 或长期 Token。
7. 不要终止整个 `Weixin.exe`；如果需要重建 Runtime，只关 exact QQ经典农场小程序窗口。
8. 不要在诊断中猜农场 write RPC。
9. 不要让微信恢复逻辑改 QQ 的 exact-UIN Provider 或 QQ `clientVersion`。
10. 不要把微信恢复改回固定 3 分钟刷新。
11. 不要把一次性 wx.login Code 在 FAR2Farm restart 后当可复用登录凭证。
12. 不要在已经有 Scheduled Task Agent 运行时，再手工启动第二个 Agent 抢 43201。
13. 不要在 Web 后台微信 Worker 正常挂机时随意点小程序“重新连接”；这会抢走游戏会话并踢后台 Worker。
14. 不要把控制台 mojibake 当 accounts.json 名称损坏。
15. 不要为了把 PR #55 “合并进生产”而对 dirty production 做 `git reset/checkout/clean`。
16. PR #55 仍是 Draft，不能自动 merge main。
17. `core/src/controllers/admin.js` 旧 `/api/proxy` 兼容端点仍存在；不要误说“8059 后端代码已经完全删除”。当前结论只是 **WebUI 主路径已退役 8059**。

## 8. 手动操作与后台挂机的正确切换

如果用户临时想手动玩微信农场：

1. 先在 WebUI 关闭微信挂机 Worker；
2. 再在小程序点“重新连接”并手动操作；
3. 手动结束后，保持/重新打开 QQ经典农场；
4. 等 Resident Agent 回到 `resident_connected`；
5. 再在 WebUI 开启微信挂机；
6. 后台 Worker 在线后，小程序提示“在其他地方登录”属于预期现象，此时不要再点重新连接。

Resident Agent 需要 exact WMPF runtime 存在来执行后续 `wx.login`，但 interactive 小程序本身不需要持有生产游戏 WebSocket。

## 9. 当前重要代码与脚本

### 核心运行时

- `core/src/services/wechat-gateway-profile.js`
- `core/src/services/wechat-runtime-code-provider.js`
- `core/src/services/wechat-recovery-manager.js`
- `core/src/services/wechat-code-agent.js`
- `core/src/services/wechat-wmpf-native-capture.js`
- `core/src/services/wechat-wmpf-resident-capture.js`
- `core/scripts/wechat-resident-agent.js`
- `core/client.js`

### WebUI

- `web/src/components/AccountModal.vue`
- `web/src/stores/wx-login.ts`
- CodeManager 页面当前仍是共享 UI，后续可再优化 wx wording。

### Windows 一键入口

- `start-wechat-resident-agent.cmd`
- `install-wechat-resident-agent-autostart.cmd`
- `repair-wechat-resident-agent-autostart.cmd`
- `audit-wechat-webui-closeout.cmd`
- `apply-wechat-webui-closeout.cmd`
- `apply-wechat-on-invalid-refresh-policy.cmd`

## 10. 当前关键提交

仅列后期收尾最重要、可作为定位点的提交：

- `ccea56c82854877295a3082a923228886e5e21bd` — WebUI closeout audit launcher 时点
- `86b3fbedc85ea84099c83a9492c8fe851dc156d6` — WebUI controlled apply launcher
- `26a8a271905a38b4ee849872d0e29ab97e72d50b` — staged `core/package.json` build wrapper 修复
- `41ba86f63cf11b8a82051b1c072f0900ab7dd386` — Resident Agent autostart Highest 修复
- `44f58b62af8f4f90eba67f58d5eb92e930aa9673` — on-invalid + service startup fresh Code recovery
- `ab341daddee80fa599821c9236819e809f3364a9` — Agent readiness settle wait，避免瞬时 disconnected/selecting_context 误失败

本交接文档提交后 branch HEAD 会继续前进；判断“功能代码基线”时以上述 `ab341dad...` 为本轮最终生产策略功能时点。

## 11. 当前 PR 状态

PR #55：

- 状态：Open
- Draft：True
- merged：False
- mergeable：True（交接写入前）
- head branch：`feature/windows-wechat-probe-20260819`

不要自动 merge。

生产代码已经选择性部署成功，不等于 PR 已经进 main，也不等于 `far2-test` Git history 已经包含这些提交。

## 12. 未完成问题

### A. 真正的 Windows 零人工冷启动

当前 Agent 可以登录自启动，但 QQ经典农场小程序不会自动打开。

所以 Windows reboot 后仍需用户手动打开一次小程序，让 exact farm runtime bootstrap。

如果目标是完全无人值守，需要单独设计：

- 安全、可定位到 exact appId 的小程序启动方式；
- 不杀 Weixin；
- 不误开其它微信小程序；
- Agent ready 后再恢复微信 Worker；
- 失败时 fail-closed。

这是当前最明确的功能未完成项。

### B. repaired autostart 的“下一次真实 reboot”最终闭环验证

本次 repair 已在当前登录会话证明：

- Scheduled Task Running
- 43201 reachable
- exact runtime 在手动打开农场后 ready

但还需要一次 **repair 之后的新 reboot/logon**，验证新的 Highest task 确实能从冷启动直接建立 43201。

### C. on-invalid policy 的长期观察

目前真实部署 Gate 已 PASS，但建议继续观察：

- 超过 3 分钟后 Code 不应因时间自动改变；
- 长时间稳定挂机不应周期性重启 Worker；
- 真实 `ws_400` 出现时应 fresh Code 并只恢复目标 wx Worker；
- QQ Worker 不应被影响。

### D. WebUI 文案

后端已经 `refreshIntervalMs=0 / on_invalid`。

共享 CodeManager UI 仍可能显示“刷新周期”并格式化为 `—`/`0`，以及包含一些 QQ Session wording。后续可把微信账号显示优化为：

- “刷新策略：仅失效时”
- “Resident Agent：connected/waiting_bootstrap”
- 隐藏对 wx 无意义的 QQ UIN/Session 字段

这是 UX 收尾，不影响当前生产策略。

### E. legacy `/api/proxy`

WebUI 主路径已不使用 8059，但 `core/src/controllers/admin.js` 的旧 `/api/proxy` 兼容 endpoint 还在。

后续可：

- 改成显式 opt-in；或
- 确认无消费者后删除。

不要在没有兼容性检查时直接删。

### F. PR #55 最终 Ready / merge

建议在以下条件后再考虑 Draft -> Ready：

1. repair 后再经历一次真实 Windows reboot；
2. Agent 自动起来并 43201 reachable；
3. 手动打开一次农场后 resident ready；或者若实现自动打开，则完全无人值守 ready；
4. FAR2Farm startup_recover fresh Code 成功；
5. 2 QQ + 1 wx 全部稳定；
6. 至少观察一个明显超过 3 分钟的窗口，确认 wx Code 不再按周期刷新；
7. 如方便，再等一次真实失效事件证明 `on_invalid` 恢复。

## 13. 下一步操作建议

### 下一次最有价值的测试：冷启动闭环

1. 当前先保持生产挂机，不再重复 apply。
2. 找方便时间重启 Windows。
3. 登录后不要手工启动旧 Agent 黑窗口。
4. 先检查 Scheduled Task `FAR2 WeChat Resident Agent` 是否 Running。
5. 检查 `127.0.0.1:43201` 是否已 reachable。
6. 登录微信。
7. 手动打开一次 QQ经典农场。
8. 等 Resident 进入 `resident_connected`。
9. 检查 FAR2 WebUI 微信账号能启动/恢复挂机。
10. 观察 10 分钟以上，确认不再出现 3 分钟周期 Code 更换。
11. 保存 autostart log、FAR2 worker 状态和 CodeManager status（禁止打印 raw Code）。

如果这条全 PASS，再决定：

- 是否实现小程序自动打开，做到真正零人工 reboot；
- 是否清理 legacy `/api/proxy`；
- 是否更新 WebUI on-invalid 文案；
- 是否把 PR #55 从 Draft 改 Ready。

## 14. 安全与隐私硬约束

后续所有操作继续遵守：

- raw wx.login Code 不打印、不进 Git、不进 cmdline/report；
- Provider token 不打印；
- FAR2 admin password/token 不打印；
- 不读聊天数据库、联系人、附件正文；
- 不抓 Cookie/长期 Token；
- 不做 broad SSL / WebSocket payload capture；
- 只针对 exact appId `wx5306c5978fdb76e4`；
- 不终止 `Weixin.exe`；
- 不猜农场 write RPC；
- 不改 QQ exact-UIN 路线；
- QQ global protocol 继续保持现有生产值，不因微信修改；
- production dirty worktree 不 reset/checkout/clean；
- PR #55 不自动 merge。

---

## 快速恢复上下文

后续新会话只需要先读本文件，然后确认：

- PR #55 当前 HEAD；
- production FAR2Farm 当前 PID；
- Scheduled Task 是否 Running；
- 43201 是否 reachable；
- Agent 是否 `resident_connected`；
- production 账号仍是 2 QQ + 1 wx；
- `wechat-recovery-manager.js` 当前是否为 `REFRESH_POLICY='on_invalid'`；
- CodeManager 对 wx 是否报告 `refreshIntervalMs=0`。

如果这些都成立，不要回头重复 P0–P8 已通过取证，直接处理“冷启动零人工 / 长期 on-invalid 观察 / PR 收口”即可。

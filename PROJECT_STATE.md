# FAR2 Project State / Handoff

> Last updated: 2026-08-13
>
> Repository: `xianyumht-cmd/far2`
>
> Branch: `main`
>
> Current authoritative baseline: `docs/PRODUCTION_BASELINE_2026-08-13.md`

## 1. Current status

FAR2 的 Code 自动刷新与完整好友导入两条底层主线均已完成。当前进入**无人值守稳定性 + 新业务功能**阶段。

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

**SOURCE FIX COMPLETE / LOCAL RESTART CHECK PENDING**

2026-08-13 静态检查发现一个与无人值守目标冲突的历史配置：

```text
core/client.js -> runtimeEngine.start({ autoStartAccounts: false })
```

这会导致 FAR2Farm 服务本身可以启动，但正式入口不会调用 `startAllAccounts()`，因此 Windows / 服务重启后存在账号 Worker 需要人工启动的风险。

当前修复：

- `core/client.js` 不再显式关闭 `autoStartAccounts`；
- Runtime Engine 默认自动启动已保存账号；
- `FARM_AUTO_START_ACCOUNTS=0` 可显式进入 panel-only 模式；
- CodeManager 和 startup friend importer 先启动，再启动 Worker；
- 正式链不依赖浏览器打开或手动点击“启动账号”。

下一次真实 Windows 验证只需：更新代码后重启一次 `FAR2Farm`，确认保存账号自动出现 Worker / Farm 登录日志。无需重测 Code mint、V4 好友采集或 Windows2。

## 2. Current production architecture

```text
Windows / FAR2Farm service start
  -> Runtime Engine
       -> CodeManager + startup friend importer ready
       -> auto-start saved accounts (default ON)
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
```

## 3. Second QQ / second Windows Session

这是**可选未来扩展**，不是当前主线，不是当前完成标准，也不需要为了继续项目而去 Windows 2 做验收。

多 Session / 多 target 的部署能力已经存在；未来确实要挂第二 QQ 时，再单独做第二账号实机 E2E。

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
- Friend Capture V1 / V2 / V3。

## 7. How to continue from here

后续新对话按下面优先级判断项目状态：

1. 当前 `main` 源码；
2. `docs/PRODUCTION_BASELINE_2026-08-13.md`；
3. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；
4. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；
5. 其他历史文档。

当前短期顺序：

1. 完成一次 FAR2Farm 服务重启，确认账号 Worker 自动启动；
2. 然后进入“运行健康中心”或其他新的业务功能；
3. 不回头重测 Windows2 / Code / V1-V3 好友采集。

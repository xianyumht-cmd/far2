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

FAR2 的 Code 自动刷新、完整好友导入、Windows 服务启动后账号自动恢复三条无人值守基础链均已完成验收。运行健康中心第一版也已完成实机查看。当前进入**稳定性收尾 + 后续私有版本功能差异追赶**阶段。

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

1. 本地更新至 `754bfa8` 后执行 `Restart-Service FAR2Farm`；
2. 不打开浏览器、不手动点击“启动账号”；
3. FAR2 自动启动账号 `232`；
4. 启动后首次 Farm WS 返回 HTTP 400；
5. CodeManager 自动触发恢复，旧 Worker 正常退出；
6. 新 Worker 自动启动并登录成功，账号恢复到 Lv112；
7. V4 好友启动导入同步恢复：103 GID / 275 openId；
8. 好友帮助与巡查实际继续运行。

这证明当前正式链已经形成：

```text
FAR2Farm service restart
  -> CodeManager / friend importer ready
  -> saved account Worker auto-start
  -> WS400 if Code stale
  -> targeted Code refresh
  -> replacement Worker auto-start
  -> Farm login recovered
  -> V4 friend pool restored
  -> automation resumes
```

当前单机生产约束为只运行一个目标 QQ；其他保存账号不要求在同一 Windows 实例同时在线，因此不作为本轮失败项，也不需要 Windows2 验收。

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

健康页同时暴露一个 P0 收尾问题：当前 `startAllAccounts()` 会把保存的 `4476` Worker 也启动，但本机生产规则只应自动启动当前 Provider target 对应 QQ。该问题进入下一项稳定性修复，不影响已验收的 `232` 生产链。

## 2. Current production architecture

```text
Windows / FAR2Farm service start
  -> Runtime Engine
       -> CodeManager + startup friend importer ready
       -> auto-start saved accounts
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

> P0 修复后，上面的 `auto-start saved accounts` 应收紧为：存在 Provider targets 时只自动启动匹配 target UIN 的账号；无 targets 的通用部署保持原语义。

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
- 秒偷 / 蹲守 / 自动刷变异等后续版本自己已删除的功能。

## 7. Current feature roadmap

后续私有版功能差异审计已经固定到：

```text
docs/FEATURE_GAP_AUDIT_2026-08-13.md
```

该审计覆盖后续更新日志 2026-04-13 ～ 2026-06-26，并将功能分为：已有、部分基础、缺失、FAR2 已替代、判废、需当前协议验证。

当前顺序：

1. **P0：生产 Provider target 范围内自动启动 Worker**，解决 `4476` 被一起拉起的问题；
2. **P1：图鉴 + 种子商店**，利用仓库现有 `illustratedpb.proto` / `shoppb.proto` / Shop RPC；
3. **P2：单土地操作 + 紫土地**；
4. **P3：变异只读展示**；
5. **P4：宠物 / 狗狗**；
6. **P5：个人生涯 / 装扮 / 通用活动框架**。

## 8. How to continue from here

后续新对话按下面优先级判断项目状态：

1. 当前 `main` 源码；
2. `docs/PRODUCTION_BASELINE_2026-08-13.md`；
3. `docs/FEATURE_GAP_AUDIT_2026-08-13.md`；
4. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；
5. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；
6. 其他历史文档。

**不要再把 Code 自动刷新、好友完整导入、Windows2 验收当成默认下一步。**

新的默认推进顺序是：P0 Worker 启动范围收尾 → P1 图鉴/种子商店。

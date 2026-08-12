# FAR2 Production Baseline — 2026-08-13

状态：**CURRENT PRODUCTION BASELINE**

本文用于结束 2026-08-12 ~ 2026-08-13 的 Code 自动刷新、QQ 好友完整导入与 Windows 服务启动恢复研发阶段。后续继续开发时，先认本文与当前源码，不再把已验收功能重新当成待解决问题。

## 1. 已验收范围

### Phase 1 — 单账号 Windows 无人值守 Code 自动刷新

状态：**COMPLETED / ACCEPTED**。

当前正式范围：

- Windows 后台 NSSM 服务 `FAR2Farm`；
- 隐藏 Scheduled Task Code Agent；
- 精确 QQ/UIN Provider 路由；
- WS400 / kickout / 手动触发时按账号刷新；
- healthy 状态不做周期性 QQ Farm 重登录；
- Provider 先拿到新 Code，再停止旧 Worker；
- Worker 自动重启并恢复 Farm 登录；
- 普通日志 / API / WebUI 不输出明文 Code；
- 浏览器可以关闭；
- 已有约 9 小时真实无人值守运行验收记录。

正式验收记录：

- `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`

### Phase 2 — QQ 完整好友池自动导入

状态：**COMPLETED / ACCEPTED**。

当前正式范围：

- Windows 启动阶段由 Code Agent 运行 QQ Farm 好友采集；
- 生产采集器只使用 `core/src/services/windows-runtime-friends-v4.js`；
- V4 采集真实 GID + openId；
- 采集结果持久化并导入 FAR2；
- Worker 使用采集 openId 执行 `SyncAll`；
- GID 持久化进入 `knownFriendGids`；
- `GetGameFriends` 返回完整有效好友池；
- 好友帮助 / 巡查 / 偷菜已经实际使用新好友池。

真实验收记录包括：

- 103 个 GID；
- 275 个 openId 上游关系数据；
- 97 位当前有效好友；
- 实际好友偷菜/巡查日志已出现。

正式验收记录：

- `docs/FRIEND_GID_HANDOFF_2026-08-13.md`

### Phase 3 — Windows 服务启动后账号自动恢复

状态：**COMPLETED / ACCEPTED**。

2026-08-13 真实 Windows 服务重启验证结果：

- 本地更新至 `754bfa8`；
- 执行 `Restart-Service FAR2Farm`；
- 不打开浏览器、不手动点击启动账号；
- FAR2 自动启动账号 `232`；
- 首次连接出现真实 WS HTTP 400；
- CodeManager 自动完成恢复；
- 旧 Worker 退出，新 Worker 自动启动；
- Farm 登录成功，账号恢复到 Lv112；
- V4 好友池同时恢复：103 GID / 275 openId；
- 好友帮助与巡查继续实际运行。

因此当前生产链已验证为完整闭环：

```text
FAR2Farm service restart
  -> recovery/import infrastructure ready
  -> saved account Worker auto-start
  -> stale Code -> WS400
  -> targeted Code refresh
  -> replacement Worker auto-start
  -> Farm login recovered
  -> V4 friend pool restored
  -> automation resumes
```

当前单机生产范围按“一台 Windows 只运行一个目标 QQ”处理；其他保存账号不要求在同一 Windows 实例同时在线，不作为当前失败项。

## 2. 当前生产链

```text
Windows / FAR2Farm service start
  -> Runtime Engine
       -> CodeManager / friend importer ready first
       -> auto-start saved accounts (default ON)
       -> Worker

Windows 用户会话
  -> FAR2CodeAgent-<UIN>
       -> 启动阶段 Friend Capture V4
       -> GID/openId artifact
       -> Provider /v1/health + /v1/code/refresh

Worker
  -> 导入完整好友池
  -> SyncAll / GetGameFriends
  -> 帮助 / 巡查 / 偷菜

Code 失效
  -> WS400 / kickout
  -> exact-UIN Provider refresh
  -> 新 Code 成功后替换 Worker
  -> 自动恢复 Farm 登录
```

### 2.1 2026-08-13 无人值守启动闭环修复

静态收口检查曾发现：`core/client.js` 仍显式传入 `autoStartAccounts: false`，与生产目标不一致。

当前源码已经修正并完成真实验收：

- 正式 `core/client.js` 不再关闭账号自动启动；
- Runtime Engine 默认自动启动全部已保存账号；
- 如确实只想启动 Web 面板，可显式设置 `FARM_AUTO_START_ACCOUNTS=0`；
- CodeManager 与 startup friend importer 先启动，再启动 Worker；
- 不依赖浏览器打开或手动点击“启动账号”；
- FAR2Farm 服务重启后已实机证明账号可自动上线并在 WS400 后自动恢复。

该项属于**稳定性缺陷修复并已验收完成**，不再作为待测试项。

## 3. 第二 QQ / 第二 Windows Session 的定位

**不是当前阻塞项，也不是本轮继续开发前必须完成的验收。**

当前实际生产约束为“一台 Windows 运行一个目标 QQ”。多 target / 多 Session 的部署能力可以保留，未来真的需要第二 QQ 时再做独立实机验收。

当前项目完成标准以已经验收的单账号 Windows 生产链为准。

`docs/MULTI_SESSION_CODE_AGENT_HANDOFF_2026-08-13.md` 仅作为可选未来扩展记录，不应覆盖本基线的完成状态。

## 4. 生产代码保留规则

好友采集：

- 保留：`windows-runtime-friends-v4.js`；
- 已删除：V1、V2、V3；
- 不允许重新 fallback 到旧版本。

Code 刷新：

保留当前正式组件：

- `code-manager.js`；
- `desktop-session-registry.js`；
- `isolated-runtime-code-provider.js`；
- `isolated-code-agent.js`；
- `windows-runtime-code.js`；
- Provider / CodeManager / Session 相关安全自测与诊断工具。

## 5. 已移除的判废实验

本次收口从主线删除：

- 旧 QQ miniapp QR mode test；
- PC bridge test；
- dual-scan test；
- renderer restart test；
- target-window reload test；
- target-session preload；
- 好友采集 V1 / V2 / V3。

同时移除对应 pnpm 入口，避免后续误跑旧方案。

## 6. 不要重新引入

除非出现真正新的技术证据，否则不要重新引入：

- 旧 QR exchange；
- QZone / PC cookie bridge / dual scan；
- shared-desktop 全局 QQ chooser；
- Ctrl+R 目标窗口实验；
- renderer restart / kill；
- PID / 窗口顺序猜账号；
- 为绕过隔离设计而做的 preload / 注入捷径；
- 好友采集 V1 / V2 / V3。

## 7. 后续开发原则

从这里开始，Code 自动刷新、完整好友导入、Windows 服务启动恢复全部按“已完成基础设施”处理。

下一项工作应进入新的业务功能或运行可观测性，优先考虑“运行健康中心”；不要为了继续开发而人为增加第二 QQ 验收、周期刷新或重新采集方案。

如果未来出现 Code 或好友链回归，应优先对照：

1. 当前源码；
2. 本文；
3. `FRIEND_GID_HANDOFF_2026-08-13.md`；
4. `CODE_REFRESH_MILESTONE_2026-08-12.md`；
5. 其他历史实验文档。

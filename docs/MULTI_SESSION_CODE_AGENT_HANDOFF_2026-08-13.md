# FAR2 多 Windows Session Code Agent 交接

> 日期：2026-08-13（UTC+8）
>
> 状态：**IMPLEMENTED IN SOURCE / REAL SECOND-QQ ACCEPTANCE PENDING**
>
> 前置里程碑：
> - `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`：单账号 Code 自动刷新已验收；
> - `docs/FRIEND_GID_HANDOFF_2026-08-13.md`：好友完整导入已验收。

## 0. 继续工作的硬边界

不要重做：

- 好友 V1/V2/V3/V4 旧实验；V4 当前已验收；
- QR / QZone QR / dual-scan；
- shared desktop 全局 QQ 选择；
- Ctrl+R；
- renderer kill/restart；
- PID/window-order 猜号；
- 进程注入、内部 IPC、cookie extraction；
- 健康账号固定小时主动重登。

当前新增范围只有：**把已经支持多 target 的 Code Provider 部署到第二个独立 Windows 用户 Session，并完成双账号受控验收。**

## 1. 为什么继续点在部署层

当前 Provider 已经按 exact UIN 路由：

```text
UIN A -> endpoint A
UIN B -> endpoint B
```

Agent 本身也已经限定：

- 当前 Windows Session；
- exactly one QQ main process；
- expected UIN；
- capture 后再次验证 runtime UIN。

之前真正的单账号限制在 `scripts/windows/install-far2-autostart.ps1`：

- 要求 exactly one enabled `windows_session` account；
- 固定 43101；
- 固定 `FAR2_CODE_PROVIDER_TOKEN_A`；
- 每次安装会删除全部 `FAR2CodeAgent-*`；
- 会用当前 UIN 重写整个 Provider mapping。

因此第二 QQ 不需要新 Code 捕获算法，只需要增量部署。

## 2. 本轮已实现

分支 / PR：

```text
feat/multi-session-code-agent-install-20260813
PR #1 feat: incremental multi-session Code Agent deployment
```

改动文件：

```text
scripts/windows/install-far2-autostart.ps1
scripts/windows/status-far2-autostart.ps1
docs/WINDOWS_AUTOSTART.md
docs/CODE_REFRESH_PROVIDER.md
```

### 2.1 安装器改为增量注册

一次运行只负责“当前 Windows Session 的一个 QQ”。

行为：

- 单账号仍兼容旧安装；
- 多个启用账号时，从当前 Session 的 QQ 进程 `--annotation=uin=` 中匹配 FAR2 启用 UIN；
- 无法唯一识别时 fail-closed，不猜号；
- 支持显式 `-Uin <QQ>`；
- 已存在 target 优先复用原 loopback 端口；
- 新 target 自动从 `43101-43199` 找下一空闲映射端口；
- token env 自动使用 `FAR2_CODE_PROVIDER_TOKEN_A`、`_B`、`_C`…；
- 已存在 target 复用原 tokenEnv/token；
- `FARM_CODE_PROVIDER_TARGETS_B64` 解码后 merge；
- NSSM `AppEnvironmentExtra` 也保留已有其他环境项；
- 只删除/重建 `FAR2CodeAgent-<当前UIN>`；
- 不删除其他 UIN 的 Agent task；
- 如果当前 UIN 已配置非 loopback/无效 Provider URL，不会静默覆盖；必须显式给 `-AgentPort` 才表示确实要替换成当前本地 Session Agent；
- 更新 targets 后重启 `FAR2Farm`，让 LocalSystem 加载新的 mapping/token。

### 2.2 状态脚本改为多 target

`status-far2-autostart.ps1` 现在：

- 列出全部 `FAR2CodeAgent-*` 和 task user；
- 读取 NSSM `AppEnvironmentExtra`；
- 解码全部 Base64 Provider targets；
- 每个 target 分别检查 loopback listener；
- 读取对应服务 token 调 `/v1/health`；
- 显示 masked QQ、Windows SessionId、available/reason；
- 明确输出 `identityOk=True/False`；
- 标记 mapping 中不存在的 orphan task；
- 不输出 token 明文，也不输出 Farm Code。

### 2.3 文档状态纠正

`docs/CODE_REFRESH_PROVIDER.md` 旧内容仍写“real Provider acceptance pending”，与 2026-08-12 milestone 冲突。

本轮已改为：

- 单账号 isolated Provider：**COMPLETED / ACCEPTED**；
- 第二 QQ / 第二 Windows Session：pending；
- 生产策略继续 `FARM_CODE_SCHEDULED_REFRESH=0`，只做事件驱动。

## 3. 这轮没有改什么

没有改：

```text
core/src/services/code-manager.js
core/src/services/isolated-runtime-code-provider.js
core/src/services/isolated-code-agent.js
core/src/services/windows-runtime-code.js
core/src/services/windows-runtime-friends-v4.js
```

原因：这些核心链已经具备本阶段需要的 exact-UIN、多 target、SessionId 和防串号能力，不应为了第二 QQ 重新动已验收算法。

## 4. 实机第二 QQ 最小验收步骤

不需要重启电脑来“证明”旧功能。

### A. 准备第二 Windows 用户 Session

- 第二用户 Session 只登录 QQ B；
- FAR2 中 QQ B 已设置：
  - `codeRefreshEnabled=true`
  - `codeRefreshMode=windows_session`
- QQ经典农场已至少打开过一次，有 QQEX cache；
- 为了让一键安装器自动识别，多账号情况下建议**安装时保持 QQ经典农场处于打开/刚打开状态**，确保该 Session 进程树里存在 `--annotation=uin=`。

### B. 在第二 Windows 用户中安装

管理员运行：

```text
install-windows-service.cmd
```

预期：

- 原 A 的 `FAR2CodeAgent-<A>` 仍存在；
- 新增 `FAR2CodeAgent-<B>`；
- A 仍是原端口/原 tokenEnv；
- B 一般拿到 43102 / `FAR2_CODE_PROVIDER_TOKEN_B`；
- Provider target count=2；
- `FAR2Farm` 重启后 Running。

如果自动 UIN 识别 fail-closed，不要改成猜号逻辑。直接在 B 用户 Session 运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-far2-autostart.ps1 -Uin <QQ B完整UIN>
```

### C. 先只查状态

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\status-far2-autostart.ps1
```

目标：

```text
Provider targets count=2
A listener LISTEN
A health identityOk=True
B listener LISTEN
B health identityOk=True
```

### D. exact-UIN health probes

```powershell
cd core
pnpm code:provider-check -- <QQ A UIN>
pnpm code:provider-check -- <QQ B UIN>
```

都必须只命中自己的 endpoint。

### E. B 单次 mint

```powershell
pnpm code:provider-check -- <QQ B UIN> --refresh
```

要求：

- fresh Code 成功；
- 不打印/持久化明文 Code；
- runtime identity 是 B；
- A 不受影响。

### F. 双向受控 E2E

完成：

1. refresh B，确认 A worker/Code 不变；
2. refresh A，确认 B worker/Code 不变；
3. 无 account chooser；
4. 无跨号；
5. 无旧 Ctrl+R/renderer 路径。

之后再进入 two-account unattended soak。

## 5. 尚未声称完成

当前不能写成“多账号 Code 自动刷新已验收”。

还缺：

- 第二 Windows user Session 真实 Agent acceptance；
- A/B 双向 controlled E2E；
- 两账号无人值守多周期 soak；
- 未来自然 Code expiry 窗口观察（可后续自然发生，不需要为了测试主动破坏现有稳定链）。

正确状态：

> **多 Windows Session 部署支持已实现；第二 QQ 真实验收 pending。**

## 6. 下一会话怎么继续

优先读取：

1. 本文；
2. `docs/CODE_REFRESH_MILESTONE_2026-08-12.md`；
3. `docs/FRIEND_GID_HANDOFF_2026-08-13.md`；
4. 当前 `main` 源码。

如果本 PR 已合并，直接从“第二 Windows 用户 Session 安装 + status 双 target”开始。

不要再回到好友完整导入，也不要重新证明单账号 Code Provider。

# FAR2 Windows 后台自启

## 目标

安装后不再保留两个命令行黑框：

- FAR2 WebUI / CodeManager / worker 管理由 NSSM Windows 服务 `FAR2Farm` 后台运行；
- 每个 QQ 的 isolated Code Agent 由**拥有该 QQ 的 Windows 用户 Session**中的隐藏计划任务运行；
- 同一台机器可按 `UIN -> 独立 loopback 端口 -> 独立 Windows Session` 注册多个 Agent；
- 用户平时只需要访问 `http://127.0.0.1:3007`。

这里的“隐藏计划任务”只表示 **Code Agent 自己不弹 PowerShell/Node 控制台窗口**。FAR2 不再隐藏、移动或持续扫描 QQ 农场窗口，农场窗口保持系统原本的可见状态。

## 为什么 Code Agent 不能放进 NSSM / Session 0

主 FAR2 可以运行在 LocalSystem / Session 0。

Code Agent 必须与 QQ/QQEX 处于同一个交互式 Windows Session，因为：

- Agent 的防串号边界包含 Windows SessionId；
- `tencent://` 必须交给当前用户已经登录的 QQ；
- QQEX 缓存在当前用户的 `%APPDATA%\QQEX`；
- Windows 服务 Session 0 与桌面用户 Session 隔离。

多账号结构：

```text
开机
  └─ NSSM: FAR2Farm (LocalSystem)
       └─ WebUI / CodeManager / workers
            ├─ UIN A -> 127.0.0.1:43101
            └─ UIN B -> 127.0.0.1:43102

Windows user/session A
  └─ FAR2CodeAgent-<UIN A> (Hidden console only)
       └─ one QQ A

Windows user/session B
  └─ FAR2CodeAgent-<UIN B> (Hidden console only)
       └─ one QQ B
```

不要为了省一个 Windows Session 而取消 UIN / SessionId 校验，也不要恢复全局 QQ 选择器、Ctrl+R、renderer 重启等旧方案。

## 安装前提

每个要接入自动 Code 刷新的 QQ 都必须：

- 在 `core/data/accounts.json` 中设置 `codeRefreshEnabled=true`；
- `codeRefreshMode=windows_session`；
- 在自己的 Windows 用户 Session 中只运行该目标 QQ；
- QQ经典农场至少手动打开过一次，已有 QQEX 缓存；
- Node.js 与 NSSM 可用。

NSSM 搜索顺序：

1. `NSSM_EXE`；
2. PATH 中的 `nssm.exe`；
3. FAR2 `tools\nssm-2.24\win64\nssm.exe`；
4. `D:\Program Files\nssm-2.24\nssm.exe`；
5. `D:\project2\lolapisevers\tools\nssm-2.24\win64\nssm.exe`；
6. `C:\tools\nssm\win64\nssm.exe`。

## 第一个 QQ

在第一个 QQ 所属 Windows 用户中，右键管理员运行：

```text
install-windows-service.cmd
```

全新安装时默认：

- 第一个可用 Agent 端口为 `43101`；
- 第一个 token 环境变量为 `FAR2_CODE_PROVIDER_TOKEN_A`；
- 建立 `FAR2CodeAgent-<UIN>` 隐藏计划任务（只隐藏 Agent 控制台，不隐藏农场窗口）；
- 安装/更新 `FAR2Farm` NSSM 服务；
- 将 Provider targets 以 Base64 JSON 写入 NSSM `AppEnvironmentExtra`；
- 启用事件驱动 Code 刷新：`WS400` / kickout / 手动刷新立即处理，健康账号不做固定小时重登。

如果机器上已经存在已验收的单账号配置，安装器会优先复用这个 UIN 原来的端口、`tokenEnv` 和 token，不会因为升级多账号安装器而强制更换。

## 添加第二个及后续 QQ

1. 切换/登录到**另一个 Windows 用户 Session**。
2. 在该 Session 中只登录该 QQ，并打开过一次 QQ经典农场。
3. 确保该 QQ 在 FAR2 账号配置中已启用 `windows_session` Code 刷新。
4. 在这个 Windows 用户中再次右键管理员运行：

```text
install-windows-service.cmd
```

新版安装器是**增量注册**，不会再删除其他 `FAR2CodeAgent-*` 任务，也不会用当前 QQ 覆盖整个 Provider mapping。

它会：

- 如果多个 FAR2 QQ 都已启用，优先从**当前 Windows Session 的 QQ 进程注解**识别属于本 Session 的 UIN；
- 已有 UIN 保留原端口；
- 新 UIN 从 `43101-43199` 中选择尚未被其他 Provider target 占用的端口，通常第二个为 `43102`；
- token 环境变量按 `A`、`B`、`C`…递增分配；
- 合并 `FARM_CODE_PROVIDER_TARGETS_B64`，保留已注册的其他 QQ；
- 只重建当前 `FAR2CodeAgent-<UIN>` 计划任务；
- 重启一次 `FAR2Farm` 服务，让 LocalSystem 进程加载新的 target/token 环境。

如果当前 Session 无法唯一识别 UIN，安装器会 fail-closed，不会猜号。此时先在该 Windows 用户里打开一次 QQ经典农场；仍无法识别时可显式执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-far2-autostart.ps1 -Uin <完整QQ号>
```

`-AgentPort` 也可以显式指定；省略或为 `0` 时自动分配/复用。

## Code 刷新与窗口行为

Code Agent 保持原有 Session/UIN 隔离和事件驱动刷新逻辑。生产配置使用 `FARM_CODE_SCHEDULED_REFRESH=0` 时，健康账号不会按固定周期主动刷新；检测到 `WS400`、有效 kickout 或人工触发时才进入刷新链路。

窗口隐藏功能已经移除：

- 不再启动 `farm-window-cloak.ps1`；
- 不再高频枚举 QQ 进程或移动农场窗口到屏幕外；
- 不再提供 WebUI“窗口控制”页面/API；
- Code Agent 的隐藏计划任务只用于避免弹出命令行窗口，与 QQ 农场窗口无关。

## 查看状态

运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\status-far2-autostart.ps1
```

新版状态脚本会：

- 列出全部 `FAR2CodeAgent-*` 计划任务及所属用户；
- 解码 NSSM 中的全部 Provider targets；
- 对每个 target 分别检查监听端口；
- 使用服务端保存的对应 token 调 `/v1/health`；
- 校验 Agent 返回 UIN 是否与 target UIN 一致；
- 标出 Provider mapping 之外的 orphan Agent task；
- 不输出明文 Code 或 token。

## 卸载后台自启

管理员运行：

```text
uninstall-windows-service.cmd
```

当前卸载器仍表示“整机卸载”：移除 `FAR2Farm` 服务和全部 `FAR2CodeAgent-*` 计划任务，但不删除 FAR2 账号数据、Code 或 Web 配置。

## 当前验收边界

截至 2026-08-19：

- **单账号 Windows Session / 单 Agent Code 自动刷新：已验收。**
- **Code 刷新采用事件驱动模式；窗口隐藏功能已移除。**
- **多 target Provider 核心路由与防串号：代码已具备，自测覆盖 A/B 独立路由。**
- **增量多 Windows Session 安装/诊断：已实现，等待真实第二 QQ 环境验收。**
- 第二 QQ 尚未完成受控 E2E 与多周期无人值守 soak，因此不要把“安装器已支持”写成“第二账号已生产验收”。

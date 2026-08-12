# FAR2 Windows 后台自启

## 目标

安装后不再保留两个命令行黑框：

- FAR2 WebUI / CodeManager / worker 管理由 NSSM Windows 服务 `FAR2Farm` 后台运行；
- isolated Code Agent 由当前 Windows 用户登录时的隐藏计划任务运行；
- 用户平时只需要访问 `http://127.0.0.1:3007`，在网页里启动/停止农场账号。

## 为什么不是两个 NSSM 服务

主 FAR2 可以像 `LOLDataSystem` 一样运行在 LocalSystem / Session 0。

Code Agent **不能**改成 LocalSystem/NSSM Session 0。它必须与 QQ/QQEX 处于同一个交互式 Windows Session，原因是：

- Agent 的防串号边界包含 Windows SessionId；
- `tencent://` 必须交给当前用户已经登录的 QQ；
- QQEX 缓存在当前用户的 `%APPDATA%\QQEX`；
- Windows 服务 Session 0 与桌面用户 Session 隔离。

因此最终结构是：

```text
开机
  └─ NSSM: FAR2Farm (LocalSystem, Automatic, Restart)
       └─ WebUI / CodeManager / workers

用户登录 Windows
  └─ Scheduled Task: FAR2CodeAgent-<UIN> (Hidden, Interactive)
       ├─ isolated Code Agent :43101
       └─ Farm window cloak

QQ 保持登录
  └─ Code 失效/到期
       └─ Agent 临时拉起 QQ经典农场 -> qq.login() -> fresh Code -> 自动退出
```

## 安装前提

当前安装器针对第一条已验收的单账号隔离链：

- 当前 Windows 登录 Session 只运行目标 QQ；
- 只有这个账号设置为 `codeRefreshEnabled=true` / `windows_session`；
- QQ经典农场至少手动打开过一次，已有 QQEX 缓存；
- Node.js 已安装；
- NSSM 可用。

安装器按顺序寻找 NSSM：

1. `NSSM_EXE` 环境变量；
2. PATH 中的 `nssm.exe`；
3. FAR2 `tools\nssm-2.24\win64\nssm.exe`；
4. 已有 LOLDataSystem 使用的 `D:\project2\lolapisevers\tools\nssm-2.24\win64\nssm.exe`；
5. `C:\tools\nssm\win64\nssm.exe`。

## 一键安装

第一次安装前先关闭手工运行的：

- `pnpm dev:core` 黑框；
- `pnpm code:agent` 黑框。

然后右键管理员运行：

```text
install-windows-service.cmd
```

安装器会：

- 自动从 `core/data/accounts.json` 找到唯一启用 `windows_session` Code 刷新的 QQ；
- 复用已有 `FAR2_CODE_PROVIDER_TOKEN_A`，没有则生成并写入当前用户环境变量；
- 建立 exact UIN -> `127.0.0.1:43101` Provider 映射；
- 安装 `FAR2Farm` NSSM 服务；
- 设置 `Automatic`、LocalSystem、异常自动 Restart；
- 把主程序日志写入 `core/data/service.stdout.log` / `service.stderr.log`；
- 创建 `FAR2CodeAgent-<UIN>` 隐藏计划任务；
- Agent 在当前用户登录时自动启动，且不显示控制台窗口；
- 默认 Code 周期刷新为 60 分钟；`WS 400` 仍然立即触发刷新。

## 临时 QQ 农场窗口隐藏

QQ 小程序目前不能改造成真正无 UI 的“headless QQ runtime”，因为 `qq.login()` 必须运行在真实 QQ/QQEX 的交互 Session。

后台方案采用 **视觉隐藏**：

- `scripts/windows/farm-window-cloak.ps1` 跟随 Agent 在同一用户 Session 隐藏运行；
- 检测 QQ经典农场对应 QQEX mini-app 进程树；
- 把临时农场窗口移动到可见桌面之外并禁止抢焦点；
- QQ/QQEX 进程仍正常运行，所以 `qq.login()`、Code 捕获和 UIN 校验逻辑不变；
- fresh Code 获取后，小程序仍按 Agent 注入逻辑自动退出。

这是显示层处理，不降低 UIN / Windows SessionId 的防串号校验。

当前该窗口隐藏器属于新增实现，首次安装后需要观察一次真实 Code 刷新，确认当前 QQ 版本的窗口句柄能被正确识别。如果 QQ 后续修改小程序窗口实现，可将隐藏器关闭/调整，不影响 Provider 本身。

## 查看状态

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\status-far2-autostart.ps1
```

检查：

- `FAR2Farm` 是否 Running；
- `FAR2CodeAgent-*` 任务状态；
- WebUI 3007 是否 READY；
- Agent 43101 是否 LISTEN。

## 卸载后台自启

管理员运行：

```text
uninstall-windows-service.cmd
```

只移除 Windows 服务和 Agent 计划任务，不删除 FAR2 账号数据、Code、Web 配置。

## 多账号说明

当前一键安装器只接管当前已经真实验收的单 Windows Session / 单 QQ Agent。

第二个 QQ 后续仍应使用另一个 Windows 用户 Session 和另一个 Agent 端口（例如 43102）。不要为了让两个 QQ 共用一个桌面而取消 SessionId/UIN 防串号门槛。

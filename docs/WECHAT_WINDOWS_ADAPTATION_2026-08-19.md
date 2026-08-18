# FAR2 Windows 微信端适配（2026-08-19）

状态：**P0/P1/P2 已完成实机取证，进入 P2B 目标 AppId 确认**

## 目标

在不破坏现有 QQ 生产链的前提下，为 FAR2 增加 Windows 微信桌面端的农场账号登录/Code 获取与无人值守恢复能力。

目标架构原则：

- QQ 继续使用现有 `FAR2CodeAgent-<UIN>` / exact-UIN Provider；
- 微信单独形成自己的 Windows Session 边界，不复用 QQ 的身份判断；
- 优先利用用户已经登录的 Windows 微信桌面客户端；
- 不继续依赖旧 `127.0.0.1:8059/api` 第三方/本地代理模式作为正式生产方案；
- 不猜微信协议字段，不在未证明前发送登录/小程序写请求；
- 登录凭证、Cookie、Token 不进入诊断报告和 Git。

## 当前仓库已有基础

FAR2 已有：

- `web/src/components/WxLoginModal.vue`；
- `web/src/stores/wx-login.ts`；
- 账号保存支持 `platform: 'wx'`、`loginType: 'wx_qr'`、`wxid`；
- `store.js` 中有全局微信登录配置；
- 旧路径默认依赖 `http://127.0.0.1:8059/api`，通过 `LoginGetQRCar` / `LoginCheckQR` / `Wxapp/JSLogin` 获取 Code。

旧路径不能证明能利用当前已登录的 Windows 微信桌面端，因此不直接作为新方案继续扩展。

## P0 — Windows 桌面微信只读探针

首份实机报告确认：

- Windows 微信主程序为 `Weixin.exe`；
- 微信小程序运行时为 `WeChatAppEx.exe`；
- Runtime 来自 `%APPDATA%\Tencent\xwechat\XPlugin\Plugins\RadiumWMPF\...\runtime\WeChatAppEx.exe`；
- 微信与小程序运行在同一交互式 Windows Session（实机为 Session 1）；
- AppId `wx5306c5978fdb76e4` 确实出现在当前桌面微信农场运行目录；
- 实际 App 根目录：`%APPDATA%\Tencent\xwechat\radium\users\<profile>\applet\local\wx5306c5978fdb76e4`；
- 打开农场时 `launch.config`、`temp`、`usr` 会实时变化。

## P1 — 打开农场前后差分定位

实机报告通过 Gate：

- 唯一 profile：`713e2713509fdcbc61cfa2ee52bcbeb8`；
- 农场顶层窗口：`QQ经典农场` / `Chrome_WidgetWin_0`；
- 顶层窗口宿主：`WeChatAppEx.exe` PID `11544`；
- 打开农场后新增 `WeChatAppEx.exe` PID `29176`、`29960`；
- 两者父 PID 均为 `11544`、Session 1；
- PID `29960` 出现 `--wmpf-appid` 开关，29176 没有；
- `launch.config` 仅包含窗口尺寸/状态配置，不含登录 Code/Token。

当前最强进程证据链：

```text
Weixin.exe
  -> WeChatAppEx.exe 11544        # WMPF 主宿主 / 农场顶层窗口
       -> WeChatAppEx.exe 29960   # 打开农场后新增，且带 --wmpf-appid
       -> WeChatAppEx.exe 29176   # 打开农场后新增，renderer 辅助候选
```

## P2 — WMPF Runtime 结构与本地连接

实机报告确认：

- 农场窗口仍唯一锁定 PID `11544`；
- 该宿主树下有 8 个 renderer；
- PID `25400`、`29960` 都带 `wmpf-appid`，且 `wmpf-render-type=4`；
- PID `29176` 为 `wmpf-render-type=0`；
- network service 为 PID `12208` / `utility-sub-type=network.mojom.NetworkService`；
- PID `12208` 存在多条到 `127.0.0.1:7897` 的本地 TCP 连接；
- 当前证据不足以把 `7897` 判定为 WMPF IPC，必须先确认监听进程；
- 未发现 WMPF/WeChat/Applet 名称相关 named pipe；
- 当前扫描范围未命中 `wx.login` / `JSLogin` / AppId 等文本 marker；
- P2 的 `wmpf-appid` 值白名单过严，导致真实值被标记为 `[UNSAFE_VALUE_REDACTED]`，因此 `exactAppIdCandidateCount=0` 不能作为“没有目标 AppId renderer”的结论。

## P2B — 目标 AppId 精确确认

新增：

- `probe-wechat-farm-p2b.cmd`
- `scripts/windows/probe-wechat-farm-p2b.ps1`

P2B 不再输出其他小程序的 AppId 值，只做三态判断：

- `absent`：进程无 `wmpf-appid`；
- `target`：`wmpf-appid` 精确等于 `wx5306c5978fdb76e4`；
- `other`：存在 `wmpf-appid`，但不是目标农场 AppId，具体值不保存。

同时对候选进程的 loopback 远端端口查找本机监听者，仅保存：

- 端口；
- 监听 PID；
- 进程名；
- 可执行路径。

目的：确认 `PID 29960` 是否就是目标农场 renderer，并判断 `127.0.0.1:7897` 是 WMPF 自身组件还是本机其他网络/代理进程。

## 已修问题

- PowerShell 5.1 中文 UTF-8 解析问题：控制脚本使用 ASCII 文本；
- `$PID` 自动变量只读冲突：窗口枚举变量改为 `$windowProcessId`；
- runner 优先使用 `pwsh.exe`，无 PowerShell 7 才回退 5.1；
- 不再自动打开 Explorer；
- P2 AppId 白名单不再作为精确识别依据，改用 P2B 的“只比较目标值、不泄露其他值”方案。

## 安全边界

- 不读聊天数据库、聊天内容、联系人、附件正文；
- 不抓 Cookie/Token/登录 Code；
- 不保存原始进程命令行；
- 不保存公网远端连接；
- 不保存其他小程序 AppId 实际值；
- 不修改微信文件；
- 不发送未知微信/农场协议请求；
- 不影响现有 `FAR2Farm + FAR2CodeAgent-<UIN>` QQ 链。

## 完成标准

微信适配最终至少需要：

- 能添加 `platform=wx` 农场账号；
- Code 获取来源可证明；
- 微信账号与 QQ 账号严格隔离；
- 掉线后只恢复对应微信账号；
- 不要求浏览器保持打开；
- Windows 重启后可恢复；
- 不把微信敏感凭证输出到日志或 WebUI；
- 不影响当前 QQ `FAR2Farm + FAR2CodeAgent-<UIN>` 生产链。

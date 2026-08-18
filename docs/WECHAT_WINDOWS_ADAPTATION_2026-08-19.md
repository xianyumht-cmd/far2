# FAR2 Windows 微信端适配（2026-08-19）

状态：**P0-P3B 已完成实机 Gate，P4 端到端 `platform=wx` 网关登录 Gate 已就绪，等待实机执行**

## 目标

在不破坏现有 QQ 生产链的前提下，为 FAR2 增加 Windows 微信桌面端的农场账号登录、fresh Code 获取与无人值守恢复能力。

最终原则：

- QQ 继续使用现有 `FAR2CodeAgent-<UIN>` / exact-UIN Provider；
- 微信单独形成自己的 Windows Session / Provider 边界，不伪造成 QQ UIN；
- 优先利用用户已经登录的 Windows 微信桌面客户端；
- 不继续依赖旧 `127.0.0.1:8059/api` 作为正式生产方案；
- 原始登录 Code 只在刷新链内短暂存在，不进普通日志、JSON、Git、命令行；
- 在 Code 与网关登录链实机证明前，不接未知协议写操作；
- PR 在 P4 通过前保持 Draft，不合并 `main`。

## 当前 FAR2 已有基础

仓库本身已经具备一部分微信账号 plumbing：

- `web/src/components/WxLoginModal.vue`；
- `web/src/stores/wx-login.ts`；
- 账号模型可保存 `platform: 'wx'`、`loginType: 'wx_qr'`、`wxid`；
- `worker-manager` 会把 `account.platform` 发送给 Worker；
- Worker 会把平台写入 `CONFIG.platform`；
- 网络层会把平台带入 WebSocket URL。

真正缺口不是农场业务协议，而是：

1. Windows 微信如何稳定生成 fresh Code；
2. CodeManager 如何把微信账号与 QQ exact-UIN 链分开管理；
3. 微信 Code 失效后如何只恢复对应微信账号。

## P0-P2 — Windows 微信运行时定位

已实机确认：

- Windows 微信主程序：`Weixin.exe`；
- 小程序运行时：`WeChatAppEx.exe`；
- WMPF：`25297`；
- 农场窗口：`QQ经典农场` / `Chrome_WidgetWin_0`；
- 实机交互式 Windows Session：`1`；
- 农场本地 applet 标识：`wx5306c5978fdb76e4`；
- applet 根目录位于 `%APPDATA%\Tencent\xwechat\radium\users\<profile>\applet\local\wx5306c5978fdb76e4`；
- 农场窗口宿主是持久 WMPF host，打开小程序会在其下创建/复用 renderer；
- `launch.config` 只有窗口尺寸/显示状态等配置，不是 Code 来源；
- `127.0.0.1:7897` 已排除为微信/WMPF IPC；
- `--wmpf-appid=preload-*` 不是实际农场 AppId。

## P3 — WMPF CDP Gate

P3 使用固定版本的 WMPFDebugger + 临时 CDP Bridge，仅做运行时能力证明。

实机 Gate 已通过：

- 能进入 `https://servicewechat.com` 的微信小程序 JS execution context；
- 目标 context 内存在 `globalThis.wx`；
- 存在 `wx.login`；
- 不需要旧 8059 API 才能访问当前桌面微信的小程序运行时。

## P3B — 精确 AppId + `wx.login` Code Gate

P3B 先调用 `wx.getAccountInfoSync()` 识别 context，仅当 AppId 精确等于：

```text
wx5306c5978fdb76e4
```

才允许继续调用一次 `wx.login`。

实机结果已经通过：

- 目标 AppId context：命中；
- 环境：`release`；
- 当前微信农场版本：`1.13.2.7`；
- `wx.login`：成功；
- Code 长度：`32`；
- `gatePassed=true`；
- 原始 Code 未打印、未写 JSON、未写 Git。

因此“Windows 桌面微信能否为当前农场生成官方 fresh Code”已经证明，不再重复 P3/P3B。

## P4 — FAR2 `platform=wx` 端到端登录 Gate

新增：

- `probe-wechat-farm-p4-e2e.cmd`
- `scripts/windows/probe-wechat-farm-p4-e2e.ps1`
- `core/scripts/wechat-p4-e2e-login.js`

P4 的目的只有一个：

> 证明由当前 Windows 微信 `wx.login` 产生的 fresh Code，能被 FAR2 当前网关协议以 `platform=wx` 完成一次正式 Login。

流程：

1. 检查当前 WMPF 仍为 `25297`；
2. 复用 P3 已固定提交的 WMPFDebugger；
3. 要求先关闭农场小程序窗口，但保持桌面微信登录；
4. 启动临时 CDP Bridge；
5. 重新打开 `QQ经典农场`；
6. 用 `wx.getAccountInfoSync()` 精确锁定 `wx5306c5978fdb76e4`；
7. 从目标 context 读取当前小程序版本；
8. 只调用一次 `wx.login`；
9. fresh Code 只保存在同一个 Node 进程内存；
10. 立即向 FAR2 当前网关发送一次 `platform=wx` Login；
11. 收到 Login Reply 后立即关闭连接；
12. 不启动心跳、农场循环、好友循环、背包读取或任何写操作。

P4 当前采用：

- URL `platform=wx`；
- `os=iOS`，保持与 FAR2 当前登录体兼容；
- `clientVersion` 不写死为 QQ 的 `1.13.0.5_20260729`，而是从当前目标微信农场 `wx.getAccountInfoSync()` 动态读取；
- 预期当前实机版本为 `1.13.2.7`。

P4 报告只保存：

- context 数量；
- 精确目标 AppId 是否命中；
- 小程序版本；
- Code 长度；
- 网关是否连接；
- 是否收到 Login response；
- LoginReply 是否可解码；
- 是否存在 basic/gid；
- 数字错误码与已脱敏错误文本。

不会保存：

- 原始 Code；
- Cookie / Token；
- 原始网络 payload；
- 聊天内容；
- 其他小程序真实 AppId。

### P4 Gate 通过标准

报告需要同时满足：

```text
summary.wxLoginSuccess = true
summary.gatewayConnected = true
summary.gatewayResponseReceived = true
summary.loginReplyDecoded = true
summary.basicPresent = true
summary.gidPresent = true
summary.gatePassed = true
```

如果 P4 失败，不做盲目重试。根据报告里的网关错误码、LoginReply 解码结果和版本信息，针对性修正 `platform/os/clientVersion/device_info` 中的具体差异。

## P4 通过后的生产结构

目标结构：

```text
FAR2 CodeManager
  ├─ platform=qq
  │    └─ FAR2CodeAgent-<UIN>
  │         └─ QQ exact-UIN Session
  │              └─ qq.login -> fresh Code
  │
  └─ platform=wx
       └─ FAR2WeChatAgent
            └─ Windows WeChat interactive Session
                 └─ exact farm AppId context
                      └─ wx.login -> fresh Code
```

微信生产 Agent 不会直接复制 QQ Agent 的身份模型。微信至少应绑定：

- `platform=wx`；
- Windows Session ID；
- 当前微信 profile/runtime；
- 精确农场 AppId `wx5306c5978fdb76e4`。

CodeManager 后续改造要求：

- QQ 继续做 `account UIN == bound QQ UIN`；
- 微信不要求 QQ UIN；
- QQ/微信分别选 Provider；
- WS400/Code 失效时只刷新发生故障的账号；
- fresh Code 成功后才替换对应 Worker；
- 不因为微信适配修改 QQ 的生产 clientVersion。

## WebUI 收口方向

P4 通过、Agent 稳定后再做：

- 将现有微信入口从“依赖 8059 扫码 API”迁移为“使用当前已登录 Windows 微信”；
- 保留 `platform=wx` 账号模型；
- 展示微信 Runtime/Agent 可用状态，但不展示 Code；
- 旧 8059 配置降级为兼容/迁移入口，不作为默认生产路径。

## 完成标准

微信适配最终至少需要：

- 能添加并运行 `platform=wx` 农场账号；
- fresh Code 来源可证明且可自动刷新；
- 微信账号与 QQ 账号严格隔离；
- 掉线后只恢复对应微信账号；
- 不要求浏览器保持打开；
- Windows 重启后可恢复；
- 不把微信敏感凭证输出到日志或 WebUI；
- 不影响当前 QQ `FAR2Farm + FAR2CodeAgent-<UIN>` 生产链。

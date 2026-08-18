# FAR2 Windows 微信端适配（2026-08-19）

状态：**P0/P1 已完成实机取证，进入 P2 运行时入口定位**

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

这套旧路径不能证明能利用当前已登录的 Windows 微信桌面端，因此不直接作为新方案继续扩展。

## P0 — Windows 桌面微信只读探针

新增：

- `probe-wechat-farm.cmd`
- `scripts/windows/probe-wechat-farm.ps1`

首份实机报告已经确认：

- Windows 微信主程序为 `Weixin.exe`；
- 微信小程序运行时为 `WeChatAppEx.exe`；
- Runtime 位于 `%APPDATA%\Tencent\xwechat\XPlugin\Plugins\RadiumWMPF\...\runtime\WeChatAppEx.exe`；
- 微信与小程序运行在同一交互式 Windows Session（实机为 Session 1）；
- 农场 AppId 为 `wx5306c5978fdb76e4`；
- 实际 App 根目录为 `%APPDATA%\Tencent\xwechat\radium\users\<profile>\applet\local\wx5306c5978fdb76e4`；
- 打开农场时 `launch.config`、`temp`、`usr` 会实时变化；
- 同一微信主进程下会存在多个 `WeChatAppEx.exe`，不能仅凭进程名绑定农场实例。

P0 还修复了 Windows PowerShell 5.1 下 SessionId 汇总丢失问题。

## P1 — 打开农场前后差分定位

新增：

- `probe-wechat-farm-p1.cmd`
- `scripts/windows/probe-wechat-farm-p1.ps1`

P1 实机报告（2026-08-19 04:40 +08:00）已经通过 Gate：

- profile 唯一命中 `713e2713509fdcbc61cfa2ee52bcbeb8`；
- 农场顶层可见窗口唯一命中：标题 `QQ经典农场`、Class `Chrome_WidgetWin_0`；
- 农场顶层窗口由 `WeChatAppEx.exe` PID `11544` 持有；
- 打开农场后新增两个 `WeChatAppEx.exe`：PID `29176`、`29960`；
- 两者父 PID 都是 `11544`，SessionId 都是 `1`；
- PID `29960` 的启动参数中明确出现 `--wmpf-appid`，PID `29176` 没有；
- `launch.config` 在打开农场后实时修改，格式为 JSON，内容仅是窗口尺寸/状态配置，没有 Code/Token；
- P1 采集窗口内农场目录只有两个文件变化：`launch.config` 修改、`temp` 下 JPEG 新建。

当前最强进程关系证据：

```text
Weixin.exe
  -> WeChatAppEx.exe 11544        # WMPF 主宿主 / 农场顶层窗口
       -> WeChatAppEx.exe 29960   # 带 --wmpf-appid 的 renderer 候选
       -> WeChatAppEx.exe 29176   # 另一 renderer/辅助候选
```

因此 P1 不再重复执行。

P1 过程中发现并修复：

- PowerShell 自动变量 `$PID` 只读，窗口枚举变量改为 `$windowProcessId`；
- `.cmd` 现在优先调用 `pwsh.exe`，没有 PowerShell 7 才回退 `powershell.exe`；
- 探针不再自动启动 Explorer。

## P2 — 农场 renderer / 本地运行时入口定位

新增：

- `probe-wechat-farm-p2.cmd`
- `scripts/windows/probe-wechat-farm-p2.ps1`

P2 不再需要关闭/重新打开农场。使用时保持：

1. Windows 微信已登录；
2. `QQ经典农场` 小程序窗口保持打开；
3. 运行 `probe-wechat-farm-p2.cmd`；
4. 上传 `%TEMP%\FAR2-WeChat-Probe\wechat-farm-p2-*.json`。

P2 只做以下只读取证：

- 通过 `QQ经典农场` 顶层窗口锁定 WMPF 主宿主 PID；
- 建立该宿主的 `WeChatAppEx.exe` 子进程树；
- 从原始命令行本地解析，但报告中只保存白名单参数值：
  - `wmpf-appid`
  - `type`
  - `wmpf-render-type`
  - `instance-index`
  - `client_version`
  - `product-id`
  - `service-sandbox-type`
  - `utility-sub-type`
- 尝试唯一确认 `wmpf-appid=wx5306c5978fdb76e4` 的 renderer；
- 只记录这些候选 PID 的 `127.0.0.1` / `::1` 本地 TCP/UDP 端点，不记录公网远端连接；
- 只枚举名称中含 `WMPF/WeChat/Weixin/Applet/MiniProgram` 的 named pipe 名称，不读取 pipe 内容；
- 只在农场 App 专属目录及最近 30 分钟 `applet\codecache` 中统计以下关键词是否命中：
  - `wx5306c5978fdb76e4`
  - `wx.login`
  - `JSLogin`
  - `LoginGetQRCar`
  - `LoginCheckQR`
- 关键词扫描只保存文件路径、大小、时间和命中次数，不保存文件正文或上下文片段。

P2 Gate：

- 若 `wmpf-appid` 能唯一落到某个 renderer，并存在可用 loopback/pipe 入口，下一阶段优先验证官方 WMPF 本地 IPC；
- 若没有本地端口/可识别 pipe，但 codecache 明确命中 `wx.login`，下一阶段只围绕该农场 renderer 的 `wx.login` 调用链做最小化运行时观察；
- 若两者都没有证据，不直接注入/伪造登录请求，继续补充只读证据。

## 安全边界

所有 P0/P1/P2 探针均明确不做：

- 读取聊天数据库；
- 读取聊天内容/联系人/聊天附件正文；
- 捕获 Cookie / Token / refresh token / 登录 Code；
- 保存原始进程命令行；
- 保存公网远端连接；
- 修改微信文件；
- 主动发送未知微信/农场登录请求。

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

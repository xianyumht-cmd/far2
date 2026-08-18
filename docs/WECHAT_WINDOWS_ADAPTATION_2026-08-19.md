# FAR2 Windows 微信端适配（2026-08-19）

状态：**P0 已完成实机取证，进入 P1 差分定位**

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

首份实机报告（2026-08-19）已经确认：

- Windows 微信主程序为 `Weixin.exe`；
- 微信小程序运行时为 `WeChatAppEx.exe`；
- `WeChatAppEx.exe` 来自 `%APPDATA%\Tencent\xwechat\XPlugin\Plugins\RadiumWMPF\...\runtime\WeChatAppEx.exe`；
- 微信与小程序运行在同一交互式 Windows Session（实机为 Session 1）；
- FAR2 旧微信 AppId `wx5306c5978fdb76e4` 确实出现在当前桌面微信农场运行目录，而不是历史误配置；
- 已确认实际 App 根目录形态：`%APPDATA%\Tencent\xwechat\radium\users\<profile>\applet\local\wx5306c5978fdb76e4`；
- 打开农场时该目录下的 `launch.config`、`temp`、`usr` 文件会发生实时变化；
- 同一微信主进程下面会存在多个 `WeChatAppEx.exe`，因此不能仅凭进程名选择农场实例，必须做打开农场前后的差分定位。

P0 还发现 Windows PowerShell 5.1 下 `OrderedDictionary | Select-Object -ExpandProperty sessionId` 会导致汇总 SessionId 丢失，现已改为显式索引读取。

P0 明确不读取：

- 聊天数据库；
- 聊天内容；
- 联系人内容；
- 用户文件/附件内容；
- Cookie / Token / refresh token / Code；
- 微信数据库正文。

## P1 — 打开农场前后差分定位

新增：

- `probe-wechat-farm-p1.cmd`
- `scripts/windows/probe-wechat-farm-p1.ps1`

流程：

1. 保持微信电脑版登录；
2. 先关闭农场小程序窗口，但不要退出微信；
3. 运行 `probe-wechat-farm-p1.cmd` 并记录基线；
4. 按提示从微信电脑版重新打开 QQ经典农场；
5. 等主页完全加载后按 Enter；
6. 上传生成的 `%TEMP%\FAR2-WeChat-Probe\wechat-farm-p1-*.json`。

P1 只针对已确认的农场 AppId 做：

- 打开前/打开后的 `Weixin.exe` / `WeChatAppEx.exe` PID 差分；
- SessionId、父子进程关系；
- 只保存命令行里的开关名称、AppId 是否出现、32 位 profile 标识，不保存原始命令行；
- 枚举微信相关顶层窗口的 PID、标题、窗口类和矩形，定位农场窗口所有者；
- 对农场 App 专属目录做文件元数据差分；
- 只读取农场目录自己的 `launch.config`，JSON 内容会对 token/ticket/cookie/session/auth/key/code/openid/unionid 等敏感字段自动脱敏；
- 不读取聊天目录和微信消息数据库。

P1 的 Gate：

- 如果能唯一识别承载农场的 `WeChatAppEx.exe`，下一步建立 Windows Session scoped 微信 Farm Agent；
- 如果 `launch.config`/进程参数能证明运行入口但不能得到登录 Code，下一步只在该农场进程/该 AppId 范围内做运行时只读观察；
- 在 Code 来源被证明前，FAR2 不主动伪造微信登录请求，也不接第三方 8059 API 作为正式方案。

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

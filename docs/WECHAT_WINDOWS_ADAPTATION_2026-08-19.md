# FAR2 Windows 微信端适配（2026-08-19）

状态：**P0 只读环境取证进行中**

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

使用前：

1. Windows 微信保持登录；
2. 在微信里手动打开一次 QQ经典农场并保持小程序窗口打开；
3. 双击 `probe-wechat-farm.cmd`；
4. 将生成的 `%TEMP%\FAR2-WeChat-Probe\wechat-probe-*.json` 用于后续分析。

探针仅收集：

- WeChat / Weixin / WMPF / MiniProgram 相关进程名称、PID、父 PID、SessionId、可执行文件路径；
- 若干微信候选运行目录是否存在；
- 小程序/插件/运行时相关目录名；
- 最近一段时间内相关运行时文件的路径、大小和更新时间；
- 当前 FAR2 旧配置 AppId `wx5306c5978fdb76e4` 是否直接出现在运行时路径中。

明确不读取：

- 聊天数据库；
- 聊天内容；
- 联系人内容；
- 用户文件/附件内容；
- Cookie / Token / refresh token / Code；
- 微信数据库正文。

## 后续 Gate

P0 报告出来后才能决定 P1，不提前假设微信桌面端内部结构。

P1 候选方向按证据选择：

1. 若农场小程序存在独立 WMPF/WeChatAppEx 进程和稳定 AppId 标识：建立 Windows Session scoped 微信 Agent；
2. 若 Code/小程序身份可通过官方运行时只读观察得到：做本地 Provider；
3. 若只能发现运行时但不能证明 Code 来源：增加一次官方客户端行为取证工具，仍不让 FAR2 主动发送未知写协议；
4. 若当前 Windows 微信根本不暴露可安全复用的本地登录能力，再评估是否保留扫码方案，但不默认回退到第三方 8059 API。

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

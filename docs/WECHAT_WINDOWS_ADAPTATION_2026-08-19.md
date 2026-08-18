# FAR2 Windows 微信端适配（2026-08-19）

状态：**P0-P3B 已通过；P4 两次均在 Login 首帧后被关闭；P4B 正在做官方握手元数据对照**

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

## 已证明基础

P0-P3B 已实机确认：

- Windows 微信主程序：`Weixin.exe`；
- 小程序运行时：`WeChatAppEx.exe`；
- WMPF：`25297`；
- 农场 AppId：`wx5306c5978fdb76e4`；
- 可进入 `https://servicewechat.com` JS context；
- `wx.getAccountInfoSync()` 可精确锁定目标农场；
- 当前微信农场版本：`1.13.2.7`；
- 官方 `wx.login` 成功，fresh Code 长度 `32`；
- 原始 Code 未打印、未写 JSON、未写 Git。

因此 Windows 微信 fresh Code 来源已经证明，不再重复 P3/P3B。

## P4 — FAR2 `platform=wx` E2E Login Gate

两次实机结果一致：

```text
wxLoginSuccess=true
codeLength=32
clientVersion=1.13.2.7
gatewayConnected=true
loginRequestSent=true
gatewayResponseReceived=false
loginReplyDecoded=false
Gateway closed before Login response
```

第一次曾怀疑 P4 的 LoginReply 监听器安装晚于首帧发送，可能漏掉快速响应；加入 race guard 后第二次仍完全相同，因此该解释已排除。

当前可确认：

- TCP/TLS/WebSocket 握手成功；
- fresh Code 已进入 FAR2 P4 进程；
- FAR2 Login frame 已发送；
- 问题发生在发送第一条 Login frame 之后；
- 当前不能证明具体是 `platform/os/ver/header/openID/device_info` 中哪一项不同。

不再盲改参数，也不再重复 P4，先做官方握手元数据对照。

## P4B — 官方微信农场 WebSocket 握手元数据对照

文件：

- `probe-wechat-farm-p4b-handshake.cmd`
- `scripts/windows/probe-wechat-farm-p4b-handshake.ps1`
- `core/scripts/wechat-p4b-handshake-metadata.js`
- `core/scripts/wechat-p4b-network-arm.js`

目标仅观察官方农场自身建立的：

```text
wss://gate-obt.nqf.qq.com/prod/ws
```

只持久化：

- host/path；
- query key 名称；
- `platform` / `os` / `ver`；
- `code` 是否存在与长度，不保存原值；
- `openID` 是否存在与长度，不保存原值；
- 非敏感 header 名称；
- `Origin` / `User-Agent` / `Referer` / `Sec-WebSocket-Protocol` 白名单值；
- 握手 HTTP 状态（若可见）。

不持久化 Code/openID/Cookie/Authorization/WebSocket frame payload。

### P4B 第一次执行失败原因

第一次 P4B 在农场尚未打开时执行：

```text
Network.enable
```

并超时。

检查固定提交的 WMPFDebugger 后确认：CDP proxy 只会把 `proxymessage` 转发给**当前已经连接到 9421 debug server 的 miniapp client**；如果农场还没打开、没有 miniapp debug client，命令会被直接丢弃，不会排队。因此这不是 Windows 微信不支持 `Network` 的证据，而是 P4B 的启动时序错误。

### P4B Network arm 修复

新增 `wechat-p4b-network-arm.js`，runner 通过 Node `--require` 预加载。

行为：

1. P4B 仍先连接本地 `62000` CDP proxy；
2. 对首个 `Network.enable` 在当前 Node 进程内返回一个仅用于解除等待的 synthetic ACK；
3. 同时每 25ms 重新向本地 CDP proxy 发送真实 `Network.enable`；
4. 用户此时可以打开农场；
5. 一旦 WMPF miniapp debug client 连接，下一次真实 `Network.enable` 会被转发；
6. 收到真实 CDP response 后自动停止重试；
7. synthetic ACK 不离开本机 Node 进程，不修改微信/WMPF，不产生农场协议请求。

这样可以在 miniapp 启动初期尽快打开 Network domain，而不是在农场未连接时把唯一一条命令丢掉。

## P4B 判定

- 若捕获到官方目标握手：和 P4 当前 `platform=wx / os=iOS / ver=1.13.2.7 / Origin / User-Agent / openID` 逐项比较，只修真实差异，再进行一次最终 P4。
- 若没有捕获到目标握手：不据此断言官方没有使用该网关；改做目标 AppId context 内的 socket API 元数据观察，不扩大到 frame payload。
- P4 真正通过后才开始 `FAR2WeChatAgent` 与 CodeManager 双平台 Provider 接入。

## 生产结构目标

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

QQ 生产链、QQ clientVersion 与 exact-UIN 规则保持不动。

## 安全边界

- 不读聊天数据库、聊天内容、联系人、附件正文；
- 不抓 Cookie / 长期 Token / refresh token；
- raw Code 不打印、不写报告、不进命令行；
- 不持久化 WebSocket frame payload；
- 不修改微信聊天文件；
- 不向未知农场 RPC 发送猜测写请求；
- PR 继续保持 Draft，P4 E2E 通过前不合并 main。

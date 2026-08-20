# FAR2 Windows 微信：P4 Gate 通过与 P5 生产基础

日期：2026-08-19

## P4 实机结论

最新实机报告 `wechat-farm-p4-e2e-20260819-073035.json` 已通过完整 Gate：

- WMPF：`25297`
- 目标 AppId：`wx5306c5978fdb76e4`
- `wx.login`：成功
- Code 长度：`32`
- WebSocket：连接成功
- Gateway Login response：收到
- `errorCode=0`
- `LoginReply`：解码成功
- `basic`：存在
- `gid`：存在
- 实机账号等级：`48`
- `gatePassed=true`

最终已证明的 Windows 微信网关 profile：

```text
platform=wx
os=Windows
ver=1.13.2.7_20260723
code=<fresh wx.login Code>
openID query key=absent
Origin=https://gate-obt.nqf.qq.com
UA=Chrome144 + UnifiedPCWindowsWechat + XWEB/25297
```

同时 P4 的 LoginRequest/Heartbeat 客户端版本仍使用小程序版本 `1.13.2.7`。也就是说，Windows 微信链中：

- Gateway URL `ver` 使用带构建日期的 `1.13.2.7_20260723`；
- LoginRequest/Heartbeat `client_version` 使用 `1.13.2.7`。

这一差异已经由实机端到端登录验证，不能把二者合并成同一个版本字段。

## P5 生产基础已加入

### 1. Worker 网关 profile

新增：

- `core/src/services/wechat-gateway-profile.js`
- `core/src/core/worker-bootstrap.js`

作用：

- 只对 `wss://gate-obt.nqf.qq.com/prod/ws` 且 `platform=wx` 的连接生效；
- 自动改为 `os=Windows`；
- Gateway `ver` 默认使用 `1.13.2.7_20260723`；
- 删除 `openID/openid` query key；
- 对齐当前 WMPF 25297 的官方 Origin / User-Agent；
- 同时把 Worker 的 `CONFIG.clientVersion` 保持为 `1.13.2.7`，用于 LoginRequest/Heartbeat；
- QQ 连接不进入该 profile，现有 QQ 网关参数不改。

支持后续通过环境变量覆盖：

- `FARM_WECHAT_CLIENT_VERSION`
- `FARM_WECHAT_GATEWAY_VERSION`
- `FARM_WECHAT_USER_AGENT`
- `FARM_WECHAT_GATEWAY_ORIGIN`

### 2. Windows 微信 Provider 合同

新增：

- `core/src/services/wechat-runtime-code-provider.js`

默认 Provider endpoint：

```text
http://127.0.0.1:43201/
```

接口：

```text
GET  /v1/health
POST /v1/code/refresh
```

Provider 强制校验：

- `platform=wx`
- `appId=wx5306c5978fdb76e4`
- Bearer Token
- loopback HTTP 默认允许；远程默认必须 HTTPS
- raw Code 只从认证后的 refresh response 返回，不进入普通日志

Provider 可以同时返回：

- `clientVersion`
- `gatewayVersion`
- `windowsSessionId`
- `wmpfVersion`
- `profileId`
- `appId`

这些字段用于后续无人值守恢复时同步当前微信 Runtime 信息。

### 3. 微信恢复管理器

新增：

- `core/src/services/wechat-recovery-manager.js`

它与现有 QQ `CodeManager` 分开运行，原因是 QQ 的 exact-UIN 身份模型不能套到微信。

当前微信账号进入自动恢复需要：

```text
platform=wx
codeRefreshEnabled=true
codeRefreshMode=windows_wechat
```

恢复顺序：

1. 先向 WeChat Provider 获取 fresh Code；
2. fresh Code 成功后才停止旧 Worker；
3. 保存 fresh Code 和微信版本/Session 元数据；
4. 只重启该微信账号 Worker；
5. Provider 失败时不先停旧 Worker；
6. `ws_400` 或非版本类 kickout 只触发对应微信账号刷新。

现有 QQ `CodeManager` 仍只管理 `platform=qq`，因此微信适配不会改变 QQ exact-UIN Provider 的判断逻辑。

### 4. FAR2WeChatAgent 服务边界

新增：

- `core/src/services/wechat-code-agent.js`

已经固定 Agent HTTP 边界、安全要求和返回格式：

- 默认 `127.0.0.1:43201`
- Bearer Token 最少 24 字符
- `/v1/health` 不返回 Code
- `/v1/code/refresh` 只有认证后才允许返回 fresh Code
- refresh 单飞，避免同一微信 Runtime 并发调用多次 `wx.login`
- 不把 Code 写普通日志

当前还没有把 P3/P4 使用的临时 WMPFDebugger 直接塞进生产 Agent。生产 capture backend 继续按 FAR2 自身实现推进，避免把诊断用第三方桥接器变成最终运行时依赖。

### 5. 自检

新增：

- `core/scripts/wechat-production-foundation-selftest.js`
- `scripts/windows/test-wechat-production-foundation.ps1`
- `test-wechat-production-foundation.cmd`

自检覆盖：

- 微信 Gateway profile 参数重写；
- `openID` 删除；
- QQ gateway 不被修改；
- 微信 refresh 成功后只替换微信 Worker；
- QQ 对照账号不被改动。

## 仍未完成

P4 已证明 Code + FAR2 网关登录链可用，因此不再需要继续 P4/P4B 探针。

现在剩下的核心是 **FAR2-native Windows 微信 capture backend**：

```text
已登录 Windows 微信
  -> 定位交互式 Session / WMPF 25297
  -> 必要时启动/重启农场 Runtime
  -> 精确锁定 wx5306c5978fdb76e4
  -> wx.login
  -> fresh Code 仅交给 FAR2WeChatAgent
  -> WeChat Provider
  -> WeChatRecoveryManager
  -> 对应 platform=wx Worker
```

生产 backend 完成前，PR 继续保持 Draft，不合并 `main`。

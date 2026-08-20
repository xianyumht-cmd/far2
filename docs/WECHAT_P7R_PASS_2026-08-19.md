# FAR2 Windows 微信 P7R 实机通过（2026-08-19）

## 结论

P7R `wechat-p7r-resident-session-recovery-gate` 已在真实 Windows 微信 / QQ经典农场环境完整通过。

报告：`wechat-resident-recovery-gate-20260819-093837.json`

核心结果：

```text
residentBootstrapSucceeded=true
ws400RecoveryWithoutManualAction=true
targetWxWorkerOnlyRestarted=true
qqControlUntouched=true
gatewayLoginSucceeded=true
gatePassed=true
```

## 已证明链路

一次 bootstrap 仍需要用户在 FAR2-native WMPF hook armed 后手动打开一次 QQ经典农场；从 exact AppId context 建立并驻留后，恢复阶段无需人工操作：

```text
scoped ws_400
 -> resident wx.login fresh Code
 -> FAR2WeChatAgent
 -> authenticated loopback Provider
 -> WeChatRecoveryManager
 -> only target WeChat worker stop/start
 -> QQ account / QQ worker untouched
 -> recovered Code gateway Login
```

实机数据：

- WMPF host PID：11544
- exact AppId context：已选中
- mini-game clientVersion：`1.13.2.7`
- fresh Code 长度：32
- 微信 worker stop/start：`1/1`
- QQ worker stop/start：`0/0`
- Gateway connected：true
- Login response received：true
- `errorCode=0`
- LoginReply decoded：true
- `basicPresent=true`
- `gidPresent=true`
- level：48

## 安全边界实机确认

```text
rawLoginCodePersisted=false
rawLoginCodePrinted=false
rawLoginCodeInCommandLine=false
thirdPartyDebuggerCheckoutUsed=false
far2OwnsRemoteDebugProtocol=true
tokenOrCookieCaptured=false
websocketPayloadCaptured=false
realFarmWorkerAutomationStarted=false
heartbeatStarted=false
farmWriteStarted=false
gatewayLoginAttempts=1
```

## 当前产品边界

P7R 证明的是 **驻留 Session 下的自动恢复**：只要 FAR2WeChatAgent 与目标农场 runtime 已经建立 resident context，Code 失效 / `ws_400` 后可以自动获取 fresh Code，并只重启对应微信 worker，不影响 QQ。

尚未证明的是 Windows 微信或农场完全冷启动后的“自动重新打开 QQ经典农场”。现有证据显示目标更接近 mini-game/runtime 形态：

- exact AppId 本地目录已定位；
- `launch.config` 会实时更新，但没有可证明的明文 route；
- exact runtime context 中 `wx.getLaunchOptionsSync().path`、`wx.getEnterOptionsSync().path`、`getCurrentPages().route` 均为空；
- 因此不继续猜 `pages/...` 页面 path。

冷启动拉起作为独立增强，不再阻塞 resident recovery 的生产化。

## 下一阶段

P8 进入生产化，而不是继续协议探针：

1. 把 P7R 中已证明的 resident capture 抽成正式 `FAR2WeChatAgent` backend；
2. Agent 运行在当前交互 Windows Session，FAR2Farm 继续运行在 Session 0；
3. loopback Provider 使用固定认证配置，不把 raw Code 写入磁盘/日志；
4. WebUI 增加 Windows 微信 resident 状态与“需要手动打开一次农场”的明确状态；
5. 做最终生产 Gate：真实保存的 `platform=wx` 账号触发 `ws_400`，验证真实 worker 替换与 QQ worker 隔离；
6. P8 通过后再评估 PR #55 是否 ready/merge；冷启动自动拉起可作为后续独立 PR。

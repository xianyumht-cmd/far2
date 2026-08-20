# Windows 微信 P8 Resident Agent 生产化基础

日期：2026-08-19

## 已证明前提

P7R 实机 Gate 已通过：在 FAR2-native WMPF 已 bootstrap 且农场 runtime 驻留的情况下，`ws_400 -> wx.login fresh Code -> FAR2WeChatAgent -> authenticated loopback Provider -> WeChatRecoveryManager -> 仅重启目标微信 Worker -> Gateway Login` 全链无人值守成功；QQ 对照账号和 Worker 未被修改。

## 本阶段变化

P8 不再新增协议探针，而是把 P7R Gate 内部的 resident capture 抽成正式产品模块：

- `core/src/services/wechat-wmpf-resident-capture.js`
  - FAR2 自持 WMPF remote-debug 协议；
  - 常驻 `127.0.0.1:9421` debug bridge；
  - 精确筛选 `wx5306c5978fdb76e4`；
  - runtime 连接后自动选择 exact context；
  - Provider 请求时才调用一次 `wx.login`；
  - runtime 断开后回到 `waiting_bootstrap`，不会猜 launch path；
  - 不使用 WMPFDebugger checkout。

- `core/scripts/wechat-resident-agent.js`
  - 正式 `FAR2WeChatAgent` runner；
  - capture backend 与 `wechat-code-agent` 组合；
  - 只监听 loopback；
  - raw Code 不写日志；
  - 运行时输出 `waiting_bootstrap / resident_connected / disconnected` 状态。

- `scripts/windows/start-wechat-resident-agent.ps1`
- `start-wechat-resident-agent.cmd`
  - 一键准备持久化的 isolated dependencies；
  - Agent/Provider 共享随机认证 token；
  - machine 环境写入 `FARM_WECHAT_CODE_PROVIDER_URL/TOKEN` 与 `FAR2_WECHAT_AGENT_TOKEN/PORT`，供 Session 0 的 `FAR2Farm` 在下次启动时读取；
  - token 不打印到控制台。

## FAR2Farm / Web API 生产桥

`core/client.js` 现在对微信恢复做独立路由：

- QQ 仍走原 exact-UIN `CodeManager`；
- `platform=wx` + `windows_wechat` 走 `WeChatRecoveryManager`；
- `/api/code-manager/config` 对微信账号可启用/关闭 `windows_wechat`；
- `/api/code-manager/refresh` 对微信账号触发微信 Provider，不落到 QQ Provider；
- `/api/code-manager/status` 合并 QQ 与微信状态，但保持两套 manager 独立；
- 每 5 秒从 authenticated loopback Provider 更新微信 Agent health cache；
- Agent 未 bootstrap/断开时微信账号显示 `waiting_provider`，不会伪装为 ready。

## 仍未完成

1. 当前 P8 runner 先以前台交互进程运行；还没有安装为登录时自动启动的正式 Scheduled Task。
2. 首次 bootstrap 仍要求用户在 Agent armed 后手动打开一次 QQ经典农场；冷启动自动拉起继续作为独立增强。
3. 还需要用真实保存的 `platform=wx` 账号与真实 FAR2 Worker 做最终生产恢复 Gate。
4. 在最终生产 Gate 通过前，PR #55 保持 Draft，不合并 main。

## 下一次实机验证

运行：

```powershell
cd D:\project2\far2-wechat-probe
git fetch origin
git reset --hard origin/feature/windows-wechat-probe-20260819
.\start-wechat-resident-agent.cmd
```

Agent armed 后手动打开一次 QQ经典农场。目标状态：

```text
[resident] exact farm runtime connected and ready
[agent] FAR2WeChatAgent listening on 127.0.0.1:43201
```

这一步只验证正式 resident Agent 进程持续驻留，不触发 farm 自动化、heartbeat 或写操作。

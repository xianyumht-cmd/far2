# FAR2 本地生产运行链路与接续基线

更新时间：2026-08-31 17:42（Asia/Shanghai）  
项目根目录：`D:\project2\far2`  
用途：记录本机实际运行证据，供云端仓库和后续会话继续工作。本文只记录当前环境事实，不把附件中的规划当成已经完成的实现。

## 1. 结论先行

- 当前唯一经运行证据确认的 FAR2 生产根目录是 `D:\project2\far2`。
- QQ 生产链路正常运行：`FAR2Farm` 服务在运行，面板监听 `0.0.0.0:3007`，QQ Code Agent 监听 `127.0.0.1:43101`，Farm 日志在 2026-08-31 持续产生真实收获、种植、浇水、好友帮助和偷菜事件。
- 微信链路已启动但尚未稳定可用：微信 Resident Agent 监听 `127.0.0.1:43201`，WMPF 调试桥监听 `127.0.0.1:9421`，当前鉴权健康检查为 `available=false`、`residentState=waiting_bootstrap`、`contextCount=0`、`reason=wechat_resident_runtime_disconnected`。
- 当前微信配置账号存在于 FAR2 本地状态中，但因 Provider 不可用，没有证据表明微信 Farm Worker 已经成功启动；不得把“Agent 进程存在”或短暂 `runtime_connected` 当作微信农场已恢复。
- 当前工作树是脏的，包含生产运行数据、依赖/构建目录以及尚未归属本次文档工作的代码变更。后续同步只能按文件范围操作，不能覆盖、清理或重置整个工作树。

## 2. 真实生产链路

```text
Windows 服务 FAR2Farm (LocalSystem / Automatic)
  -> NSSM
  -> D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe
  -> D:\project2\far2\core\client.js
  -> Web/Admin + Runtime Engine
       -> 0.0.0.0:3007（面板与 API，未登录 API 返回 401）
       -> QQ Worker / 农场循环
       -> WeChat Recovery Manager（仅在微信 Provider ready 后替换/启动 Worker）

QQ Code 旁路：
  计划任务 FAR2CodeAgent-2320006072
  -> D:\project2\far2\scripts\windows\run-code-agent-hidden.ps1
  -> core/scripts/qq-isolated-code-agent.js
  -> 127.0.0.1:43101

微信旁路：
  计划任务 FAR2 WeChat Resident Agent
  -> D:\project2\far2\agent\scripts\windows\run-wechat-resident-agent-autostart.ps1
  -> agent/core/scripts/wechat-isolated-code-agent.js
  -> Frida attach WeChatAppEx WMPF 25510
  -> 127.0.0.1:43201（鉴权 Provider）
  -> 127.0.0.1:9421（Resident CDP/WMPF bridge）
  -> 目标微信农场 WMPF context
```

## 3. 运行入口和证据

| 链路 | 实际入口/状态 | 当前证据 |
|---|---|---|
| FAR2 主服务 | `FAR2Farm` / Running / Automatic | NSSM 参数指向 `core`，应用为共享 Node，参数为 `client.js` |
| 面板 | `0.0.0.0:3007` | 本机根页面 HTTP 200；受保护 API 未带会话时 HTTP 401 |
| QQ Code Agent | `FAR2CodeAgent-2320006072` / Running | 计划任务使用 `run-code-agent-hidden.ps1`，监听 `127.0.0.1:43101` |
| QQ Farm | 由 `core/client.js` 的 Runtime Engine 管理 | `core/data/service.stdout.log` 在当天持续有农场和好友动作 |
| 微信 Resident Agent | `FAR2 WeChat Resident Agent` / Running | 计划任务使用 canonical `agent` 目录，监听 `127.0.0.1:43201` |
| 微信 WMPF host | WeChatAppEx 进程存在 | 当前实际 WMPF 版本为 `25510`，不是旧文档中的 `25297` |
| 微信目标 context | 未稳定选中 | 鉴权 `/v1/health`：`available=false`、`waiting_bootstrap`、`contextCount=0` |

## 4. 当天 QQ 运行观察

读取 `core/data/service.stdout.log` 的 2026-08-31 日志统计：

- 农场循环：93 次；
- 收获完成：16 次；
- 种植完成：7 次；
- 好友帮助完成：56 次；
- 偷菜成功事件：15 次；
- 标准输出中未发现明显的 `error/exception/crash/fatal` 记录。

这些数字只证明 QQ 主链当天持续执行，不代表所有保存账号都符合生产目标，也不代表微信链路可用。后续若要确认当前到底有几个 QQ Worker，应使用受保护的运行健康接口或账号级日志归属核对，不能仅凭保存账号数量推断。

## 5. 微信当前阻塞点

当前鉴权健康检查返回的非敏感字段：

```json
{
  "ok": true,
  "available": false,
  "reason": "wechat_resident_runtime_disconnected",
  "platform": "wx",
  "appId": "wx5306c5978fdb76e4",
  "wmpfVersion": 25510,
  "residentState": "waiting_bootstrap",
  "connected": false,
  "exactAppContextSelected": false,
  "contextCount": 0
}
```

日志显示 Agent 会经历 `runtime_connected -> selecting_context -> exact farm runtime connected and ready`，之后再次进入 `wechat_resident_runtime_disconnected`。因此当前应把它归类为“短暂连接、未稳定绑定目标 context”，而不是“微信 Code 已恢复”。

代码中的目标选择仍然是：连接 WMPF runtime，枚举 context，检查 `wx.login`，检查目标 AppId `wx5306c5978fdb76e4`，再校验四段数字版本。后续应继续收集真实 context 的 appId/version/数量证据；不要仅根据窗口标题放宽到任意 WMPF context，也不要记录 raw `wx.login` Code、Token 或密码。

## 6. 本地状态与安全边界

- 生产数据目录：`D:\project2\far2\core\data`。
- 微信 Agent 状态和日志：`D:\project2\far2\agent\state`。
- 共享 Node 运行时：`D:\project2\napcatplugin\node-v25.8.0-win-x64\node.exe`；它是外部依赖，不是第二个 FAR2 根目录。
- 本地状态中有 QQ 账号和一个微信配置账号；账号详情、Token、密码、登录 Code 不在本文展开。
- 当前 Git 分支为 `feature/qq-seed-batch-evidence-20260814`，相对其远端跟踪分支为本地超前 63、落后 55；工作树有既有修改、删除、未跟踪运行数据和构建/依赖目录。
- 禁止用 `git reset --hard`、`git clean`、强制推送或整目录覆盖来“同步云端”。文档同步必须只处理明确的文档文件，并保留生产数据和其他未提交工作。

## 7. 与附件执行计划的衔接

附件要求的执行顺序现在固定为：

1. 以上述生产链路为事实基线；
2. 核对 QQ 神秘商店与微信协议/运行链路，不凭名称相似推断复用；
3. 形成比较项目和功能矩阵；
4. 只移植已验证、兼容且默认安全的高价值能力；
5. 完成构建、单元/自测、QQ 回归和微信路径验证；
6. 继续更新项目状态/交接文档，明确静态验证、测试验证、运行验证和仍需用户实测的边界。


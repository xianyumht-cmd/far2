# Windows 微信 P8 Production Readiness（2026-08-19）

## 实机只读预检结论

P8 readiness 报告确认：

- 正式 Resident Agent 已就绪：`127.0.0.1:43201`，exact AppId=`wx5306c5978fdb76e4`，WMPF=25297，client=`1.13.2.7`。
- Machine-level Provider URL / token 已存在。
- `FAR2Farm` 当前运行于 `D:\project2\far2-test\core`。
- 当前生产 service worktree 为 `D:\project2\far2-test`，HEAD=`d4c419246f0891d535280839317e694a049a71a3`，branch=`feature/qq-seed-batch-evidence-20260814`。
- 该生产 worktree 存在 tracked dirty changes，禁止直接 reset / checkout / 覆盖。
- 生产 `accounts.json` 可读，共 2 个账号，但当前没有 `platform=wx` 保存账号。
- FAR2Farm NSSM `AppEnvironmentExtra` 当前未显式包含 WeChat Provider URL / token / auto-refresh。
- 因此 `safeToPlanServiceRestart=false`，当前不能直接重启生产服务做 P8 Gate。

## 决策

不修改 `D:\project2\far2-test`，不清理其 tracked/untracked 数据，不把 P8 文件直接覆盖到生产 worktree。

先建立隔离 P8 stage：

1. 从当前 `feature/windows-wechat-probe-20260819` HEAD 用 `git archive` 导出纯 tracked P8 源码；
2. 将生产 `core\data` **复制**到新 stage，本步骤不修改原数据；
3. 对 P8 关键 JS 做 Node syntax preflight；
4. stage manifest / report 只记录路径、commit、账号数量，不记录 raw Code / Provider token；
5. FAR2Farm 保持运行，不切换 service AppDirectory。

入口：

```text
prepare-wechat-p8-stage.cmd
```

stage 默认位于：

```text
%LOCALAPPDATA%\FAR2\p8-stage\<timestamp>
```

报告：

```text
%TEMP%\FAR2-WeChat-Probe\wechat-p8-stage-*.json
```

## 后续

隔离 stage PASS 后，再在 stage 中建立专用 `platform=wx` 验证账号与 login-only / recovery Gate；验证过程中生产 FAR2Farm / QQ Worker 保持运行且不重启。

只有 stage 的真实微信 Worker Gate 通过，并完成生产 dirty-worktree 保护/迁移方案后，才允许修改 FAR2Farm NSSM AppDirectory / Provider 环境并执行最终生产切换。

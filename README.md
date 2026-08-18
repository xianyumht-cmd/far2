# FAR2 — QQ 农场自动化与 Web 管理面板

FAR2 是基于 Node.js + Vue 的 QQ 农场自动化项目，当前重点是 **Windows 本机长期无人值守、稳定挂机、自动恢复和可观测性**。

> README 只描述 `main` 已合并并作为当前正式基线使用的能力。实验分支、Draft PR 和尚未完成实机验收的功能不计入正式能力。

## 当前状态

截至 2026-08，FAR2 的核心 QQ 农场挂机链已经基本稳定：

- Windows 后台服务运行 WebUI、CodeManager 和 Farm Worker；
- QQ Code 由对应 Windows 交互式 Session 中的 `FAR2CodeAgent-<UIN>` 维护；
- WS400 / kickout 后可按 exact-UIN 自动刷新 Code 并恢复 Worker；
- QQ 好友关系可自动采集并进入帮助、巡查、偷菜链；
- 浏览器无需保持打开；
- 当前维护策略以“稳定使用”为第一优先级，不再为了追上游版本号机械补功能。

当前协议基线可在 `core/src/config/config.js` 查看；当前 `main` 默认客户端版本为 `1.13.0.5_20260729`。

详细状态见：

- [PROJECT_STATE.md](./PROJECT_STATE.md)
- [Windows 后台自启说明](./docs/WINDOWS_AUTOSTART.md)
- [与上游更新日志对照结论](./docs/UPSTREAM_COMPARISON_DECISION_2026-08-18.md)

---

## 已有主要能力

### 农场自动化

- 自动收获、种植、浇水、除草、除虫；
- 普通肥 / 有机肥与施肥策略；
- 自动购买化肥；
- 自动出售与背包策略；
- 作物黑名单、种植延迟、偷菜延迟等账号级配置；
- 单土地铲除、普通肥、有机肥；
- 一键铲除；
- Lv5 紫土地分类；
- 2x2 作物 master/slave 占地识别、预留、种植与施肥；
- 土地倒计时、季节数等状态展示；
- 作物变异只读展示。

### 好友 / 偷菜 / 帮助

- QQ 完整好友关系自动采集；
- 好友巡查、偷菜、帮助、浇水、除草、除虫、捣乱；
- 好友黑名单与静默时段；
- 护主犬好友状态识别；
- 护主犬好友优先帮助；
- 经验满后的帮助目标收窄与空目标退避；
- 偷菜空闲状态低噪音日志。

### Code 自动恢复 / Windows 无人值守

当前 Windows 生产结构：

```text
Windows 开机
  └─ NSSM 服务：FAR2Farm
       ├─ WebUI
       ├─ CodeManager
       └─ Farm Workers

交互式 Windows Session
  └─ FAR2CodeAgent-<UIN>
       ├─ QQ 好友关系采集
       └─ exact-UIN Code Provider
```

主要行为：

- `FAR2Farm` 作为 Windows 后台服务运行；
- `FAR2CodeAgent-<UIN>` 作为隐藏计划任务运行；
- Code Agent 与目标 QQ 保持同一 Windows Session；
- WS400 / kickout 事件驱动刷新 Code；
- 新 Code 成功后再替换旧 Worker；
- Farm 自动恢复登录；
- Provider target 可限制仅自动启动指定 QQ；
- 多 Session / 多 target 架构已具备，但当前正式生产验收仍以单目标 QQ 为主。

详细安装与诊断见 [docs/WINDOWS_AUTOSTART.md](./docs/WINDOWS_AUTOSTART.md)。

### 图鉴 / 商店

- 作物图鉴读取；
- 种子商店读取；
- 当前背包与商店状态联动；
- 图鉴缺失种子的受控购买；
- Catalog 请求按账号串行，避免页面查询挤满 Farm WS 队列；
- 未确认语义的领奖字段保持 fail-closed，不盲发领奖 RPC。

### 狗狗 / 宠物

- 自身护主犬状态读取；
- 好友护主犬识别；
- 护主犬优先帮助；
- 宠物商店安全购买；
- 狗粮信息读取；
- 狗粮单次喂食写链已经完成真实 E2E 验证；
- 当前不开放未经证明的自动喂食/礼包领取等写操作。

### 个人与展示

- 个人生涯只读；
- 头像框库存只读；
- 农场 / Worker / Code 恢复 / 好友池等运行健康信息；
- 多账号日志和状态隔离；
- Web 管理面板统一管理账号、策略、日志和运行状态。

### 活动发现

- `ActivityService.List` 通用活动读取；
- `GetGroup` 深度只读发现；
- 可识别 random shop、exchange shop、draw pool、seed-like IDs 等结构；
- 未证明写协议的活动默认只读，不猜参数、不盲操作。

---

## 当前明确不追的方向

FAR2 当前不是为了完整复刻上游私有版功能清单，而是优先保证实际挂机价值。

暂不主动开发：

- 秒偷；
- 指定好友蹲守；
- 自动刷变异；
- 为了对齐版本而增加复杂代理 / 节点 / 私有云体系；
- 没有真实使用需求的微信完整好友管理；
- 未经协议取证的活动自动领取、兑换、抽奖；
- 仅为了“功能数量”增加但会降低稳定性的写操作。

完整差异与后续触发条件见 [docs/UPSTREAM_COMPARISON_DECISION_2026-08-18.md](./docs/UPSTREAM_COMPARISON_DECISION_2026-08-18.md)。

---

## 技术栈

- 后端：Node.js 20+、Express、Socket.IO
- 前端：Vue 3、Vite、TypeScript、Pinia、UnoCSS
- 包管理：pnpm 10
- Windows 后台：NSSM + Task Scheduler
- 游戏协议：WebSocket + Protobuf

---

## 环境要求

### 源码运行

- Node.js 20+
- pnpm（仓库当前声明 `pnpm@10.30.2`）
- Windows / Linux / macOS 可运行通用 Node.js 部分

### Windows 完整无人值守能力

如需自动 Code 刷新、QQEX 好友采集和交互式 Session 能力，当前正式方案为 Windows：

- QQ 桌面客户端；
- 目标 QQ 所属交互式 Windows Session；
- Node.js；
- NSSM；
- Windows Task Scheduler。

Linux / Docker 不具备 Windows Session、QQ 桌面客户端和 QQEX 本机缓存，因此不能等价替代当前 Windows Code Agent 生产链。

---

## 快速开始（源码方式）

```powershell
# 克隆
git clone https://github.com/xianyumht-cmd/far2.git
cd far2

# 安装依赖
corepack enable
pnpm install

# 构建 WebUI
pnpm build:web

# 启动 Core + WebUI
pnpm dev:core
```

默认 WebUI 通常通过 `ADMIN_PORT` 配置；现有 Windows 部署通常使用 `3007`。

如需临时指定端口：

```powershell
$env:ADMIN_PORT="3007"
pnpm dev:core
```

---

## Windows 后台安装

当前推荐的生产方式不是长期保留 PowerShell / CMD 黑框，而是使用现有安装器：

```text
右键管理员运行：install-windows-service.cmd
```

安装器会负责：

- 安装 / 更新 `FAR2Farm` NSSM 服务；
- 为当前 QQ 创建或更新 `FAR2CodeAgent-<UIN>` 隐藏计划任务；
- 配置 Provider target；
- 使用当前 Windows Session 作为 QQ / QQEX / Code Agent 的隔离边界。

查看状态：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\status-far2-autostart.ps1
```

卸载后台自启：

```text
右键管理员运行：uninstall-windows-service.cmd
```

> 卸载后台自启不会主动删除 FAR2 账号运行数据。

---

## 更新本地源码

如果本地没有自建提交，可直接：

```powershell
cd D:\project2\far2-test
git pull --ff-only origin main
pnpm install
pnpm build:web
Restart-Service FAR2Farm -Force
```

如果提示 `Diverging branches`、`unstaged changes` 或 `CONFLICT`，不要直接 `reset --hard`。先确认本地分支和未提交文件，再决定 rebase / stash / merge，避免覆盖 `core/data` 等运行数据。

---

## 重要运行数据

以下内容属于本机运行数据或构建产物，不应当为了“更新代码”直接删除：

```text
core/data/
node_modules/
core/node_modules/
web/node_modules/
web/dist/
```

尤其 `core/data/` 可能包含账号、运行状态、CodeManager、好友采集和其他本机数据。

---

## 项目结构

```text
far2/
├─ core/
│  ├─ src/
│  │  ├─ config/          # 运行配置
│  │  ├─ controllers/     # HTTP API
│  │  ├─ gameConfig/      # 游戏静态数据
│  │  ├─ models/          # 数据模型 / 持久化
│  │  ├─ proto/           # Protobuf
│  │  ├─ runtime/         # Worker / Runtime
│  │  └─ services/        # Farm / Friend / Code / Catalog 等服务
│  ├─ scripts/            # 自检、诊断、取证工具
│  └─ data/               # 本机运行数据（不要随意删除）
├─ web/
│  ├─ src/                # Vue WebUI
│  └─ dist/               # Web 构建产物
├─ scripts/windows/       # Windows 服务、Agent、诊断脚本
├─ docs/                  # 当前基线、验收、差异审计与交接文档
├─ PROJECT_STATE.md       # 当前项目状态
├─ install-windows-service.cmd
└─ package.json
```

---

## 维护原则

1. 稳定挂机优先于功能数量；
2. 已验收的偷菜、好友、Code 恢复等核心链不轻易重写；
3. 写操作优先采用“写前读取 → 条件校验 → 单次写入 → 写后验证”；
4. 未证明字段语义或协议时 fail-closed；
5. 不为了追上游版本号机械增加功能；
6. 出现真实协议变化、核心链回归或明确使用需求时再继续扩展。

---

## 免责声明

本项目仅供学习、研究和个人技术实验使用。自动化操作可能受到游戏服务条款、协议变更或风控策略影响。使用者应自行评估并承担相关风险。

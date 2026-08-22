# FAR2 — QQ / 微信经典农场 Windows 自动化运行平台

FAR2 是一个基于 **Node.js + Vue 3** 的经典农场自动化与 Web 管理项目，当前正式维护方向是：

- Windows 本机长期运行；
- QQ / 微信双平台接入；
- Code / 会话失效后的自动恢复；
- Farm Worker 自动化与可观测性；
- 关键运行数据 fail-closed 持久化；
- 活动种子 / 2x2 作物的受控识别与种植；
- 不为“功能数量”牺牲生产稳定性。

> `main` 是当前唯一正式源码基线。README 只描述已经进入 `main`、并被当前生产链使用或明确保留的能力。历史分支、Draft PR、旧探针和过期交接文档不作为当前行为依据。

---

## 当前状态

截至 2026-08，FAR2 已完成一轮生产源码收口，当前 `main` 已包含正在使用的 QQ / 微信 Windows 运行链、P4 持久化修复以及 Crop Registry / Runtime Plant 能力。

当前生产模型可以概括为：

```text
Windows
├─ FAR2Farm（NSSM 后台服务）
│  ├─ WebUI / HTTP API
│  ├─ CodeManager
│  └─ Farm Workers
│
├─ FAR2CodeAgent-<UIN>（QQ 交互式计划任务）
│  ├─ QQ / QQEX 本机会话
│  ├─ exact-UIN Code Provider
│  └─ QQ 好友关系采集
│
└─ FAR2 WeChat Resident Agent（微信交互式计划任务）
   ├─ Windows 微信 / WMPF runtime
   ├─ wx.login fresh Code
   └─ authenticated loopback Code Provider
```

当前维护原则仍是：**已经稳定的生产链优先保持稳定；协议不明确时宁可 fail-closed，也不盲发写请求。**

---

## 主要能力

### 1. 农场自动化

- 自动收获、种植、浇水、除草、除虫；
- 普通肥 / 有机肥与施肥策略；
- 自动购买化肥；
- 自动出售与背包策略；
- 作物黑名单、种植延迟、偷菜延迟等账号级配置；
- 单土地铲除 / 普肥 / 有机肥；
- 一键铲除；
- Lv5 紫土地分类；
- 2x2 作物 master/slave footprint 识别、预留、种植与施肥；
- 土地倒计时、季节数等状态展示；
- 作物变异只读展示。

### 2. 好友 / 偷菜 / 帮助

- QQ 完整好友关系自动采集；
- 好友巡查、偷菜、帮助、浇水、除草、除虫、捣乱；
- 好友黑名单与静默时段；
- 护主犬好友状态识别与优先帮助；
- 经验满后的帮助目标收窄与空目标退避；
- 偷菜空闲状态低噪音日志。

### 3. QQ Windows Code 自动恢复

QQ 当前采用交互式 Windows Session 中的隔离 Code Agent：

```text
FAR2Farm
  -> CodeManager
  -> exact-UIN Provider
  -> FAR2CodeAgent-<UIN>
  -> QQ / QQEX session
```

主要行为：

- `FAR2Farm` 作为 Windows 后台服务运行；
- `FAR2CodeAgent-<UIN>` 作为隐藏计划任务运行；
- Code Agent 与目标 QQ 保持同一 Windows Session；
- WS400 / 有效 kickout 后按 exact-UIN 刷新 Code；
- 新 Code 成功后再替换旧 Worker；
- FAR2Farm 重启后可自动恢复目标 Worker；
- Provider target 可限制只自动启动指定 QQ；
- 健康状态下采用事件驱动，不做无意义的周期重登。

当前正式生产仍以单目标 QQ 的稳定无人值守为主，多 Session / 多 target 架构保留但不作为默认生产假设。

### 4. 微信 Windows Resident Agent

微信已经接入 FAR2 正式 Windows 生产链。

当前链路：

```text
Windows 登录
  -> FAR2 WeChat Resident Agent 计划任务启动
  -> 识别微信 / WMPF QQ经典农场 runtime
  -> wx.login 获取 fresh Code
  -> 127.0.0.1 loopback Provider
  -> FAR2 platform=wx Worker
```

当前能力包括：

- Windows 微信 / WMPF runtime 识别；
- `platform=wx` 官方 Gateway 登录；
- Resident Agent 常驻；
- loopback Provider 鉴权；
- `wx.login` fresh Code；
- WS400 / 有效 kickout 后按需恢复；
- FAR2Farm 启动后的 `startup_recover`；
- WebUI “使用当前已登录微信” 主路径；
- Resident Agent Windows 登录后隐藏自启动；
- Code 刷新策略为 `on_invalid`，正常挂机不做周期 fresh Code；
- WMPF context 重新连接后会重新定位真实 `wx` 上下文，而不是依赖一次性 context id。

注意：Resident Agent 自动启动不等于微信小程序一定已经打开。Windows 冷启动后，如果 QQ经典农场 WMPF runtime 尚未出现，仍需要让微信中的农场 runtime 先实际出现，之后 Resident Agent 才能提供 fresh Code。

详细记录：

- `docs/WECHAT_WINDOWS_PRODUCTION_HANDOFF_2026-08-20.md`
- `docs/WINDOWS_AUTOSTART.md`

### 5. Crop Registry / Runtime Plant

当前 `main` 已包含生产正在使用的 Crop Registry / Runtime Plant 链。

目标不是根据未知 item id 猜作物，而是把 **身份、footprint、是否可自动种植** 分开证明：

- startup crop registry；
- runtime crop registry resolver；
- runtime plant overlay evidence；
- registry-aware bag seed reader；
- QQ item / seed / unknown-item 证据扫描；
- 1x1 / 2x2 runtime 作物映射；
- 活动 / 特殊背包种子优先于普通商店补种；
- 未证明 identity / footprint 的条目保持 fail-closed；
- 化肥等非种子条目不会因为 ID 形态相似被误当成种子。

相关自检入口：

```powershell
pnpm -C core startup:crop-registry-selftest
pnpm -C core runtime-plant-overlay:selftest
pnpm -C core static-plant-overlay:selftest
pnpm -C core event-seed:selftest
```

`core/data/crop_registry/` 属于运行时状态，不是源码；不要为了同步 Git 把账号级 registry 快照直接提交进仓库。

### 6. 关键 JSON 持久化

当前 `main` 已包含 P4 持久化加固：

- critical JSON 写入采用原子替换；
- 关键文件读取异常时 fail-closed；
- `users.json` / `cards.json` 注册、续费使用跨文件事务；
- 使用 transaction journal 处理进程崩溃或第二文件写入失败；
- 一致性无法证明时保留证据并停止继续写入，不静默覆盖。

相关自检：

```powershell
pnpm -C core persistence:critical-json-selftest
pnpm -C core persistence:user-store-selftest
pnpm -C core persistence:user-card-transaction-selftest
```

详细记录：

- `docs/P4_002_USER_STORE_ATOMIC_2026-08-20.md`
- `docs/P4_003_USER_CARD_TRANSACTION_2026-08-20.md`

### 7. 图鉴 / 商店 / 活动

- 作物图鉴读取；
- 种子 / 宠物 / 其他商店读取；
- 当前背包与商店状态联动；
- 图鉴缺失种子的受控购买；
- Catalog 请求按账号串行，避免挤满 Farm WS 队列；
- `ActivityService.List` 通用活动读取；
- `GetGroup` 深度只读发现；
- 可识别 random shop、exchange shop、draw pool、seed-like IDs 等结构；
- 未证明写协议的活动继续保持只读。

### 8. 狗狗 / 宠物 / 个人展示

- 自身护主犬状态读取；
- 好友护主犬识别与优先帮助；
- 宠物商店安全购买；
- 狗粮信息读取；
- 狗粮单次喂食真实 E2E 已通过；
- 个人生涯只读；
- 头像框库存只读；
- Farm / Worker / Code 恢复 / 好友池等运行健康信息；
- 多账号日志和状态隔离。

未经证明的自动喂食、礼包领取、活动写协议等仍不默认开放。

---

## Web 管理面板

WebUI 用于统一管理：

- QQ / 微信账号；
- Worker 启停与状态；
- 农场策略；
- 好友 / 偷菜策略；
- 日志；
- Code / Provider 健康；
- 图鉴、商店、活动发现；
- 运行健康信息。

默认管理端口通常由 `ADMIN_PORT` / 项目配置决定，当前 Windows 生产部署常用 `3007`。

---

## 技术栈

- Core：Node.js / CommonJS
- HTTP：Express
- 实时通信：Socket.IO / WebSocket
- 协议：Protobuf
- Web：Vue 3 + Vite + TypeScript + Pinia + UnoCSS
- 包管理：pnpm 10
- Windows 后台：NSSM + Task Scheduler
- QQ 本机能力：Windows Session + QQ / QQEX
- 微信本机能力：Windows 微信 + WMPF + Resident Agent

仓库当前声明：

```text
pnpm@10.30.2
core version: 2.2.2
```

---

## 环境要求

### 通用源码

- Node.js 20+
- pnpm 10
- Git

### Windows 完整生产链

如需 QQ / 微信 Code 自动恢复与交互式 Session 能力，需要：

- Windows；
- QQ 桌面客户端（QQ 账号）；
- Windows 微信（微信账号）；
- 目标账号对应的交互式 Windows Session；
- Node.js；
- NSSM；
- Windows Task Scheduler。

Linux / Docker 可以运行通用 Node.js 服务，但不能等价替代 Windows Session、QQ / QQEX、Windows 微信 / WMPF Resident Agent 这部分本机能力。

---

## 快速开始

```powershell
git clone https://github.com/xianyumht-cmd/far2.git
cd far2

corepack enable
pnpm install
pnpm build:web
pnpm dev:core
```

临时指定管理端口：

```powershell
$env:ADMIN_PORT="3007"
pnpm dev:core
```

仓库改为 Private 后，clone URL 不变，但新机器必须先完成 GitHub 身份认证。

---

## Windows 后台运行

### FAR2Farm + QQ Code Agent

管理员运行：

```text
install-windows-service.cmd
```

状态检查：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\status-far2-autostart.ps1
```

### 微信 Resident Agent

管理员运行：

```text
install-wechat-resident-agent-autostart.cmd
```

如果微信 Resident Agent 的自启动配置被破坏，可以使用仓库中的 repair 脚本重新安装 / 修复。

---

## 配置与敏感数据

仓库里的 `.env` 目前只包含端口、时区、`NODE_ENV` 等非敏感默认值。

真实生产中的 Provider Token、一次性 Code、账号状态、session、cookie、运行数据等不应提交到 Git：

```text
core/data/
*.token
*.secret
本机 Provider Token
QQ / 微信一次性 Code
session / cookie / 登录态
```

尤其注意：

- `wx.login` Code 是敏感一次性凭证，不打印、不写 README、不提交；
- QQ Code 同样不应进入 Git；
- `core/data/` 是运行状态，不是源码；
- 把仓库改成 Private 也不能代替密钥管理。

---

## 更新源码

如果本地没有未提交源码改动：

```powershell
cd D:\project2\far2-test
git pull --ff-only origin main
pnpm install
pnpm build:web
```

生产服务是否重启应根据实际更新内容决定，不要为了同步源码机械重启 QQ / 微信 Resident Agent。

如果 Git 提示 diverging branches、unstaged changes 或 conflict，不要直接 `reset --hard`。先区分源码与 `core/data` 运行状态，再决定后续操作。

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
│  │  └─ services/        # Farm / Friend / Code / Registry 等服务
│  ├─ scripts/            # 自检、诊断、取证工具
│  └─ data/               # 本机运行状态，不作为源码同步
├─ web/
│  ├─ src/                # Vue WebUI
│  └─ dist/               # Web 构建产物
├─ scripts/windows/       # Windows 服务 / QQ / 微信 Agent 脚本
├─ docs/                  # 验收、取证、生产交接与历史记录
├─ PROJECT_STATE.md       # 历史项目状态入口
├─ install-windows-service.cmd
├─ install-wechat-resident-agent-autostart.cmd
└─ package.json
```

---

## 当前明确不追的方向

除非真实生产重新出现需求，否则不主动扩：

- 秒偷；
- 指定好友蹲守；
- 自动刷变异；
- 为追上游版本号增加复杂代理 / 节点 / 私有云体系；
- 未经协议取证的活动自动领取、兑换、抽奖；
- 只为了增加功能数量而引入高风险写操作；
- 已经明确退出生产路线的农场窗口高频隐藏 / 扫描功能。

---

## 维护原则

1. `main` 是源码真源；
2. 生产稳定性优先于功能数量；
3. 已验收的 QQ / 微信恢复链不轻易重写；
4. 写操作优先采用“写前读取 → 条件校验 → 单次写入 → 写后验证”；
5. 未证明字段、identity、footprint 或协议语义时 fail-closed；
6. 运行数据和源码分离；
7. 不为了追版本号机械同步上游；
8. 出现真实协议变化、核心链回归或明确使用需求时再继续扩展。

---

## 免责声明

本项目仅供学习、研究和个人技术实验使用。自动化操作可能受到服务条款、协议变化或风控策略影响，使用者应自行评估并承担相关风险。

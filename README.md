# FAR2 — QQ / 微信农场自动化与 Web 管理面板

FAR2 是基于 Node.js + Vue 的农场自动化项目。当前正式基线以 **Windows 本机长期无人值守、稳定挂机、自动恢复、可观测性和可恢复维护** 为核心，覆盖 QQ 农场与 Windows 微信农场两条生产链。

> `main` 是当前唯一正式源码基线。README 只描述已经进入 `main`、并作为当前正式版本维护的能力；历史 Draft PR、旧实验分支和已退役方案不再代表当前版本。

## 当前状态

截至 2026-08，当前 `main` 已完成一次生产源码收口，核心状态如下：

- QQ 农场 Windows 无人值守链稳定运行；
- QQ Code 由对应 Windows 交互式 Session 中的 `FAR2CodeAgent-<UIN>` 维护；
- WS400 / kickout 后可按 exact-UIN 自动刷新 Code 并恢复 Worker；
- QQ 好友关系可自动采集并进入帮助、巡查、偷菜链；
- Windows 微信农场已接入 FAR2 Resident Agent 生产链；
- 微信使用 `wx.login` fresh Code + authenticated loopback Provider；
- 微信 Code 刷新策略为 `on_invalid`，正常在线时不做周期性刷新；
- 微信 `ws_400` / 有效 kickout / `startup_recover` 可触发 fresh Code；
- Crop Registry / Runtime Plant Overlay 已进入正式源码，用于动态作物身份与 footprint 识别；
- Registry → 背包活动 / 特殊种子消费链已经启用，未证明的数据继续 fail-closed；
- 关键账号 / 用户 / 卡密 JSON 持久化已经增加原子写、fail-closed 与跨文件事务恢复；
- 浏览器无需保持打开；
- 当前维护策略仍是“稳定使用优先”，不为了追上游版本号机械补功能。

当前 `main` 源码基线已经包含生产实际依赖的 QQ、微信、Crop Registry 和 P4 持久化修复。

---

## 运行架构

### QQ

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
- WS400 / kickout 后进行事件驱动 fresh Code；
- 新 Code 成功后再替换旧 Worker；
- Provider target 可限制只自动启动指定 QQ；
- 多 Session / 多 target 架构已具备。

### 微信

```text
Windows 登录
  └─ FAR2 WeChat Resident Agent
       ├─ exact WMPF farm runtime
       ├─ wx.login fresh Code
       └─ authenticated loopback Provider :43201

FAR2Farm
  └─ WeChatRecoveryManager
       ├─ startup_recover
       ├─ ws_400
       ├─ valid kickout
       ├─ web_enroll
       └─ manual refresh
```

当前正式规则：

- exact appId：`wx5306c5978fdb76e4`；
- Windows 微信 Resident Agent 独立常驻；
- Provider 使用 loopback + token；
- 正常在线时 `refreshIntervalMs = 0`；
- fresh Code 只按 `startup_recover`、`ws_400`、有效 kickout、WebUI enrollment 或手动刷新触发；
- raw `wx.login` Code 不打印到日志、Git、命令行或报告；
- Windows 冷启动后仍需要微信已经登录，并让 QQ经典农场 runtime 出现；Resident Agent 本身不等于自动打开微信小程序。

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

### Crop Registry / 动态种子

当前正式源码已经包含启动前作物 Registry 与 Runtime Plant Overlay：

- 登录后先读取 Bag、完整图鉴、活动和种子商店，再释放自动化；
- Registry 完整读取失败时保持 fail-closed 并重试；
- 作物身份和 footprint 分开取证；
- Runtime Plant direct evidence 可晋升真实 seed identity / size；
- `fruit + 20000` 之类 offset 规律只作为诊断信息，不能晋升身份；
- 未证明 footprint 的动态种子不盲试 `Plant`；
- Registry-aware bag reader 可让普通策略和 `bag_priority` 消费同一套已证明作物信息；
- Runtime overlay 属于本机运行状态，不应直接提交到 Git。

### 图鉴 / 商店 / 活动

- 作物图鉴读取；
- 种子商店读取；
- 当前背包与商店状态联动；
- 图鉴缺失种子的受控购买；
- Catalog 请求按账号串行；
- `ActivityService.List` 通用活动读取；
- `GetGroup` 深度只读发现；
- 可识别 random shop、exchange shop、draw pool、seed-like IDs 等结构；
- 未证明写协议的活动默认只读，不猜参数、不盲操作；
- 未确认语义的领奖字段继续 fail-closed。

### 狗狗 / 宠物

- 自身护主犬状态读取；
- 好友护主犬识别；
- 护主犬优先帮助；
- 宠物商店安全购买；
- 狗粮信息读取；
- 狗粮单次喂食写链已完成真实 E2E；
- 当前不开放未经证明的自动喂食 / 礼包领取等写操作。

### 持久化安全

当前正式源码已经包含 P4 持久化修复：

- 关键 JSON 写入使用临时文件 + rename 的原子落盘；
- 关键 JSON 读取异常时 fail-closed；
- `users.json` / `cards.json` 注册与续费更新使用跨文件事务 journal；
- 崩溃后可识别“未写入 / 部分写入 / 全部写入”并恢复一致状态；
- 遇到无法解释的状态分叉时保留 journal 证据并停止继续写入。

---

## 技术栈

- 后端：Node.js、Express、Socket.IO
- 前端：Vue 3、Vite、TypeScript、Pinia、UnoCSS
- 包管理：pnpm 10（当前仓库声明 `pnpm@10.30.2`）
- Windows 后台：NSSM + Task Scheduler
- 游戏协议：WebSocket + Protobuf

---

## 环境要求

### 源码运行

- Node.js 20+
- pnpm / Corepack
- Windows / Linux / macOS 可运行通用 Node.js 部分

### Windows 完整生产能力

如需 QQ 自动 Code 刷新、QQEX 好友采集、微信 Resident Agent 和交互式 Session 能力，当前正式方案为 Windows：

- QQ 桌面客户端；
- Windows 微信客户端（如使用微信农场）；
- 对应账号所在的交互式 Windows Session；
- Node.js；
- NSSM；
- Windows Task Scheduler。

Linux / Docker 不具备 Windows Session、QQ 桌面客户端、微信 WMPF runtime 和 QQEX 本机缓存，因此不能等价替代当前 Windows 完整生产链。

---

## 快速开始

```powershell
# 私有仓库需要先完成 GitHub 身份认证
git clone https://github.com/xianyumht-cmd/far2.git
cd far2

corepack enable
pnpm install
pnpm build:web
pnpm dev:core
```

默认 WebUI 通常通过 `ADMIN_PORT` 配置；现有 Windows 部署通常使用 `3007`。

如需临时指定：

```powershell
$env:ADMIN_PORT="3007"
pnpm dev:core
```

---

## Windows 后台安装

QQ / FAR2Farm 主服务使用：

```text
右键管理员运行：install-windows-service.cmd
```

Windows 微信 Resident Agent 相关安装 / 修复脚本也已经进入仓库，位于根目录和 `scripts/windows/`。

查看 FAR2 Windows 自启状态：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\windows\status-far2-autostart.ps1
```

卸载后台自启：

```text
右键管理员运行：uninstall-windows-service.cmd
```

> 卸载自启不会主动删除 `core/data` 中的账号运行数据。

---

## 本地配置与敏感信息

仓库中的根 `.env` 只应保留无敏感性的默认配置，例如端口、时区和 `NODE_ENV`。

真实生产密钥、Provider token、Cookie、Session、一次性 Code、账号状态等都不应提交到 Git。建议通过 Windows Machine/User 环境变量、NSSM service environment 或其他本机私有配置提供。

特别禁止提交：

```text
core/data/
*.token
*.secret
*.key
*.pem
*.pfx
.env.local
.env.*.local
```

---

## 更新本地源码

如果本地没有自建提交，可：

```powershell
cd D:\project2\far2-test
git pull --ff-only origin main
pnpm install
pnpm build:web
Restart-Service FAR2Farm -Force
```

如果出现 `Diverging branches`、`unstaged changes` 或 `CONFLICT`，不要直接 `reset --hard`。先确认本地分支和未提交文件，尤其不要覆盖 `core/data` 等运行状态。

---

## 重要运行数据

以下内容属于本机运行数据、依赖或构建产物，不属于源码真源：

```text
core/data/
node_modules/
core/node_modules/
web/node_modules/
web/dist/
```

尤其 `core/data/` 可能包含账号、卡密、运行状态、CodeManager、Crop Registry、好友采集以及其他本机数据。

灾难恢复时，本仓库只承担“源码真源”角色；运行状态和密钥是否单独备份由部署方自行决定。

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
│  │  └─ services/        # Farm / Friend / Code / Catalog / Registry 等服务
│  ├─ scripts/            # 自检、诊断、取证工具
│  └─ data/               # 本机运行数据，不应进入源码提交
├─ web/
│  ├─ src/                # Vue WebUI
│  └─ dist/               # Web 构建产物
├─ scripts/windows/       # Windows 服务、QQ/微信 Agent、诊断脚本
├─ docs/                  # 基线、验收、差异审计与历史交接文档
├─ PROJECT_STATE.md       # 历史项目状态 / 交接记录
├─ install-windows-service.cmd
└─ package.json
```

---

## 维护原则

1. 稳定挂机优先于功能数量；
2. 已验收的 QQ、微信、偷菜、好友、Code 恢复核心链不轻易重写；
3. 写操作优先采用“写前读取 → 条件校验 → 单次写入 → 写后验证”；
4. 未证明字段语义、作物身份、footprint 或协议时 fail-closed；
5. 生产运行状态与源码分离，`core/data` 不作为 Git 真源；
6. 不为了追上游版本号机械增加功能；
7. 出现真实协议变化、核心链回归或明确使用需求时再继续扩展。

---

## 当前仓库定位

`xianyumht-cmd/far2` 当前作为私有源码真源维护。

- 默认分支：`main`；
- 生产源码变更最终应收口到 `main`；
- 历史实验分支和 Draft PR 仅保留取证 / 开发历史意义，不应被当成比 `main` 更新的正式版本；
- 新机器恢复时，以 `main` 为源码基线，再重新配置本机运行参数与账号环境。

---

## 免责声明

本项目仅供学习、研究和个人技术实验使用。自动化操作可能受到游戏服务条款、协议变更或风控策略影响。使用者应自行评估并承担相关风险。

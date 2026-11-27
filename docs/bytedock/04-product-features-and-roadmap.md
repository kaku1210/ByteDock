# 04 · ByteDock 核心特色矩阵与分阶段研发路线图

> 本文件统一收拢 ByteDock 选定的全部核心产品特色：**「1 个外壳升级 + 4 大旗舰插件族 + 4 个可发布里程碑」**。

---

## 一、核心竞争护城河（避开正面撞车，打穿 4 大真蓝海空位）

调研 12+ 同赛道产品后（Orca 140k★、Paseo 25.7k★、cmux 29k★、Vibe Kanban 28.8k★ 等），`ByteDock` 不和海外产品硬拼“插件数量”或“Slack 生态”，而是立足你仓库现有资产打穿 4 个高壁垒空位：

1. **结构化多 Agent 协作的“真工程控制”**：超越“开多个并行终端”，把已有 `L0→L1→L2` 任务树、共享 Worktree 三层路径归因与写锁（`t3_worktree_coordinate`）、水平升级协议、子任务缓存摘要、多附件 `merge_back`，升级为“异构角色编排 + 协作原语 + 一等公民 CLI/SDK + 看板/2D 代理工厂视图”。
2. **可量化的“极致省 Token + 提速”中间件**：竞品都在做功能加法导致上下文越堆越重；`ByteDock` 将按角色裁剪 MCP Schema、Tool Output Compactor 溢出压缩落盘、长会话防失忆、`agy-fast` 批处理、TTFT/TPS/Cache 监控与 **Context X-Ray 省钱账单** 做成核心基础设施。
3. **本土 Bot 协作生态 + Windows 一等公民**：海外竞品普遍 macOS 优先 + Slack/Linear；`ByteDock` 直接打通 **QQ（已有 `NapCatQQ`）/ 飞书 / 钉钉 / 企微** 双向 Bot 协作（自有订阅 + `SOUL.md`/`MEMORY.md`），并深耕 Windows（Defender 排查、PowerShell/WSL、进程回收、关窗托盘常驻、免 TUN 代理）。
4. **可验证的零遥测安全边界**：不做口号式零遥测，直接用 **Egress Guard 出站白名单防火墙 + 凭证隔离 + fail-closed 安全钩子 + 实时外联审计日志** 正面承接 T3 Code 信任危机流失用户。

---

## 二、全量选定能力收拢清单（1 个外壳 + 4 大旗舰插件族）

### 外壳级升级（微内核层）

- **Dockview 自由拖拽分屏 + 顶栏多会话标签 + 副屏撕离**（融合 `#57` 顶栏标签、`#34 @EmilHovv`、`#54 Phi` 三栏拖合、`#47 Loom` Agent 可控面板）：
  - 顶部浏览器式多线程标签（带完成/运行状态环），向下拖拽即成左右/三栏分屏，支持 Electron 副屏独立窗口撕离；
  - Agent 可通过内置 MCP 工具主动唤出右侧终端/Diff/报告面板；
  - **一旦换上 Dockview 壳，所有插件注册的 `dockPanel` 天然支持自由分屏！**
- **双层清爽左侧栏（`#57` + `#20`）**：外层 52px Icon Rail（左下角常驻多 Provider 环形配额进度环）+ 内层按仓库首字母色块折叠的双行线程卡（带 `Agent +N` 徽标与悬停快回审批浮窗）。

---

### 插件族 A：安全、提速省 Token 与额度可观测（口碑爆点包）

| 插件包                       | 挂载扩展点                                                                                                                                       | 核心能力与落地细节                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`plugin-egress-guard`**    | `egress.request.before` (`deny`) + `node:dns`/`dgram` + Chromium `session.setProxy` + `dockPanel` + `statusBarItem` + `timelineRenderer`         | **诚实三级能力边界 + 双段 `EgressProof`（R3 审计级措辞封板）**：① **L1 覆盖宿主 JS 层 100%**（dispatcher 双闸包裹+劫持 + 双层 DNS/SSRF IP 校验/`setLocalAddress` pin + UDP 拒 + Chromium 代理 + `AsyncLocalStorage` 防递归）；原生 N-API addon（`ffi-rs`/`node-pty`/`transcribe-cpp`）与子进程原生 TLS 诚实声明不在 L1 保证域内，归 L2/L3 并标 `origin: "uncovered-native"`；② **双段 `EgressProof`** = 活宿主 60s 归因不变量（loopback/pipe 证明式排除）+ 独立离线全禁探针 runner & hash-chained 审计；③ **L2** 子进程 CLI 全审计/封锁 best-effort，**L3** OS 防火墙 opt-in 全路径保证 |
| **`plugin-token-optimizer`** | `agent.open.before`（两阶段）+ `agent.turn.before`（仅追加）+ `agent.compact.before` + `agent.tool.after` + `statusBarItem` + `timelineRenderer` | **双轨 CacheGuard 六铁律（绝不击穿缓存、绝不伪造指标）**：按 `AdapterCacheProfile` 路由——① **无状态 API 轨**：`open` 前缀钉死 + `deferred + tool_search` 懒暴露 + `turn` suffix 追加 + Turn 边界 Compactor + CI 稳态缓存率 `>= 90%`；② **有状态 CLI/ACP 轨**：`open-params` 钉制 + `payload-wrap` 追加 + 仅原生 `/compact`（无原生命令则关闭宿主压缩）+ 宿主层确定性不变量验证；③ **Context X-Ray 三态账单**（`measured` / `native` / `opaque`，绝不虚标命中率）+ TTFT/TPS/Cache 状态条                                                                                                 |
| **`plugin-usage-hub`**       | `registerUsageSource` + `sidebarFooter` + `dockPanel` + `settingsSection`                                                                        | 复用现有 `ProviderInstanceRegistry` + `UsageService` + Pace 刻度：左下角紧凑多账号配额环、顶栏悬停浮层、暗色 4 卡 KPI + Usage Events 明细表（`#50`）、峰值柱图/圆点热力图（`#55`）、**多账号撞限额自动平滑切备号**                                                                                                                                                                                                                                                                                                                                                                      |

---

### 插件族 B：结构化多 Agent 真工程控制 + 任务视角流 + SDK（核心技术壁垒）

| 插件包                         | 挂载扩展点                                                                       | 核心能力与落地细节                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`plugin-orchestration-pro`** | `agent.turn.before` + `agent.tool.before` + `MilestoneHub` + `mcp` + `dockPanel` | 承接已有 `L0→L1→L2` 任务树、共享 Worktree 三层路径归因与写锁、水平升级、`merge_back` 池、`t3_task_list`；新增 **Orca 式 Role Routing Recipes**（`Opus 规划 → Gemini/GPT/Grok 执行 → GPT/Gemini 审核`，按 Worker 指定 `model + effort`）、`Dispatch ID` 防过期回报覆盖、Decision Gate 决策卡，以及 **Paseo 式协作原语**（`/handoff`、`/advisor`、`/committee`、多模型并行竞速 Best-of-N、跨 Session `@` 交接） |
| **`plugin-task-board`**        | `sidebarView` + `dockPanel`（`sandbox-iframe` / `native`）                       | **三态一键切换的任务管理视角流**：① **Vibe Kanban 看板态**（按状态列解耦规划与异步审查）；② **Needs-You 审批决策队列态**（带 `1/2/3` 快捷键秒裁决与已看/未看分态）；③ **Acan 2D 代理工厂态（`#52`）**（多仓库俯视蓝图地板，空闲机器人员工中性灰，彩色仅打在工作中 / 等待人工 / 红色文件写冲突连线）                                                                                                           |
| **`@bytedock/client` + CLI**   | 一等公民 SDK + `apps/server/src/cli`                                             | 对标 Paseo/Paradev，暴露干净 TypeScript SDK 与 CLI（创建/编排/等待/读结果/触发插件/控制面板），支持工作区脚本化与外部自动化集成                                                                                                                                                                                                                                                                               |

---

### 插件族 C：机器人协作（Bots）+ 本土生态 + 工作区自动化 + Windows 一等公民

| 插件包                             | 挂载扩展点                                                                       | 核心能力与落地细节                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`plugin-bots-core`**             | `channels` SPI + `MilestoneHub` + `scheduledTasks` + `sidebarView` + `dockPanel` | 借鉴 **Orca Bots (`#36`)** + **Iris Bot (`#38`)**：左侧独立 `Bots` 分区，纯 Markdown 的 **`SOUL.md`（人格与职责）+ `MEMORY.md`（人类可审阅长期记忆）**，全部跑在自有订阅上；触发源支持 IM `@bot` / Cron / Webhook / PR / CI 失败，遇到分歧自动弹出 **Decision Gate** 或在 IDE 内一键接管                                                                                                                                                              |
| **本土通道插件族**                 | `registerBotChannel`                                                             | 首批插件：`channel-napcat-qq`（直接对接工作区现成的 `NapCatQQ` OneBot v11，**R3 安全样板**：`secretNamespaces: ["bytedock.napcat"]`、`networkHosts: ["127.0.0.1", "localhost"]`、webhook 强制 `auth: "token"` + `tokenSecretRef` + raw-body HMAC 验签 + `replayDefense(300s)` + `rateLimitPerMin: 50` + `frameOptions: "DENY"`，暴露公网须开 L3 硬模式）、`channel-feishu`、`channel-dingtalk`、`channel-wecom`、`channel-telegram`、`channel-github` |
| **`plugin-workspace-automation`**  | `MilestoneHub` + `http` + `scheduledTasks`                                       | 事件驱动工作区自动化引擎（`确定性脚本 0 Token` ↔ `按复杂度选模型 AI 节点` ↔ `UI/Bot 人工审批卡点`）；配套 **`plugin-upstream-radar`**（0 号自举自动化插件，持续追踪 `pingdotgg/t3code` 上游 PR）                                                                                                                                                                                                                                                      |
| **`plugin-windows-essentials`**    | `settingsSection` + `composerBanner` + `desktop`                                 | 收拢 Windows Defender 排除项、关窗托盘常驻续跑、PowerShell/WSL 路径转义与进程回收、免 TUN 代理、AUMID 原生通知（macOS/Linux 自动跳过零加载）                                                                                                                                                                                                                                                                                                          |
| **`plugin-external-tunnel`**       | `settingsSection` + `http` + `statusBarItem`                                     | 收拢已自研的独立外部隧道管理（不依赖 T3 Connect / Clerk），与本地 `didyou-relay` 生态平滑衔接                                                                                                                                                                                                                                                                                                                                                         |
| **`plugin-colab-gpu`** _(P1 自研)_ | `mcp` (5 工具) + `dockPanel` + `statusBarItem`                                   | 纯 TS 零内置密钥直连 Google Colab（PKCE 复用 `google-colab-cli` 配置 + Tunnel / 持久 Jupyter Kernel / WS-SSH 三通道 + 计时 PiP 胶囊 + **闲置自动停机 & CU 余额保底止损**，详见 `#43` 与 `#29`）                                                                                                                                                                                                                                                       |

---

### 插件族 D：极致 Agent 兼容面 & VCS / 交付体验扩展

| 插件包                  | 挂载扩展点                                               | 核心能力与落地细节                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider 动态插件族** | `registerProvider`                                       | 将现有 11 个 Provider 与 ACP 16 项扩展清单（`#46`：`usage/ratelimits/compaction/subagent(think)`）接入动态注册表，通过统一模板快速扩展至 Qwen Code / Kimi / DeepSeek Harness / Goose / Hermes 等 30+ CLI；中长期探索同会话 **Chat UI ↔ Raw CLI 无损切换** |
| **VCS & 交互体验插件**  | `registerWorktreeManager` + `timelineRenderer` + `theme` | 预留 **Paseo `jj-companion`（Jujutsu Workspace）** 并行隔离插件口（`#49`）；对话内联活体 **Chat Artifacts**（HTML/React/3D 预览 `#53`）；`ByteDock Dark/Light` 主题 + 字体 + Halo 高危长按蓄力确认（`#56`）+ Bluma 语音点阵微动效（`#51`）                |

---

## 三、分阶段可发布里程碑（经 R1 去乐观化修正，真实窗口 8–10 周 / v0.1-lite 4–8 周）

> **R2 拍板定稿**：
>
> - 原 M0（2–3 周）修正为 **4–8 周交付 `v0.1-lite`**（完整 `v0.1` 8–10 周），**必切 12 处最小接缝（~585 行）**，延迟 4 处 + 3 子项。
> - **Week 7–8 爆点终裁：锁定「1 条 `NapCatQQ` 本土 Bot 闭环」**（零新增上游冲突文件 + 一次端到端实证 10 个扩展点 + 首周 30 秒 GIF 传播力）；**Dockview 整段移至 v0.2**（v0.1 先定型 `dockPanel` 容器接口，v0.2 换壳零返工，且保持 A/B 类上游移植流水线先跑通一轮的前置条件）。
> - **防四不像单一真相源**：Kanban 看板、`Needs-You` 队列、Acan 工厂、Bots 审批卡全部共享核心 `Thread + TaskTree + Milestone` + 插件侧 `DockTask`/`DecisionGate`；`plugin-colab-gpu` 明确定位为侧挂 P2 实验件；`registerDriver` 在 v0.3 前仅第一方开放。

### Milestone 0 + v0.1-lite（公测信任 & 省钱 & 本土 Bot 爆点版，约 4–8 周）

- [ ] **Week 1–2 · 品牌独立 + 插件底座 v0 + CI 一次过基建**：完成 `ByteDock` 品牌切换、`~/.bytedock` 独立目录、CI 禁遥测门禁及 `gt-react` / Tailwind `@source` / `knip.jsonc` / `// bytedock-seam:<id>` 规则；落地 `plugin-sdk` + `plugin-kernel`（同进程 `CloseableScope` + 完整 Revision Pinning 状态机 + 四格存储 + `PluginConfigService` + `PluginScopeBroker` 禁互调）；切开接缝 1/2/3/4/10/15/16；启动 `Upstream Radar` Stage 1。
- [ ] **Week 3–4 · `plugin-egress-guard` 完整首秀 + 无泄漏热重载 MVP**：切开接缝 6（两阶段）/7/8；落地 L1 宿主 100% 网络拦截（含 `dns.lookup`/UDP/Chromium 代理/防递归）+ L2 CLI loopback 代理审计 + **双段 `EgressProof`（活宿主 60s 归因不变量 + 独立离线全禁探针 runner & hash-chained 日志）** + `StreamLog` 审计面板；无泄漏 CJS 热重载（报错保留旧版 + `file:line:column`）。
- [ ] **Week 5–6 · 双轨 CacheGuard `plugin-token-optimizer`**：切开接缝 5；落地 `AdapterCacheProfile` 双轨路由（API 轨全量五铁律 + CI 稳态 `>= 90%`；CLI/ACP 轨 `open-params` + `payload-wrap` + 原生 `/compact` + 宿主层不变量）+ TTFT/TPS/Cache 状态条 + **Context X-Ray 三态诚实账单（`measured`/`native`/`opaque`）**。
- [ ] **Week 7–8 · 首条 `NapCatQQ` 本土 Bot 闭环 + 桌面发布**：切开精简接缝 11（4 Slot）；落地 `plugin-bots-core` 最小版 + `channel-napcat-qq`（OneBot v11、`SOUL.md` 前缀、`MEMORY.md` 追加、Cron 触发、Decision Gate 经 outbox 三端可达，端到端冒烟 10 个扩展点）；打通 GitHub Actions 构建 Windows（`.exe`/`.msi` + 关窗托盘）与 macOS（`.dmg`）；上线 `byte.didyou.eat`（头条放 `EgressProof` + X-Ray + 30 秒 QQ 操控本地 Agent GIF）。

### Milestone 2：`ByteDock v0.2` 护城河版（Dockview 外壳 + 多 Agent 真工程控制 + 本土 Bot 生态 + 任务视角流，约 6–8 周）

- [ ] **外壳升级与多端补全**：在 A/B 类上游移植流水线跑通实战后，落地 **Dockview 自由拖拽分屏（两文件适配层，复用 v0.1 `dockPanel` 容器接口零返工）** + 顶栏多会话标签（单独 ADR）+ 补齐延迟接缝 11 子项/12/13/14 + `plugin-usage-hub`（接缝 9 额度段，多账号配额环 + Usage Events `#50` + 撞限切备号）。
- [ ] **多 Agent 体系升级**：将 `L0→L1→L2` 任务树与共享 worktree 写锁封装进 `plugin-orchestration-pro`，建立插件侧 `DockTask` + `DecisionGate` 共享数据模型，上线 Role Routing Recipes、`Dispatch ID`、协作原语（`/handoff` `/advisor` `/committee`）与 `@bytedock/client` SDK + CLI。
- [ ] **任务管理视角流**：上线 `plugin-task-board`（Kanban 看板态 / `Needs-You` 决策队列态 / **Acan 2D 代理工厂态**，空间画布走 `sandbox-iframe`）。
- [ ] **机器人协作闭环**：补全 `plugin-bots-core`（`SOUL.md` + `MEMORY.md`）+ 本土通道插件（`NapCatQQ` + 飞书 + 钉钉/企微/GitHub）。

### Milestone 3：`ByteDock v0.3` 开放生态版（全端同 UI + 第三方子进程隔离 + 30+ Agent + Creator Mode）

- [ ] **Mobile 原生插件渲染**：补齐 `packages/plugin-ui-renderer/mobile`（React Native 原生绘制冻结 12 原语 + `StreamLog`），实现 Web/Desktop/iOS/Android 全端同 UI。
- [ ] **第三方隔离轨与 Creator Mode**：上线社区 `trusted-worker` 子进程轨（`PluginRemoteContext` 可序列化契约 + 空闲回收 + `community` 重载确认卡）与 `bytedock plugin dev --check --shot` AI 自验证闭环；支持 `bytedock.recipe.yaml` 工作区配方分享。
- [ ] **极致 Agent 兼容面与 P2 侧挂实验件**：开放 `registerProvider` 社区准入（强制过真实录制回放夹具 CI 门禁）+ ACP 16 项扩展；侧挂推进 `plugin-colab-gpu`、同会话 `Chat ↔ Raw CLI` 切换、Paseo `jj` VCS 插件与内联 3D/React Chat Artifacts（`#53`）。

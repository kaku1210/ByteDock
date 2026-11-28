# ByteDock 开发进度与发布总账

> 本文件作为仓库内持续维护的开发进度真源，每次完成里程碑合入、上游同步或版本发布时同步更新。

## 一、当前快照（截至 2026-11-28）

| 维度                                   | 当前状态                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| 默认分支与最新代码提交                 | `main` / `develop`（合入方向 A `65ad7c10be` 与方向 B Bots Core & NapCatQQ 闭环）    |
| 上游同步基线（`upstream-t3code-base`） | `534f28eb75`（`t3code-plus/develop`）                                               |
| 最新已发布桌面版 Release               | `v0.1.0-bytedock.2`（Windows x64 NSIS）                                             |
| 上游缝隙台账（`seam-ledger.json`）     | 14 处缝隙，0 违规（`node scripts/check-seams.ts --base upstream-t3code-base` PASS） |
| 零遥测静态门禁                         | 0 违规（`node scripts/check-zero-telemetry.ts` PASS）                               |
| 内置 AI 控制面 MCP 工具                | 9 个 `bytedock_*` 工具（全部经 `mcp-dynamic-bridge` 延迟发现，`layerTools` 零膨胀） |

---

## 二、已完成里程碑记录

| 阶段                                          | 核心提交                           | 交付摘要                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 0：品牌隔离与插件底座**               | `dc3ce7d2e8` (`v0.1.0-phase0`)     | 建立 `~/.bytedock/` 独立数据目录、零遥测门禁、`seam-ledger.json` + `check-seams.ts`、`@bytedock/plugin-kernel`（Revision / ScopeBroker / KV / Hooks / MCP Bridge / HotReload）与 `plugin-upstream-radar`                                                                                                                                                                         |
| **Phase 1：防火墙与优化内核**                 | `bdea494574`                       | 落地 `builtin.egress-guard`（L1 宿主出站拦截 + Electron 代理强制拦截 + 默认拒绝遥测域名基线 + 双段 `EgressProof`）、`builtin.token-optimizer` 与会话级 Revision Pinning                                                                                                                                                                                                          |
| **Phase 2 & 3：UI 插槽、沙箱、T3 导入与打包** | `2064a1dfe5` (`v0.1.0-bytedock.1`) | 落地 4 个前端 UI 插槽、12 冻结声明式原语与 `PluginSandboxFrame`、`builtin.bots-core` / `community.napcat-qq` / `builtin.legacy-importer`（T3 Code & T3 Code Plus 只读数据导入器）、ByteDock Control Center 与首版 Windows x64 Electron 安装包                                                                                                                                    |
| **AI 控制面一期：配置热更与审批门禁**         | `32a41840f2`                       | 落地 `~/.bytedock/userdata/plugins.yml` + `~/.bytedock/plugins/` 监听热更、`PluginControlPlane` + `PluginApprovalStore`（哈希链审计）、4 个插件控制 MCP 工具（`bytedock_config_read` / `bytedock_plugin_set_enabled` / `bytedock_plugin_config_patch` / `bytedock_plugins_reload`）、防火墙主会话独占限制与 Control Center 审批界面                                              |
| **AI 控制面二期：全域控制与实时 UI 总线**     | `ad56c33923`                       | 新增 `HostControlService` 与 5 个全域聚合 MCP 工具（`bytedock_capabilities_catalog` / `bytedock_settings_control` / `bytedock_plugin_action` / `bytedock_ui_control` / `bytedock_system_control`），覆盖脱敏设置分级读写、快捷键、Provider 审批、安全脚手架、系统/隧道/终端审批闭环，以及基于 `plugins.subscribe` 单订阅流的前端实时 UI 控制总线                                 |
| **上游同步：`t3code-plus` 稳定性增强**        | `a143de8643` (`534f28eb75`)        | 零冲突合入 Antigravity `step_type=132` 后台命令检测与静默完成自动唤醒、`session/resume` 优先恢复、瞬时流/网络错误（含 502/503/504）有界重试、Windows Claude 输出根修复 + Antigravity `task-<idx>.log` 实时 tail 与 Web 后台活动横幅进度展示                                                                                                                                      |
| **方向 A：Token Optimizer 可观测 UI**         | `65ad7c10be`                       | 落地 `TokenOptimizerTelemetry`、`threadSummary` RPC、底部单行 TTFT/TPS/三态诚实缓存指示条、Context X-Ray 账单页、温和防挂死 Watchdog 与全量 10 语言 Web 翻译                                                                                                                                                                                                                     |
| **方向 B：Bots Core & NapCatQQ 业务闭环**     | `feat/bytedock-bots-napcat-qq`     | 落地 `BotsCoreService`（`<stateDir>/bots/` 隔离持久化、确定性 `SOUL.md` 前缀 + Post-Compact 一次性交接、追加式 `MEMORY.md`、Decision Gate）、`NapCatChannelService` + `PluginWebhookHttp`（回环/CORS/Host 硬守卫、OneBot v11 原始体 HMAC、Fail-Closed 白名单、`ServerSecretStore` 隔离、有界异步线程桥接与 Egress 审计回发）、Control Center **Bots & QQ** 标签页及 10 语言 i18n |

---

## 三、已发布版本 Release 台账

| 版本 Tag            | 对应 Commit  | 产物文件名                                                          | 大小（Bytes） | SHA256                                                             | 发布重点                                                                                                                  |
| ------------------- | ------------ | ------------------------------------------------------------------- | ------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `v0.1.0-bytedock.1` | `2064a1dfe5` | `ByteDock-0.1.0-bytedock.1-x64.exe`                                 |   220,807,868 | `2f3bfb53c08e3cf6c8904b8b5ab0a6a4e3ad314d8754464d071aa1b2c305a834` | Phase 0–3 首个完整可运行 Windows 安装包（含 T3 只读导入器与出站防火墙）                                                   |
| `v0.1.0-bytedock.2` | `a143de8643` | `ByteDock-0.1.0-bytedock.2-x64.exe`（附 `.blockmap`、`latest.yml`） |   220,798,312 | `fe2971ec4a52ac8df7631d1e6efb6075ba15a710212ebcd7d7a7869996cde1b7` | 整合 AI 全面控制面（9 个 `bytedock_*` 工具 + 实时 UI 总线 + 分级审批）与 `t3code-plus` `534f28eb75` 后台命令/会话恢复修复 |

---

## 四、当前内置能力与 UI 成熟度矩阵

| 能力 / 内置插件                                | 后端与配置热更                                                                                 | MCP AI 控制                                                                                 | 前端 UI 状态                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `builtin.egress-guard`（出站防火墙）           | ✅ 完整（L1 拦截 + 代理 + 审计）                                                               | ✅ 完整（主会话 + 审批 + `egress_proof`/`egress_audit`）                                    | ✅ 完整（Control Center 面板 + KPI + `EgressProof`）                                                               |
| `builtin.legacy-importer`（T3 只读导入）       | ✅ 完整（只读扫描 + 安全复制 + SQLite 延迟切换）                                               | ✅ 完整（`legacy_scan` + 审批制 `legacy_import`）                                           | ✅ 完整（Control Center Import 标签页）                                                                            |
| `builtin.control-plane` & `HostControlService` | ✅ 完整（`plugins.yml` 热更 + 统一审批 + 哈希链审计）                                          | ✅ 完整（9 个 `bytedock_*` 工具）                                                           | ✅ 完整（审批队列、插件开关/配置编辑器、实时 UI 总线与通知横幅）                                                   |
| `builtin.token-optimizer`                      | ✅ 内核、Hook 观测（`TokenOptimizerTelemetry`）与热更就绪                                      | ✅ 启停/配参/`status`/`threadSummary` + AI 唤起 `xray` 标签页                               | ✅ 完整（底栏 TTFT/总耗时/TPS/三态诚实缓存 + Context X-Ray 账单页 + 温和防挂死 Watchdog）                          |
| `builtin.bots-core` & `community.napcat-qq`    | ✅ 完整（`<stateDir>/bots/` 持久化、SOUL/MEMORY hooks、回环 Webhook/OneBot 桥接、SecretStore） | ✅ 启停/高危审批/只读与 `openGate` + AI 唤起 `bots` 标签页（写人设/自批 Gate/密钥限宿主机） | ✅ 完整（Control Center **Bots & QQ** 面板、4-KPI、SOUL/MEMORY 编管、Decision Gate、密钥配置、连接测试与本地模拟） |
| 外部本地插件（`~/.bytedock/plugins/`）         | ✅ 自动扫描、权限指纹审批与编译热重载                                                          | ✅ `scaffold_local_plugin` + `set_enabled` 审批 + `reload`                                  | ✅ 在 Control Center 插件列表可见可管                                                                              |

---

## 五、未执行验收项与下一阶段待办

### P0 · 近期人工验收（当前状态：`NOT_RUN`）

- [ ] 在真实 Windows 桌面端安装 `v0.1.0-bytedock.2` 并完成实机走查（对应 `openspec/changes/bytedock-full-ai-control/tasks.md` 第 `4.3` 项）：
  - 使用 **Import T3** 从 `~/.t3-plus` 只读导入数据并重启验证项目/线程/设置完整性；
  - 在对话中实测 AI 调用 `bytedock_ui_control`（打开控制中心、跳转设置页、弹出通知横幅）、`bytedock_settings_control`（低风险直改 + 高风险触发审批）、以及人工点击 **Approve & Apply** 执行闭环。

### P1 · 下一阶段产品化增强

- [x] **Token Optimizer & 性能可观测 UI**：常驻单行底栏 `TTFT / 总耗时 / 有效 TPS / 缓存命中率`、单步请求延迟明细（Context X-Ray 三态诚实账单）与防挂死 Watchdog 温和提醒。
- [x] **Bots Core & NapCatQQ 业务闭环 UI**：`SOUL.md` / `MEMORY.md` 编管、ByteDock 线程绑定、Bot Decision Gate、回环 OneBot v11 Webhook/回发与本地模拟面板（真实 QQ 客户端联调保持 `NOT_RUN` 人工验收项）。
- [ ] **工作区壳升级（Dockview 自由分屏）**：以 `Dockview` 替换静态右栏承载插件与多会话自由停靠/布局预设，复用现有 `PluginDockPanelHost` 与 `bytedock_ui_control` 接口。
- [ ] **高频快捷指令**：输入框固定快捷指令（Pinned Quick Commands）。

### P2 · 长期生态与上游演进

- [ ] **Upstream Radar 定时巡检与 `upstream-ledger.jsonl`**：对接 `pingdotgg/t3code` 上游 PR 自动分诊与按需 cherry-pick。
- [ ] **动态 Provider 插件化与原生算力舱**：扩展第三方 Provider 模板及独立可插拔算力舱模块。

## Context

背景与动机见 [proposal.md](proposal.md)，四个新增能力的外部契约见 `specs/`。本变更直接建立在已合并的 `bytedock-ai-control-plane`（`32a41840f2`）之上。

`apps/server/src/server.ts` 的 `layerMakeRoutes` 上下文中已经挂载了所有核心宿主服务：`ServerSettings.ServerSettingsService`、`Keybindings.Keybindings`、`HostResources.HostResources`、`StorageCleanup.StorageCleanup`、`DatabaseStorage.DatabaseStorage`、`ExternalTunnelService.ExternalTunnelService`、`ExternalLauncher.ExternalLauncher`、`TerminalManager.TerminalManager`、`PluginControlPlane.PluginControlPlane` 与 `ThreadManagementService.ThreadManagementService`。

## Goals / Non-Goals

**Goals:**

- 以 5 个高内聚 MCP 工具补全 ByteDock 全部宿主能力控制面（连同既有 4 个插件工具共 9 个 `bytedock_*` 工具），全部继续通过 `McpHttpServer.ts` 既有 `mcp-dynamic-bridge` 缝隙注册，保持 `layerTools` 与 `AgentContextBudget.test.ts` 零变动、保持 `seam-ledger.json` 零新增上游缝隙。
- 建立单一、可审计的统一分级权限引擎：所有高风险宿主操作与防火墙/插件提权共享同一个 `PluginApprovalStore` 队列与 Control Center 审批界面。
- 打通前端 `plugins.subscribe` 控制总线，让 `bytedock_ui_control` 与审批角标在 Web/Desktop 客户端零刷新实时生效。

**Non-Goals:**

- 不绕过 `ServerSettings.redactServerSettingsForClient` 暴露任何真实密钥；不新增上游 `packages/contracts/src/rpc.ts` 方法；不修改上游 Web 路由或布局文件。

## Decisions

| 决策             | 采用方案与理由                                                                                                                                                                                                                                                                                   | 替代方案与取舍                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 工具粒度设计     | 新增 5 个分域聚合工具（`bytedock_capabilities_catalog`、`bytedock_settings_control`、`bytedock_plugin_action`、`bytedock_ui_control`、`bytedock_system_control`）而非平铺 30+ 零散工具                                                                                                           | 避免工具列表膨胀导致模型选择困难，同时通过 `bytedock_capabilities_catalog` 一次暴露所有动作与参数约定                  |
| 宿主服务解耦层   | 新增 `apps/server/src/plugins/HostControlService.ts` 统一封装可选宿主服务句柄（通过 `Effect.serviceOption` 捕获），并在初始化时向 `PluginControlPlane` 注册 `hostMutationExecutor` 回调                                                                                                          | 不把 8 个宿主服务塞进 `PluginControlPlane.make` 参数表，避免破坏既有 `plugins.controlPlane.test.ts` 与孤立测试的简洁性 |
| 统一审批执行闭环 | 扩展 `PluginApprovalStore` 的 `ApprovalKind`/`ApprovalMutation` 联合类型，所有插件级与宿主级审批单统一通过既有 `builtin.control-plane.resolveApproval`（仅 `host-client` 可调）原子消费并分派执行                                                                                                | 避免多套审批队列割裂 UI 体验，确保所有高风险变更在同一处审核并写入同一条哈希链审计日志                                 |
| 宿主设置风险分类 | 维护显式 `HIGH_RISK_SETTINGS_KEYS` 集合（含 Provider、隧道、共享、链接、设备、浏览器访问、默认/自定义模型、运行时模式、密钥提供方等）并始终先跑 `findPlaintextSecretViolation`；不在高风险集合内的常规外观/编辑/侧边栏/通知字段允许低风险直通热更                                                | 比“全部设置都需审批”更顺手，比“全部设置直通”更安全，且未知字段由 `ServerSettings` Schema 校验兜底                      |
| 前端 UI 控制总线 | 复用既有 `WS_METHODS.pluginsSubscribe`（`builtin.control-plane` / `events`）流，在 `PluginUiSlots.tsx` 内挂载轻量订阅器监听 `ui-command`、`approval-created`、`approval-resolved` 与 `state-updated` 事件，直接驱动 `PluginSlotStore`、安全站内路由跳转（`window.history` / router）与状态栏角标 | 零新增上游 WS RPC 与前端缝隙，天然兼容 Web 与 Desktop 双端                                                             |

## 状态、依赖与失败语义

- **依赖方向**：`McpHttpServer (bytedockControl)` / `ws.ts (plugins-rpc-handlers)` → `{ PluginControlPlane, HostControlService }` → `{ PluginApprovalStore, PluginKernel, ServerSettings, Keybindings, HostResources, StorageCleanup, DatabaseStorage, ExternalTunnelService, ExternalLauncher, TerminalManager }`。
- **可选服务降级**：在测试环境或某些宿主服务未挂载时，`HostControlService` 对未挂载服务显式返回 `{ available: false }` 或明确错误 `service_unavailable`，绝不返回伪造的假成功数据。
- **脚手架安全边界**：`scaffold_local_plugin` 严格校验 `pluginId` 格式（`^[a-z0-9][a-z0-9._-]{1,63}$`），拒绝 `..`/路径分隔符/与内置插件冲突/覆盖已有目录，写入后自动触发一次扫描使新插件以 `approved: false, status: "disabled"` 出现在列表，绝不自动编译或启用。
- **审批执行失败保护**：若已批准的宿主动作在执行时失败（如外部隧道启动失败或 `settings.json` 策略锁定），错误显式返回给审批操作人并记录审计，不静默吞错。

## Risks / Trade-offs

- **[高风险设置键随上游新增字段而漂移]** → 将 `HIGH_RISK_SETTINGS_KEYS` 定义为显式集合并对任何含 `secret`/`token`/`provider`/`host`/`tunnel`/`device`/`runtimeMode`/`policy`/`otlp` 子串的键默认归入高风险兜底（fail-safe），防止未来上游新增安全键漏网。
- **[`database_reclaim` 会触发服务端重启]** → 明确标注在审批单 `summary` 与 `reasons` 中提示“批准后将重启 ByteDock 服务端进行离线空间回收”，由用户主动确认。
- **[前端多挂载点重复订阅 `plugins.subscribe`]** → 在模块级单例协调订阅引用计数（仅对当前 `environmentId` 维持 1 条控制面事件订阅），避免 `ChatView` 与 `Settings` 同时打开时重复执行 `ui-command`。

## Migration Plan

- 完全向后兼容，无数据库迁移、无配置文件破坏性变更。回退时可直接回退分支 commits。

## 验证与文档同步

- **自动化测试**：新增 `apps/server/src/plugins.fullControl.test.ts` 覆盖全部 5 个新 MCP 工具、全量设置脱敏读取/分级写入、快捷键管理、Provider 审批、`EgressProof`/审计/T3 扫描与审批导入、本地插件脚手架路径穿越拦截、UI 控制事件流与非法导航拦截、系统状态与高风险系统/隧道/终端审批闭环；加测 `apps/web/src/components/plugin/PluginSlotStore.test.ts` 验证前端 UI 指令与安全路径过滤。
- **既有回归与门禁**：`AgentContextBudget.test.ts`、`McpHttpServer.test.ts`、`plugins.controlPlane.test.ts`、`effect-tsgo`（kernel/server/web）、`vp lint`、`vp run knip:check`、`node scripts/check-seams.ts`、`node scripts/check-zero-telemetry.ts`。

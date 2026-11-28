# Proposal: ByteDock Bots Core Runtime & NapCatQQ OneBot v11 Channel Loop

## Why

ByteDock 当前已在 `plugins/plugin-bots-core` 与 `plugins/channel-napcat-qq` 中具备 `SOUL.md` / `MEMORY.md` 契约、OneBot v11 事件解析器与 R3 Webhook 安全守卫原语，但服务端 `apps/server/src/plugins/BuiltinPluginRuntime.ts` 仍只为 `builtin.bots-core` 和 `community.napcat-qq` 返回静态状态对象，既未挂载真实 OneBot v11 HTTP Webhook 路由，也未接通 `ServerSecretStore`、`PluginKernel` 生命周期钩子、`ThreadManagementService` 线程编排和 ByteDock Control Center 交互界面。用户无法在真实 ByteDock 运行时中管理 Bot 人设与记忆、通过本地回环 NapCatQQ 收发 QQ 消息触发线程任务、或在 Control Center 与 QQ 之间完成 Decision Gate 确认闭环。

本变更在不新增任何上游 seam（保持 `seam-ledger.json` 14 个 seam、0 违规）、不增加 MCP 工具数量（复用现有 9 个 `bytedock_*` 工具）、不落盘明文密钥且保持零遥测的前提下，打通 `builtin.bots-core` + `community.napcat-qq` 的端到端真实业务闭环。

## What Changes

- **Bots Core 运行时与状态存储 (`builtin.bots-core`)**：
  - 新增 `apps/server/src/plugins/BotsCoreService.ts`，在 `<stateDir>/bots/`（生产默认 `~/.bytedock/userdata/bots/`，开发默认 `~/.bytedock/dev/bots/`，复用 `0o700` 目录隔离）下以原子写入持久化 Bot 档案（`bots.json`）、确定性 `SOUL.md`、追加式 `MEMORY.md` 与 `decision-gates.json`（含路径穿越防护、单 Bot 隔离目录与热路径内存缓存）。
  - 注册 `PluginKernel` 生命周期钩子：对已绑定 Bot 的线程，在 `agent.turn.before` 从内存缓存注入基于 `sha256(SOUL.md)` 的确定性前缀上下文（不混入动态时间戳，遵守 ADR-06 KV Cache 零破坏）；在 `agent.compact.before` 输出 `SOUL.md` 锚点与近期 `MEMORY.md` 的 `handoffSummary`，并为压缩后紧随的下一轮普通对话提供一次性 `pendingHandoffSummary` 兜底（兼容 Claude / Codex / ACP 在 slash 命令跳过 `appContext` 的适配器行为）。
  - 实现完整的 Bot Decision Gate 生命周期（`openGate` / `resolveGate` / `listGates`），通过现有 `builtin.control-plane/events` PubSub 广播实时更新事件，并与特权 `ControlPlaneApprovalRequest` 严格隔离（QQ 通道不得绕过宿主机人工审批门禁；MCP 调用方不得自批 Gate 或篡改 `SOUL.md`/线程绑定）。
- **NapCatQQ OneBot v11 通道与安全 HTTP Webhook (`community.napcat-qq`)**：
  - 新增 `apps/server/src/plugins/NapCatChannelService.ts` 与 `apps/server/src/plugins/PluginWebhookHttp.ts`，在 `apps/server/src/server.ts` 复用已有 `// bytedock-seam:kernel-mount` 显式提供 `ServerSecretStore.layer` 给 `PluginControlPlane.layer`，并挂载 `POST /api/plugins/community.napcat-qq/*`（仅放行精确匹配当前 `webhookRoute` 的请求）与 `GET /api/plugins/community.napcat-qq/health`。
  - 入站回环硬守卫：`endpointMode === "loopback-only"` 时校验底层 socket `remoteAddress` 为回环地址（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），拒绝含 `origin` 或反向代理转发头（`x-forwarded-for`、`forwarded`、`cf-connecting-ip`、`x-real-ip`、`x-t3-relay-delivery-id`）的跨站/中继请求（返回 `403`），避免全局 CORS 导致跨站探测或限流 DoS。
  - 扩展 `@bytedock/plugin-kernel` 的 `createWebhookRouteGuard` 与 `EgressGuardController`：支持原始字节体（1 MiB 上限）HMAC-SHA1/SHA256 按前缀分发、`webhookAuthMode: "onebot-hmac" | "hmac-and-bearer"`（默认 `"onebot-hmac"` 兼容真实 NapCatQQ HTTP POST 上报）、OneBot `event.time` ±300s 新鲜度校验、基于内容摘要的防重放、滑动窗口限流、`X-Frame-Options: DENY` / `Cache-Control: no-store`，并统一状态码（`401` Bearer/Secret、`403` HMAC/非回环、`409` Replay、`413` Body Too Large、`429` RateLimit、`503` Disabled/Unconfigured）。
  - 密钥严格走 `ServerSecretStore` + `assertPluginSecretRefAllowed({ pluginId, declaredNamespaces: ["bytedock.napcat"], secretRef })`；`setTokenSecret` / `clearTokenSecret` / `simulateInbound` / `sendReply` 全部标记为 `host-client-only`，严禁 MCP 调用。
  - 入站白名单采用 **Fail-Closed** 策略：真实 Webhook 在 `allowedUserIds` 为空时一律拒绝；群聊消息要求同时命中 `allowedGroupIds` **AND** `allowedUserIds` 且遵循 `requireAtInGroup`（兼容 OneBot v11 `message` 数组段与带参数 `[CQ:at,qq=<self_id>,...]`）。
  - 授权消息支持 Bot 指令（`/status`、`/gates`、`/approve <gateId>`、`/reject <gateId>`、`/memory <note>`）或通过 `ThreadManagementService.sendToThread`（`mode: "queue"`, `createdBy: "user"`, `creationSource: "server"`）+ 服务级 `Scope` 有界并发后台 fiber（`Effect.forkIn(serviceScope)`）等待该 `runId` 结束并提取对应 assistant 回复，经回环硬校验 + `guardedLookupAll` + `EgressGuard` 审计 + `redirect: "error"` 禁止重定向后回传本地 NapCatQQ OneBot v11 HTTP API（`/send_private_msg`、`/send_group_msg`），同时追加摘要至 `MEMORY.md`。
- **配置 Schema 向后兼容扩展与提权保护**：
  - 扩展 `packages/plugin-kernel/src/pluginConfigSchemas.ts` 的 `BotsCoreConfigSchema`（`autoReplyEnabled`、`replyMaxChars`、`turnWaitTimeoutSec`）与 `NapcatQqConfigSchema`（`oneBotBaseUrl`、`webhookAuthMode`、`tokenSecretRef`、`allowedUserIds`、`allowedGroupIds`、`requireAtInGroup`，并将 `::1` 加入默认回环白名单）。
  - 在 `assessConfigPatchPrivilege` 中将修改 `oneBotBaseUrl`、`tokenSecretRef`、`webhookRoute`、`webhookAuthMode`、变更 `allowedUserIds`/`allowedGroupIds`、关闭 `requireAtInGroup` 以及关闭 `soulPrefixGuard` 全部列为 `high` 风险（要求主会话 + 人类审批），杜绝 MCP 越权放开白名单或本机端口 SSRF。
- **ByteDock Control Center Bots & QQ 面板、状态栏与全量 10 语言 i18n**：
  - 在 `ByteDockControlCenterModal` 新增 **Bots & QQ** Tab，整合 4-KPI 声明式概览卡片、Bot 档案与 `SOUL.md` 编辑器（含 SHA-256 指纹）、追加式 `MEMORY.md` 查看与追加、ByteDock 线程绑定、Decision Gate 交互队列、NapCatQQ 配置/掩码密钥设置/连接诊断/本地模拟及活动日志。
  - 在底部状态栏与设置侧栏提供 Bots & QQ 入口及初始化+实时同步的待处理 Decision Gate 计数徽标；扩展 `bytedock_ui_control` 的 `open_control_center` 支持 `tab: "bots"`。
  - 同步更新 `apps/web` 全量 10 套语言目录（`en`、`zh`、`de`、`es`、`fr`、`ja`、`ko`、`pt-BR`、`ru`、`sv`）并通过 `i18n-check`。

## Capabilities

### New Capabilities

- `bytedock-bots-core-runtime`: Persistent ByteDock bot profiles under `<stateDir>/bots/`, deterministic `SOUL.md` prefix injection with memory cache, append-only `MEMORY.md` with compaction & post-compact one-shot handoff, thread binding, and Decision Gate lifecycle with strict separation from privileged host approvals.
- `bytedock-napcat-qq-channel`: Loopback-hardened OneBot v11 HTTP webhook ingestion, `ServerSecretStore`-backed secret resolution in the `bytedock.napcat` namespace, fail-closed allowlists, loopback-only Egress-Guard-audited OneBot v11 outbound delivery without redirects, command routing, bounded async thread orchestration bridge, and diagnostics.
- `bytedock-bots-control-ui`: ByteDock Control Center **Bots & QQ** tab, hydrated status-bar Decision Gate badge, `bytedock_ui_control(tab: "bots")` integration, host-client-only secret setup UX, and full 10-locale translations.

### Modified Capabilities

- None（所有既有能力保持向后兼容，新增与扩展契约由上述 3 项 capability 规格完整定义）。

## Impact

- **受影响包与模块**：
  - `packages/plugin-kernel`: `src/egressGuard.ts`、`src/webhookGuard.ts`、`src/pluginConfigSchemas.ts`、`src/pluginConfigSchemas.test.ts`
  - `apps/server`: 新增 `src/plugins/BotsCoreService.ts`、`src/plugins/NapCatChannelService.ts`、`src/plugins/PluginWebhookHttp.ts`、`src/plugins/BotsNapCatBridge.test.ts`；更新 `src/plugins/BuiltinPluginManifests.ts`、`src/plugins/BuiltinPluginRuntime.ts`、`src/plugins/PluginControlPlane.ts`、`src/plugins/HostControlService.ts`、`src/mcp/toolkits/bytedockControl/tools.ts`、`src/server.ts`（仅复用已有 `kernel-mount` seam）、`src/plugins.fullControl.test.ts`
  - `apps/web`: 新增 `src/components/plugin/BotsNapCatPanel.tsx`、`src/components/plugin/BotsNapCatPanel.browser.test.tsx`；更新 `src/components/plugin/PluginSlotStore.ts`、`src/components/plugin/PluginSlotStore.test.ts`、`src/components/plugin/ByteDockControlCenterModal.tsx`、`src/components/plugin/PluginUiSlots.tsx`、`src/i18n/translations/*.json`
  - `seam-ledger.json`（仅同步 `kernel-mount` 的说明性 `tagCount: 2`，seam 总数保持 14）、`docs/bytedock/DEVELOPMENT_STATUS.md`
- **架构与安全底线**：
  - `seam-ledger.json` 保持 14 个 seam、0 违规。
  - `McpHttpServer` 工具数量保持 9 个 `bytedock_*` 工具不变，`AgentContextBudget.test.ts` 保持通过。
  - 零新增遥测外联，`check-zero-telemetry.ts` 保持 0 违规。
  - 绝不读写 `D:\Project\AgentLearn\t3code`、`~/.t3` 或 `~/.t3-plus`。
- **非目标（本变更不包含）**：
  - 不实现反向 WebSocket（Reverse WS）连接器或公网暴露中继（仅保留本地回环 OneBot v11 HTTP Webhook + HTTP API）。
  - 不允许 QQ 消息或 MCP 调用方直接批准高危宿主机特权审批（`ControlPlaneApprovalRequest` 必须仍由宿主机主会话人类在 Control Center 中审批）。
  - 不包含需要真实 QQ 账号与本地 NapCatQQ 桌面进程在线登录的自动化 E2E（该项作为明确的人工验收项保留为 `NOT_RUN`）。

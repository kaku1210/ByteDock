# Design: ByteDock Bots Core Runtime & NapCatQQ OneBot v11 Channel Loop

## Context

ByteDock 已在 Phase 0–3 与 Direction A 中建成：

1. `@bytedock/plugin-kernel`（`packages/plugin-kernel`）：含 `PluginKernel`（hooks/broker/revisions/egress）、`createWebhookRouteGuard`（R3 Webhook 验签/防重放/限流/响应头）、`pluginConfigSchemas.ts`（schema 校验 + 禁明文密钥 + 提权分级）。
2. `PluginControlPlane`（`apps/server/src/plugins/PluginControlPlane.ts`）：管理 `plugins.yml` 热更新、`~/.bytedock/plugins` 扫描、审批流与 `builtin.control-plane/events` 实时 PubSub。
3. `HostControlService` + 9 个固定 `bytedock_*` MCP 工具（`AgentContextBudget.test.ts` 保护零工具膨胀）。
4. `ServerSecretStore`（`apps/server/src/auth/ServerSecretStore.ts`，`0o700` 文件存储）与 `assertPluginSecretRefAllowed`（`apps/server/src/secrets/SecretResolver.ts` 既有 seam `secret-ns-broker`）。
5. `ThreadManagementService`（`listProjectThreads`、`sendToThread`、`waitForThread`、`getThreadProjection`）以及 `RunExecutionService` 中已挂载的 `agent.turn.before` / `agent.compact.before` hooks（既有 seam `run-turn-contrib`）。

当前缺口：`builtin.bots-core` 和 `community.napcat-qq` 仍只是静态状态响应，尚未在 `apps/server` 和 `apps/web` 跑通完整业务链路。

## Goals / Non-Goals

- **Goals**:
  1. 零新增上游 seam（保持 `seam-ledger.json` 14 个 seam、0 违规），仅复用 `apps/server/src/server.ts` 已有 `// bytedock-seam:kernel-mount`。
  2. 零 MCP 工具数增长（继续复用现有 9 个 `bytedock_*` 工具）。
  3. 端到端闭环：回环隔离 HTTP Webhook -> R3 验签/新鲜度/防重放/限流 -> Fail-Closed 白名单与 `@bot` / 指令解析 -> `BotsCoreService`（内存缓存 `SOUL.md` 确定性前缀 + 追加式 `MEMORY.md` + Decision Gate）-> 服务级 `Scope` 有界并发 `ThreadManagementService` 线程调度与按 `runId` 精确回收回复 -> 硬回环 + `guardedLookupAll` + Egress Guard 审计 + `redirect: "error"` 回传 OneBot v11 -> Control Center 实时 UI。
  4. 严格密钥与权限隔离：Token 仅经宿主机前端写入 `ServerSecretStore`（命名空间 `bytedock.napcat`），永不落盘 `plugins.yml`；MCP 禁止调用写人设/自批 Gate/密钥/模拟入站 RPC，敏感配置变更必须走主会话人工审批。
- **Non-Goals**:
  1. 不新增反向 WebSocket 通道或公网穿透中继。
  2. 不修改 `D:\Project\AgentLearn\t3code`、`~/.t3`、`~/.t3-plus`。
  3. 不在自动化测试中伪造“真实 QQ 桌面端联调通过”。

## Decisions

### Decision 1: Zero-New-Seam Layer & HTTP Webhook Wiring (Addressing P0-1, P0-3, P2-1)

- **Effect 4 Layer 依赖方向（关键修正）**：
  - 在 `apps/server/src/server.ts:906-910` 既有 `// bytedock-seam:kernel-mount` 块内显式向 `PluginControlPlane.layer` 提供模块级单例 `ServerSecretStore.layer`（与 `server.ts:304/604/609/615/878/882/1454` 一致，Effect 按引用 memoize 共享同一实例）：
    ```ts
    Layer.provideMerge(
      PluginControlPlane.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provideMerge(PluginKernel.PluginKernelLive),
      ),
    ),
    ```
  - `PluginControlPlane.layer` 内部仍通过 `Effect.serviceOption(ServerSecretStore.ServerSecretStore)` 获取（便于无 `ServerSecretStore` 的轻量单测），生产运行时确保 100% 拿到真实实例。
- **单通配 Webhook 路由与 `GET /health`**：
  - 新建 `apps/server/src/plugins/PluginWebhookHttp.ts`，导出 `routeLayer = HttpRouter.use(...)`，在 `server.ts` 的 `layerMakeRoutes` 复用 `// bytedock-seam:kernel-mount` 挂载（并更新 `seam-ledger.json` 的说明性 `tagCount: 2`，seam 总数保持 14）。
  - `POST` 仅挂载单条路由 `POST /api/plugins/community.napcat-qq/*`，在 handler 中精确比对 `url.pathname === activeConfig.webhookRoute`（修改路由后零旧路由残留，不匹配返回 `404`）。
  - `GET /api/plugins/community.napcat-qq/health` 独立静态路由（在 FindMyWay 中优先于 `layerStaticAndDevRoute` 的 `GET *`），仅返回 `{ ok: true, enabled }`。
  - `routeLayer` 同时通过 `Effect.serviceOption(ThreadManagementService.ThreadManagementService)` 获取真实线程编排服务并调用 `controlPlane.setThreadBridge(...)` 注入，避免修改 `ws.ts`。
- **入站回环隔离与校验顺序**：
  - 针对 `endpointMode === "loopback-only"`，优先校验底层 socket `remoteAddress` 为 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 并拒绝携带 `origin`、`x-forwarded-for`、`forwarded`、`cf-connecting-ip`、`x-real-ip`、`x-t3-relay-delivery-id` 的请求（返回 `403` + `X-Frame-Options: DENY` + `Cache-Control: no-store`），彻底隔离全局通配 CORS 跨站探测与限流 DoS。
  - `POST` 校验顺序：回环与头检查（`403`）-> 路径匹配 `webhookRoute`（`404`）-> 插件启用与密钥存在性检查（`503`，不消耗限流配额）-> 原始字节体读取（1 MiB 上限，`413`）-> `WebhookRouteGuard` 校验（`401` / `403` / `409` / `429`）。

### Decision 2: Persistent Storage Layout Under `<stateDir>/bots/` (Addressing P1-3)

- 统一存放在 `<stateDir>/bots/`（生产默认 `~/.bytedock/userdata/bots/`，开发默认 `~/.bytedock/dev/bots/`，自动继承 `config.ts:222` 的 `0o700` 目录权限与 dev/prod 环境隔离）：
  - `<stateDir>/bots/bots.json`：Bot 档案列表（原子写入：同目录临时文件 + `renameSync`）。
  - `<stateDir>/bots/<botId>/SOUL.md`：静态人设 Markdown；更新时同步重算 `sha256(soulMarkdown)` 并刷新内存缓存。
  - `<stateDir>/bots/<botId>/MEMORY.md`：严格追加式记忆文件（禁止覆写旧行）。
  - `<stateDir>/bots/decision-gates.json`：Bot Decision Gate 列表（保留最近 200 条）。
- Bot ID 强制校验 `^[a-z0-9][a-z0-9._-]{0,47}$` 并用 `NodePath.resolve` 二次校验路径边界。

### Decision 3: Prompt Cache-Safe `SOUL.md` Injection & Post-Compact Handoff (Addressing P1-5, P2-3)

- `BotsCoreService` 在内存中维护 `botsById`、`soulByBotId`、`boundBotByThreadId` 与 `pendingHandoffByThreadId`，`agent.turn.before` 热路径**零同步磁盘 I/O**（在 500ms hook 总预算内耗时 < 1ms）。
- `agent.turn.before`（priority `20`, `onError: "pass"`, `timeoutMs: 150`）：
  - 若 `threadId` 命中已启用 Bot 且 `soulPrefixGuard !== false`：构造确定性前缀块：
    ```text
    [ByteDock Bot Soul | bot=<id> | sha256=<soulPrefixHash>]
    <SOUL.md exact content>
    ```
    （不含任何动态时间或轮次号，保证跨轮前缀哈希稳定）。
  - 若该 `threadId` 存在一次性 `pendingHandoffSummary`（由刚发生的 `agent.compact.before` 写入），在本次普通轮次将其附加一次并立即消费清除；此举确保 Claude / Codex / ACP 等在 slash `/compact` 跳过 `appContext` 的适配器仍能无损衔接记忆，同时后续稳态轮次回归纯 `SOUL.md` 零漂移。
- `agent.compact.before`（priority `20`, `onError: "pass"`, `timeoutMs: 250`）：
  - 返回包含 Bot ID、`soulPrefixHash` 与 `MEMORY.md` 最近 20 行（≤2000 字符）的 `handoffSummary`，并写入 `pendingHandoffByThreadId`。

### Decision 4: Webhook Auth Compatibility, Secret Namespace & Privilege Gates (Addressing P0-4, P0-5, P1-2)

- **OneBot v11 协议兼容**：
  - 扩展 `packages/plugin-kernel/src/webhookGuard.ts`：`hmac` 支持多算法前缀分发（`algorithms?: ReadonlyArray<"sha1" | "sha256">` 兼容旧单算法 `algorithm`），并支持 `requireBearer?: boolean`（默认 `true` 保持既有契约；`"onebot-hmac"` 时设为 `false` 并强制 `X-Signature` 校验）。
  - `NapcatQqConfigSchema` 新增 `webhookAuthMode: "onebot-hmac" | "hmac-and-bearer"`（默认 `"onebot-hmac"` 兼容真实 NapCatQQ HTTP POST 上报）。
  - `NapCatChannelService` 校验 OneBot `event.time` 落在当前 `Clock` ±300s 内（过期返回 `409`），并用 `sha256(rawBody)` 作为 `replayKey`；仅当请求显式提供 `x-bytedock-seq` 头时启用单调 `seq`，不误拒同秒并发消息与 `meta_event` 心跳。
- **密钥与命名空间校验**：
  - `NapcatQqConfigSchema.tokenSecretRef` 严格校验 `/^bytedock\.napcat\.[A-Za-z0-9_-]{1,128}$/`（禁止 key 段含 `.`，与 `SecretResolver.ts:24` 完全一致）。
  - 调用 `assertPluginSecretRefAllowed({ pluginId: "community.napcat-qq", declaredNamespaces: ["bytedock.napcat"], secretRef })`。
- **MCP 权限边界与提权审批**：
  - `HostControlService.ts` + `BuiltinPluginRuntime.ts`（`callerKind === "mcp"`）：
    - `builtin.bots-core` 仅放行 `status`、`getState`、`listThreads`、`openGate`、`appendMemory`；显式拒绝 `resolveGate`、`upsertBot`、`updateSoul`、`deleteBot`（`host_client_required`）。
    - `community.napcat-qq` 仅放行 `status`、`testConnection`；显式拒绝 `setTokenSecret`、`clearTokenSecret`、`simulateInbound`、`sendReply`（`host_client_required`）。
  - `assessConfigPatchPrivilege`：
    - `community.napcat-qq` 修改 `oneBotBaseUrl`、`tokenSecretRef`、`webhookRoute`、`webhookAuthMode`、修改 `allowedUserIds` / `allowedGroupIds`、或关闭 `requireAtInGroup` -> `high`（主会话 + 人类审批）。
    - `builtin.bots-core` 关闭 `soulPrefixGuard` -> `high`（主会话 + 人类审批）。
  - `BuiltinPluginManifests.ts` 所有写/操作方法 `minScopes` 均为 `[AuthOrchestrationOperateScope]`。

### Decision 5: Fail-Closed Allowlist, Service-Scoped Bounded Dispatch & Hard Loopback Outbound (Addressing P0-2, P1-1, P1-4, P2-2)

- **Fail-Closed 入站白名单与原生 OneBot v11 解析**：
  - 真实 Webhook 若 `allowedUserIds.length === 0`，直接返回 `200 { accepted: false, reason: "allowlist-empty" }`。
  - 私聊要求 `userId` 命中 `allowedUserIds`；群聊要求 `groupId` 命中 `allowedGroupIds` **AND** `userId` 命中 `allowedUserIds`。
  - 原生解析器使用 Effect `Clock`（零 `new Date()`），同时兼容 `message` 数组段（`{ type: "at", data: { qq } }` / `{ type: "text", data: { text } }`）和字符串 CQ 码（`\[CQ:at,qq=${selfId}(?:,[^\]]*)?\]` / `@bot`）。
- **服务级 `Scope` 有界异步线程桥接**：
  - `NapCatChannelService` 持有 `PluginControlPlane` 初始化时捕获的 `serviceScope` 与 `Semaphore.make(4)`，使用 `Effect.forkIn(serviceScope)` 执行后台调度，HTTP Handler 立刻返回 `202` 且不受请求 Scope 关闭中断，也不在服务停止时泄漏。
  - 调用 `sendToThread({ projectId, threadId, commandId, messageId, text, attachments: [], mode: "queue", createdBy: "user", creationSource: "server" })`，用返回的 `sendResult.run.id` 调 `waitForThread({ projectId, threadId, runId: sendResult.run.id, timeoutMs })`，再从 `getThreadProjection(threadId)` 筛选 `runId === sendResult.run.id && role === "assistant"` 提取本次回复。
- **硬回环 + Egress Guard 出站**：
  - 在 `packages/plugin-kernel/src/egressGuard.ts` 新增 `evaluateRequest({ pluginId, url, method })` 封装 `evaluateHostPolicy` + `recordAudit`，并默认将 `::1` 加入 `NapcatQqConfig` `allowedHosts` 与 `BuiltinPluginManifests.ts` `networkHosts`。
  - 每次出站请求前执行独立硬校验（不依赖 `audit-only`）：校验协议 `http:`/`https:`、禁止 `username`/`password`/`search`/`hash`、去除 IPv6 方括号后校验回环白名单、`localhost` 走 `guardedLookupAll` 确认全回环 IP、校验正整数 `user_id`/`group_id`、调用 `kernel.egress.evaluateRequest(...)`（若拒绝则中止）、`fetch(..., { redirect: "error", signal: AbortSignal.timeout(10_000) })`。

### Decision 6: Frontend UX, Initial Hydration & Live Sync (Addressing P2-3)

- 同步更新全部 4 处 `tab` 联合类型（`PluginControlPlane.ts`、`HostControlService.ts`、`mcp/toolkits/bytedockControl/tools.ts`、`PluginSlotStore.ts`）加入 `"bots"`。
- `PluginSlotStore` 监听 `state-updated`、`bots-updated`、`decision-gate-created`、`decision-gate-resolved`、`napcat-event`，维护 `pendingDecisionGateCount` 与 `botsRevision`。
- `PluginControlBusBridge` 在环境就绪后拉取一次 `builtin.bots-core.status` 初始化 `pendingDecisionGateCount`，刷新页面未打开 Modal 也能准确显示徽标。
- `ByteDockControlCenterModal` 新增 **Bots & QQ** Tab，渲染独立组件 `BotsNapCatPanel.tsx`。

## Risks / Trade-offs

- **风险 1：`server.ts` 严格 seam 阈值（`driftThresholdPct: 5`）**
  - 缓解：仅在 `server.ts` 新增 1 行 `// bytedock-seam-import:kernel-mount`、修改 1 行已有 `kernel-mount` 块（补 `Layer.provide(ServerSecretStore.layer)`）与 3 行 `// bytedock-seam:kernel-mount` 挂 `PluginWebhookHttp.routeLayer`，并实测 `check-seams.ts --base upstream-t3code-base` 0 违规。
- **风险 2：真实 QQ / NapCatQQ 桌面端在当前环境不可用**
  - 缓解：后端完整覆盖真实 HTTP 路由、回环/CORS/代理头拦截、签名/防重放/限流、SecretStore、ThreadBridge Mock 与本地回环 mock OneBot HTTP Server 的端到端测试；真机手测在 `tasks.md` 诚实保留 `NOT_RUN`。

## Migration Plan

- `plugins.yml` 向后兼容：旧配置仅含原有字段时由 `validatePluginConfig` 合并安全默认值（`allowedUserIds: []` fail-closed、`webhookAuthMode: "onebot-hmac"`、`oneBotBaseUrl: "http://127.0.0.1:3000"`），无需手工迁移。
- `<stateDir>/bots/` 在首次初始化时自动创建，零破坏既有数据。

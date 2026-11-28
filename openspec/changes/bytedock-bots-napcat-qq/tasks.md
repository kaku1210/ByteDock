# Tasks: ByteDock Bots Core Runtime & NapCatQQ OneBot v11 Channel Loop

## 1. OpenSpec 规范与全自动审核

- [x] 1.1 起草 `openspec/changes/bytedock-bots-napcat-qq/` 全部工件（`.openspec.yaml`、`proposal.md`、3 个 `specs/*/spec.md`、`design.md`、`tasks.md`）
- [x] 1.2 运行 `openspec validate bytedock-bots-napcat-qq --strict` 并确认零错误通过
- [x] 1.3 运行全自动安全与架构审查（只读审查子代理）并将全部 P0/P1/P2 发现项修订回 OpenSpec 并复验通过

## 2. Config Schema 与内核扩展 (`@bytedock/plugin-kernel`)

- [x] 2.1 扩展 `packages/plugin-kernel/src/egressGuard.ts` 新增 `evaluateRequest`，扩展 `src/webhookGuard.ts` 支持多算法 HMAC 前缀分发、可选 `requireBearer` 与原子重放校验提交（向后兼容旧契约）
- [x] 2.2 扩展 `packages/plugin-kernel/src/pluginConfigSchemas.ts` 的 `BotsCoreConfigSchema` 与 `NapcatQqConfigSchema`（回环 `oneBotBaseUrl` / `allowedHosts` 无凭据/查询串、`webhookRoute` 命名空间、`^bytedock\.napcat\.[A-Za-z0-9_-]{1,128}$` 校验、默认含 `::1`），并在 `assessConfigPatchPrivilege` 将敏感 NapCatQQ 与 `soulPrefixGuard` 关闭变更升级为 `high` 审批
- [x] 2.3 更新 `packages/plugin-kernel/src/pluginConfigSchemas.test.ts` 覆盖新增字段、回环/凭据拒绝、secretRef 格式拒绝、提权分级与向后兼容旧配置

## 3. Bots Core & NapCatQQ 服务端运行时 (`apps/server`)

- [x] 3.1 新建 `apps/server/src/plugins/BotsCoreService.ts`：实现 `<stateDir>/bots/` 原子持久化与内存缓存、`SOUL.md` 确定性前缀与 SHA-256 哈希、追加式 `MEMORY.md`、Decision Gate 生命周期及 `agent.turn.before` / `agent.compact.before`（含一次性 `pendingHandoffSummary`）
- [x] 3.2 新建 `apps/server/src/plugins/NapCatChannelService.ts`：实现 `ServerSecretStore` + `assertPluginSecretRefAllowed(..., declaredNamespaces)` 密钥解析、R3 Webhook 鉴权与 `event.time` ±300s 防重放、Fail-Closed 白名单与原生数组段/CQ 码解析、指令路由、服务级 `Scope` + 有界 `Semaphore` 线程调度与按 `runId` 回收回复、硬回环 + `guardedLookupAll` + `EgressGuard` + `redirect: "error"` 出站、连接探测与本地模拟
- [x] 3.3 新建 `apps/server/src/plugins/PluginWebhookHttp.ts`（单通配 `POST /api/plugins/community.napcat-qq/*` + 最小 `GET /health` + 入站回环/Host/代理头/Origin 拦截），并在 `apps/server/src/server.ts` 复用既有 `// bytedock-seam:kernel-mount` 补齐 `Layer.provide(ServerSecretStore.layer)` 与路由挂载（零新增 seam，同步 `seam-ledger.json` `tagCount`）
- [x] 3.4 更新 `BuiltinPluginManifests.ts`、`BuiltinPluginRuntime.ts`、`PluginControlPlane.ts`、`HostControlService.ts` 与 `apps/server/src/mcp/toolkits/bytedockControl/tools.ts`：注册全部 RPC 方法（写方法均为 `OperateScope`）、扩展 `tab: "bots"`、强制 `host-client-only` 拦截 MCP 越权调用及启停审批门禁
- [x] 3.5 新增 `apps/server/src/plugins/BotsNapCatBridge.test.ts` 并扩展 `apps/server/src/plugins.fullControl.test.ts`，覆盖回环/Host/Origin/代理头拦截、Webhook 安全矩阵（400/401/403/409/413/429/503）、Fail-Closed 白名单、SecretStore 隔离、线程编排、本地回环 OneBot HTTP 端到端回发、Decision Gate、Post-Compact Handoff 与 MCP 越权拒绝

## 4. Control Center UI、状态栏与全量 10 语言 i18n (`apps/web`)

- [x] 4.1 更新 `apps/web/src/components/plugin/PluginSlotStore.ts` 与 `PluginSlotStore.test.ts`：扩展 `ByteDockModalTab` 含 `"bots"`、监听 `state-updated` / `bots-updated` / `decision-gate-*` / `napcat-event` 事件与实时计数
- [x] 4.2 新建 `apps/web/src/components/plugin/BotsNapCatPanel.tsx`：实现 4-KPI 声明式概览、`SOUL.md` 编辑、`MEMORY.md` 追加、线程绑定、Decision Gate 操作队列、NapCatQQ 配置/Fail-Closed 提示/掩码密钥设置/连接诊断/本地入站模拟与活动日志
- [x] 4.3 更新 `ByteDockControlCenterModal.tsx` 与 `PluginUiSlots.tsx` 接入 **Bots & QQ** Tab、状态栏/侧栏快捷入口与连接初始化 `pendingDecisionGateCount` 同步
- [x] 4.4 新增 Chromium 浏览器测试 `apps/web/src/components/plugin/BotsNapCatPanel.browser.test.tsx`
- [x] 4.5 在 `apps/web` 运行 `gt generate` 并补全全部 9 个非英文语言目录翻译（`zh`、`de`、`es`、`fr`、`ja`、`ko`、`pt-BR`、`ru`、`sv`），通过 `node scripts/i18n-check.ts`

## 5. 全量验证、全自动代码审查与分支交付

- [x] 5.1 运行全部静态与安全门禁：`vp fmt`、`vp lint --quiet`、三包 `typecheck`、`knip:check`、`i18n-check.ts`、`check-seams.ts --base upstream-t3code-base`、`check-zero-telemetry.ts`、`openspec validate --strict`
- [x] 5.2 运行定向服务端、插件内核、MCP 预算与 Chromium 浏览器测试并全部通过
- [x] 5.3 执行全自动代码安全与缺陷审查（只读审查子代理），全部修复 5 项 P1 与 5 项 P2 发现项并复验通过
- [x] 5.4 更新 `docs/bytedock/DEVELOPMENT_STATUS.md` 并同步勾选本清单已验证项
- [x] 5.5 提交推送 `feat/bytedock-bots-napcat-qq`，并合并推送至远端 `develop` 与 `main` 后复核远端头与门禁

## 6. 人工真机验收（本环境无真实 QQ / NapCatQQ 客户端，保留 NOT_RUN）

- [ ] 6.1 `[NOT_RUN - Manual Desktop/QQ Walkthrough]` 在本地运行真实 NapCatQQ 客户端配置 OneBot v11 HTTP 上报指向 ByteDock `http://127.0.0.1:<port>/api/plugins/community.napcat-qq/onebot/event`，用真实 QQ 私聊/群聊 `@bot` 发送任务与 `/approve <gateId>` 并核实真机收发体验

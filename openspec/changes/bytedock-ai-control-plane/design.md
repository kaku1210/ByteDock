## Context

动机与验收边界见 [proposal.md](proposal.md)，外部可观察行为契约见 `specs/` 下三个能力规格。

当前代码底座已具备以下可直接复用的核心组件，但尚未串联为完整控制面：

- `packages/plugin-kernel/src/configService.ts`：已实现单写者、`mtimeMs` CAS 乐观锁与 Windows Defender 退避重试的 `plugins.yml` 读写句柄，尚未挂载到 `PluginKernelLive` 与磁盘监听。
- `packages/plugin-kernel/src/hotReload.ts` 与 `revision.ts`：已实现内容哈希去重、esbuild 内存编译、失败保留旧版以及会话 Revision 钉住与排空。
- `packages/plugin-kernel/src/egressGuard.ts`：已提供 `getPolicy()` / `updatePolicy(next)` 与哈希链审计日志。
- `apps/server/src/serverSettings.ts` 与 `watchDirectoryReplacements.ts`：已有成熟可靠的 `fs.watch` + 100ms 防抖 + 原子重命名监听范式。
- `apps/server/src/mcp/McpHttpServer.ts`、`McpToolAccess.ts`、`McpToolExposure.ts`、`threadAccess.ts`：已提供线程/子代理/只读客户端/linked 调用方判定与 `tool_search` 延迟暴露；`AgentContextBudget.test.ts` 对 `McpHttpServer.layerTools` 做严格字节数预算门禁。
- `seam-ledger.json`：对 14 处上游缝隙实行严格 diff 检查（`scripts/check-seams.ts`）。

## Goals / Non-Goals

**Goals:**

- 在不新增任何上游 `seam-ledger.json` 缝隙、不突破 `AgentContextBudget.test.ts` 的前提下，打通“配置文件 → 文件监听 → 内存运行态 → 内置 MCP → Control Center UI”全链路。
- 复用已有 WS RPC（`plugins.list` / `plugins.reload` / `plugins.invoke` / `plugins.subscribe`）承载 UI 控制与审批裁决，避免修改 `packages/contracts/src/rpc.ts` 与 `RpcAuthorization.ts`。
- 保证普通插件启停与配置热更即改即生效，防火墙修改仅主会话可发起，重要权限变更必须经过非阻塞异步人工审核后才落盘。

**Non-Goals:**

- 不引入外部插件目录映射、不开发独立 CLI、不暴露或写入明文密钥、不新增上游 UI 文件缝隙、不改动 `settings.json` 现有语义。

## Decisions

| 决策                         | 采用方案与理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 已有实现或替代方案的取舍                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 持久化真源与默认路径         | 在 `apps/server/src/config.ts` 的 `ServerDerivedPaths` 派生 `pluginConfigPath = join(stateDir, "plugins.yml")` 与 `pluginsDir = join(baseDir, "plugins")`，复用 `makePluginConfigService` 读写                                                                                                                                                                                                                                                                                    | 放弃将配置存入 SQLite KV 表作为主真源：纯文本 YAML 可读、可手改、可备份，且 `configService.ts` 已经实现完整 CAS 与原子写                                                                                                                                                  |
| 控制面服务层归属             | 新增 `apps/server/src/plugins/PluginControlPlane.ts`（Effect Service），统一持有 `PluginConfigServiceHandle`、每插件运行态快照（`enabled`/`config`/`status`/`lastDiagnostic`）、`fs.watch` 监听纤维、审批存储与事件 `PubSub`，通过 `apps/server/src/server.ts` 既有 `kernel-mount` 缝隙注入                                                                                                                                                                                       | 不将热更与审批状态堆在 `ws.ts` 连接级上下文里：必须服务级单例，使所有 WS 客户端、MCP 会话和后台文件监听共享同一状态                                                                                                                                                       |
| 内置插件与 Hooks 启停机制    | `PluginControlPlane` 维护已启用插件集合与配置快照；`BuiltinPluginRuntime` 按 `enabled` 返回 `active` / `disabled`，停用时跳过其 Hooks/动态工具并拒绝其业务 `plugins.invoke`；`egress.updatePolicy` 实时消费合并后的 `builtin.egress-guard` 配置并恒保留 `DEFAULT_DENIED_DOMAINS`                                                                                                                                                                                                  | 放弃停用内置插件时强拆 `RevisionManager` 内置清单：保留描述符并标为 `disabled` 才能让用户与 AI 在列表里看到并重新启用，避免“单向门”                                                                                                                                       |
| 内置 MCP 挂载位置            | 新增 `apps/server/src/mcp/toolkits/bytedockControl/{tools.ts,handlers.ts}`，在 `McpHttpServer.ts` 既有 `// bytedock-seam:mcp-dynamic-bridge` 块中导出 `layerByteDockControlToolkit` 并合并进 `McpHttpServer.layer`（**置于 `layerTools` 之外**）                                                                                                                                                                                                                                  | 若直接放进 `layerTools`，会立刻突破 `AgentContextBudget.test.ts` 锁定的 `mcpToolListJsonBytes: 63355` 预算；置于 `McpHttpServer.layer` 既被 `layerToolExposure` 自动纳入 `tool_search`，又保持 `layerTools` 零字节增量                                                    |
| 主会话判定规则               | 防火墙修改路径调用专用 `assertMainSessionCaller`：校验 `scope.thread !== undefined`、`scope.thread.subagent !== true`、`!isTaskChildLineage(caller.lineage)`、`assertNotLinked`、`assertLiveCaller`、`refuseReadOnlyClient` 与活跃 Run 锁内二次校验                                                                                                                                                                                                                               | 不复用宽松的 `writes` 或允许外部客户端的 `writesEnvironment`：外部 OAuth 客户端与子代理不得触碰防火墙规则                                                                                                                                                                 |
| 重要权限人工审核机制         | 新增 `apps/server/src/plugins/PluginApprovalStore.ts`，采用与 `PeerLinkRequests.ts` 一致的**非阻塞异步审批单**模式：MCP 写工具遇到高风险变更时立即返回 `approval_required` + `requestId` + `diffPreview` + `expiresAt`，审批单通过 `plugins.subscribe` 推送到 `ByteDockControlCenterModal.tsx`（并在 `PluginUiSlots.tsx` 状态栏按钮显示待审角标）；用户点击批准/拒绝时通过宿主 WS `plugins.invoke(pluginId: "builtin.control-plane", method: "resolveApproval")` 完成单次消费裁决 | 放弃在 MCP 工具调用内阻塞等待人工点击：provider CLI 会对长时间挂起的 MCP 调用超时中断；放弃把审批路由塞进 `OrchestrationV2` 新 TurnItem 类型：那样需切大量上游协议/渲染缝隙，而 `ByteDockControlCenterModal` + `plugins.subscribe` 完全落在 ByteDock 自有代码与既有缝隙内 |
| 插件配置 Schema 与密钥防泄漏 | 在 `packages/plugin-kernel/src/pluginConfigSchemas.ts`（新增）定义内置插件配置 Effect `Schema` 与通用明文密钥字段拦截器（拒绝在非 `secretRef` 字段直接写入高危凭据键或 `sk-`/`gho_` 等典型明文模式，同时保留已知非敏感键白名单）                                                                                                                                                                                                                                                  | 避免无校验 `Record<string, unknown>` 裸写：确保 AI 或手改传错字段时立刻给出可读错误并保留上一有效配置                                                                                                                                                                     |
| UI 双向操控路由              | 复用现有 `plugins.invoke` 与 `plugins.subscribe`，注册系统控制方法 `builtin.control-plane`（`getState`、`setEnabled`、`patchConfig`、`listApprovals`、`resolveApproval`），其中高风险操作（含 `resolveApproval`）在 `PluginScopeBroker` 绑定宿主写 Scope，且仅允许 `caller.kind === "host-client"`                                                                                                                                                                                | 无需改动 `packages/contracts/src/rpc.ts`、`RpcAuthorization.ts` 与 `RpcInstrumentation.ts`，零新增上游 RPC 缝隙                                                                                                                                                           |

## 状态、依赖与失败语义

- **状态所有者**：`PluginControlPlane` 进程级单例拥有内存生效快照、默认目录本地插件状态、最近配置/编译诊断、文件监听作用域（`Scope`）与审批队列；`plugins.yml` 是跨重启的唯一持久化真源。
- **单向依赖方向**：`ByteDockControlCenterModal` / `McpHttpServer (bytedockControl)` / `ws.ts (plugins-rpc-handlers)` → `PluginControlPlane` → `{ PluginKernel, PluginConfigService, PluginApprovalStore, HotReloadController, ServerConfig }`。MCP 不可调用 `resolveApproval`。
- **文件监听与自写回环抑制**：监听 `dirname(pluginConfigPath)` 过滤 `plugins.yml` 并监听 `pluginsDir`（150ms 防抖）；控制面自身原子写盘后记录最新 `mtimeMs` 与内容摘要，跳过无变化的回环事件，同时对外部编辑器手改立即触发重读与校验。
- **失败暴露边界**：
  - `plugins.yml` YAML 语法错或 Schema 校验失败 → 保留内存上一合法快照，更新 `lastConfigDiagnostic`，通过 `plugins.subscribe` 与 `bytedock_config_read` 显式暴露，绝不静默重置为默认值。
  - `mtimeMs` CAS 冲突 → 显式返回 `StaleConfigWriteError` / `stale_config`，不覆盖用户手改。
  - 本地插件编译/加载失败 → 复用 `hotReload.ts` 的 `kept-previous-on-error`，保留活动 Revision 并返回行列级错误诊断。
  - 审批单过期（默认 10 分钟）或已被裁决 → 裁决返回冲突/过期错误，绝不重复写盘。
- **审计留痕**：所有防火墙被拒请求、高风险审批单创建、批准、拒绝、过期及普通配置生效事件，均写入哈希链审计日志（复用 `packages/plugin-kernel/src/storage.ts` `openHashChainedAuditLog`）。

## Risks / Trade-offs

- **[Windows 文件监听事件抖动与写锁]** → 复用 `serverSettings.ts` 的目录级 `fs.watch` + 150ms debounce + `configService.ts` 的 tmp-rename 与 Defender `EBUSY/EPERM` 退避重试。
- **[审批单在服务端重启后的持久化]** → 首期审批单设为 10 分钟短期内存态（重启后未决高风险请求自动失效并需主会话重新发起，符合“宁可重问不误放行”的安全原则）；已批准的配置已原子写入 `plugins.yml`，重启后自动按文件恢复。
- **[内置 MCP 工具未被某些模型主动调用]** → 工具名与描述显式包含 `bytedock`、`plugin`、`enable`、`disable`、`config`、`egress`、`reload` 关键词，确保 `McpToolExposure.search`（按词干打分）精准命中，并在非 deferred 客户端直接列出。
- **[已批准本地插件再次被篡改提权]** → `PluginApprovalStore` 记录已批准本地插件的权限指纹（`permissions` 规范化哈希）；若后续热重载时清单中 `networkHosts`/`secretNamespaces`/`rpcScopes` 扩大，重新要求人工审核，防止“先以低权限过审再热改提权”。

## Migration Plan

- **向后兼容**：现有 `~/.bytedock/userdata/` 无 `plugins.yml` 时自动使用内置默认配置（全部内置插件默认 `enabled: true`，`egress-guard` 沿用现有默认策略），对已安装 `v0.1.0-bytedock.1` 的用户完全平滑无感，无需数据库迁移。
- **回退策略**：删除或恢复 `~/.bytedock/userdata/plugins.yml` 即可恢复默认插件配置；代码层面所有改动均落在 ByteDock 自有模块与 3 个既有缝隙块内，可按分支完整回退。

## 验证与文档同步

- **结构与护栏门禁**：`node scripts/check-seams.ts`、`node scripts/check-zero-telemetry.ts`、`vp test run apps/server/src/provider/AgentContextBudget.test.ts`、`vp run typecheck`。
- **首期核心功能测试**：
  - `packages/plugin-kernel` 单元测试：配置 Schema 校验、明文密钥拦截、权限指纹提权检测、`mtimeMs` CAS 冲突保护。
  - `apps/server` 集成测试：`plugins.controlPlane.test.ts` 覆盖“修改 `plugins.yml` 文件监听热更普通插件启停与配置”“非法 YAML 保留旧快照并暴露诊断”“默认目录 `~/.bytedock/plugins/` 源码热重载与报错回滚”“MCP 4 个工具读写闭环”“子代理/linked/外部客户端改防火墙直接拒绝”“主会话改防火墙与重要权限生成审批单 → 宿主批准落盘生效 / 拒绝不生效 / 过期 / 不可自审批”。
- **UI 与桌面端验证**：`apps/web` 组件/交互检查 +（实施完成且打包验证阶段）真实 Electron 冒烟测试验证 Control Center 开关与审批队列。
- **文档同步**：实施完成后同步更新 `README.md`（若说明配置路径与 AI 控制面用法）及校验 `seam-ledger.json` 无漂移。

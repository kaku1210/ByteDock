## Why

ByteDock 当前虽然已具备 `PluginKernel`、内置插件、`HotReloadController` 与 `configService.ts` 等底层模块，但运行时仍将内置插件写死为常驻激活，既未将 `~/.bytedock/userdata/plugins.yml` 与默认插件目录 `~/.bytedock/plugins/` 接入实时文件监听热更，也未向运行在 ByteDock 内部的 AI 会话提供可控的配置读写与插件管理 MCP 工具。因此用户在 ByteDock 内工作时，无法直接让 AI 启停插件、调整插件配置或验证热更结果，也缺少针对防火墙规则与重要权限的会话隔离和人工审核门禁。

## What Changes

- 启用默认路径下的可读配置文件 `~/.bytedock/userdata/plugins.yml` 作为插件启停与声明式配置的唯一持久化真源，并监听该文件与默认插件目录 `~/.bytedock/plugins/` 实现防抖实时热更；非法配置或编译失败时保留上一有效运行态并暴露结构化诊断。
- 将所有内置插件及默认目录本地插件接入真实启停与配置生效链：停用后即时失效其 Hooks、动态 MCP 工具与业务方法调用并同步至 UI，重新启用后立即恢复；配置变更经 Schema 校验后实时同步到内存运行态（含 Egress Policy 与内置插件行为参数）。
- 在 ByteDock 内置 `McpHttpServer` 中通过既有 `mcp-dynamic-bridge` 缝隙新增一组面向 AI 的控制面 MCP 工具（`bytedock_config_read`、`bytedock_plugin_set_enabled`、`bytedock_plugin_config_patch`、`bytedock_plugins_reload`），支持 `tool_search` 延迟发现且不突破现有 `AgentContextBudget`。
- 建立风险分级与权限护栏：普通插件启停与非权限业务配置变更支持直接实时热更（作为首期核心验收主路径）；防火墙规则（`builtin.egress-guard`）严格限制为仅本机活跃主会话可发起修改（直接拒绝子代理、链接远程环境与无线程外部客户端）；防火墙放宽/停用及重要权限扩大变更必须生成挂起审批单，经用户在 ByteDock Control Center 显式批准后才落盘并热生效。
- 在现有 ByteDock Control Center UI 中补齐插件启停开关、当前配置与热更诊断展示、以及待审核权限请求单的批准/拒绝入口，确保“AI 可控、人工可见且可逆”。

## Capabilities

### New Capabilities

- `plugin-config-hot-reload`: 基于默认配置文件 `~/.bytedock/userdata/plugins.yml` 与默认插件目录 `~/.bytedock/plugins/` 的持久化真源、Schema 校验、文件监听实时热更与失败回滚诊断能力。
- `bytedock-mcp-control-plane`: 面向运行在 ByteDock 内 AI 会话的内置 MCP 控制工具集（只读查询、普通插件启停、配置局部更新、热重载触发）及宿主 Control Center 双向同步能力。
- `privileged-control-approval`: 防火墙规则仅主会话独占、重要权限变更分类识别与异步人工审核门禁（含不可自审批与完整审计留痕）。

### Modified Capabilities

## Impact

- **插件内核与配置层**：`packages/plugin-kernel/src/{configService.ts,layer.ts,egressGuard.ts,hooks.ts,hotReload.ts}`
- **服务端运行时与路径派生**：`apps/server/src/config.ts`、`apps/server/src/server.ts`（既有 `kernel-mount` 缝隙）、`apps/server/src/plugins/BuiltinPluginRuntime.ts`、`apps/server/src/plugins/PluginControlPlane.ts`（新增）、`apps/server/src/plugins/PluginApprovalStore.ts`（新增）
- **服务端 WS RPC 与内置 MCP**：`apps/server/src/ws.ts`（既有 `plugins-rpc-handlers` 缝隙）、`apps/server/src/mcp/McpHttpServer.ts`（既有 `mcp-dynamic-bridge` 缝隙）、`apps/server/src/mcp/toolkits/bytedockControl/`（新增）
- **Web / Desktop 控制中心 UI**：`apps/web/src/components/plugin/{ByteDockControlCenterModal.tsx,PluginUiSlots.tsx}`（均为 ByteDock 自有文件，不新增上游 UI 缝隙）
- **兼容性与约束**：严格保持 `seam-ledger.json` 零新增上游缝隙、`AgentContextBudget.test.ts` 不增长、`scripts/check-zero-telemetry.ts` 通过、运行数据严格隔离在 `~/.bytedock`。

## 非目标

- 首期不实现外部自定义插件源码目录映射（仅支持默认目录 `~/.bytedock/plugins/`）。
- 首期不新增独立命令行 `bytedock` CLI 二进制（后续可基于同一控制面服务薄封装）。
- 不允许通过配置文件或 MCP 工具读写/回显明文密钥（继续严格由 `request_secret` 与 `SecretNamespaceBroker` 隔离管理）。
- 首期不做移动端审批写操作（移动端沿用现有只读/通知口径，审批裁决在 Web/Desktop 宿主客户端完成）。
- 不改造上游 `ServerSettings`（`settings.json`）现有结构与 `t3_environment_preferences_update` 契约。

## 风险与验收

| 验收标准                                                                                                                                                                                        | 适用验证方式与证据                                                                                                                                           | 风险或指定人工 gate                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 首期核心：普通插件启停实时热更（改 `plugins.yml` 或调 `bytedock_plugin_set_enabled` 后，运行态、Hooks、RPC 与 UI 立即切换并可逆）                                                               | `vp test run` 服务端集成测试 + 真实运行环境验证记录                                                                                                          | Windows 文件监听抖动与 Defender 原子重命名锁；依赖现有 `configService.ts` 重试与 150ms 防抖 |
| 首期核心：普通插件声明式配置实时热更（合法配置即时生效；非法 YAML 或越界值拒绝应用并保留上一有效快照且暴露诊断）                                                                                | `vp test run` 覆盖合法更新、语法损坏、Schema 越界与 CAS 并发冲突用例                                                                                         | 人工手改与 AI 修改并发写冲突，由 `mtimeMs` CAS 防止静默覆盖                                 |
| 防火墙规则仅主会话可改（委托子代理、linked 远程环境、外部无线程客户端修改 `builtin.egress-guard` 均直接拒绝且不建审批单）                                                                       | `vp test run` MCP 权限边界测试（覆盖主会话/子代理/只读客户端/linked 调用方）                                                                                 | 防止子代理或间接提示词注入静默关闭防火墙                                                    |
| 重要权限变更强制人工审核（防火墙放宽/停用、扩大 `networkHosts`/`secretNamespaces`/`rpcScopes`、首次启用未审批默认目录插件均返回 `approval_required`，仅宿主人类批准后落盘生效，MCP 不可自审批） | `vp test run` 审批状态机测试 + Control Center UI 交互验证（批准/拒绝/过期/重复消费）                                                                         | **指定人工 gate**：审批交互体验与高风险清单边界需在打包前人工复核一次                       |
| 工程护栏与缝隙纪律（`check-seams`、`check-zero-telemetry`、`AgentContextBudget.test.ts`、`typecheck` 全绿）                                                                                     | `node scripts/check-seams.ts`、`node scripts/check-zero-telemetry.ts`、`vp test run apps/server/src/provider/AgentContextBudget.test.ts`、`vp run typecheck` | 新增 MCP 工具不得进入 `layerTools` 导致上游上下文预算测试失败                               |

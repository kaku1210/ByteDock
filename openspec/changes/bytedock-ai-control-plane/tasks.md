## 1. 实施准备与路径/Schema 基础

- [x] 1.1 核对已批准的 OpenSpec 规划包、当前分支状态与 `seam-ledger.json` 边界（切出 `feat/bytedock-ai-control-plane`，零新增上游缝隙、未触碰 `~/.t3` / `~/.t3-plus`）。
- [x] 1.2 在 `apps/server/src/config.ts` 的 `ServerDerivedPaths` 中新增默认路径 `pluginConfigPath`（`join(stateDir, "plugins.yml")`）与 `pluginsDir`（`join(baseDir, "plugins")`），并在 `ensureServerDirectories` 中确保 `pluginsDir` 自动创建；同步补齐 `ProviderReplayHarness.ts` 与 `plugins.controlPlane.test.ts` 路径派生断言（PASS）。
- [x] 1.3 在 `packages/plugin-kernel/src/pluginConfigSchemas.ts` 中定义内置插件声明式配置 Schema、明文密钥拦截校验、Egress 策略与 `DEFAULT_DENIED_DOMAINS` 基线合并规则、权限风险评估及权限指纹计算函数，并通过 `packages/plugin-kernel/src/pluginConfigSchemas.test.ts`（5/5 PASS）。

## 2. 配置文件监听与插件控制面核心（首期核心：启停与配置热更）

- [x] 2.1 新建 `apps/server/src/plugins/PluginApprovalStore.ts`，实现高风险/重要权限变更审批单创建、10 分钟过期、单次消费裁决、本地插件权限指纹持久化与哈希链审计日志（`control-plane-audit.jsonl`），经 `plugins.controlPlane.test.ts` 验证 PASS。
- [x] 2.2 新建 `apps/server/src/plugins/PluginControlPlane.ts`，整合 `makePluginConfigService`（含 `readSafe()`）、`HotReloadController`（含 `extraManifests` 保留内置清单）、`PluginApprovalStore`、`fs.watch` + 150ms 防抖与自写回环抑制、非法 YAML/越界字段保留上一合法快照并暴露诊断、CAS 冲突保护与 `PubSub` 实时事件流。
- [x] 2.3 改造 `apps/server/src/plugins/BuiltinPluginRuntime.ts`（并拆分 `BuiltinPluginManifests.ts`）接入 `PluginControlPlane` 真实启停与配置快照，扩展 `hooks.ts` 与 `mcpBridge.ts` 停用拦截，在 `apps/server/src/server.ts`（`kernel-mount` 缝隙）与 `apps/server/src/ws.ts`（`plugins-rpc-handlers` 缝隙）接入控制面及 `builtin.control-plane` 宿主方法（`getState`、`setEnabled`、`patchConfig`、`listApprovals`、`resolveApproval`、`events`）。
- [x] 2.4 编写并运行 `apps/server/src/plugins.controlPlane.test.ts`（5/5 PASS），覆盖文件监听与控制面双路径普通插件启停与配置实时热更、非法 YAML/Schema 保持旧版并暴露诊断、明文密钥拦截、CAS 冲突保护以及默认目录 `~/.bytedock/plugins/` 源码热重载与报错回滚诊断。

## 3. 内置 MCP 控制面与主会话/人工审核门禁

- [x] 3.1 新建 `apps/server/src/mcp/toolkits/bytedockControl/{tools.ts,handlers.ts}`，实现 `bytedock_config_read`、`bytedock_plugin_set_enabled`、`bytedock_plugin_config_patch`、`bytedock_plugins_reload`，强制拒绝只读客户端、非活跃线程与 linked 跨域写请求；防火墙修改严格要求本机活跃主会话（拒绝子代理、linked 与外部客户端且不建审批单），无任何 MCP 自审批入口。
- [x] 3.2 在 `apps/server/src/mcp/McpHttpServer.ts` 既有 `// bytedock-seam:mcp-dynamic-bridge` 缝隙中通过 `provideRegistrationServices` 挂载 `ByteDockControlToolkit`（保持 `layerTools` 零改动），验证 `tool_search("bytedock")` 延迟发现与 `AgentContextBudget.test.ts`（2/2 PASS）。
- [x] 3.3 在 `apps/server/src/plugins.controlPlane.test.ts` 中通过真实 `McpHttpServer.layerToolSearch` 验证 MCP 读写、只读/linked/子代理/主会话边界、人工批准落盘热更、拒绝、过期（`TestClock`）与重复消费防重入（PASS）。

## 4. Control Center UI 双向操控与审批队列

- [x] 4.1 更新 `apps/web/src/components/plugin/{ByteDockControlCenterModal.tsx,PluginUiSlots.tsx,PluginSlotStore.ts}`，接入实时状态加载、插件启用/停用开关、内联 JSON 配置编辑热更、配置/热重载错误诊断横幅、待人工审核队列（含 diff 预览与批准/拒绝按钮）以及状态栏/设置侧边栏待审角标。
- [x] 4.2 通过 `apps/web` `effect-tsgo tsrs --noEmit`（0 errors）、`PluginNodeRenderer.test.tsx`（3/3 PASS）与 `PluginSandboxFrame.test.ts`（2/2 PASS）。

## 5. 门禁验证、人工审核与交付收尾

- [x] 5.1 全部自动化门禁通过：`packages/plugin-kernel` / `apps/server` / `apps/web` `effect-tsgo tsrs --noEmit` 均为 0 errors/0 warnings；`vp lint` 0 errors；`vp run knip:check` 3/3 PASS；9 个测试集 23/23 PASS（含 `AgentContextBudget.test.ts`）；`node scripts/check-seams.ts` PASS（16 改动文件 / 14 既有缝隙）；`node scripts/check-zero-telemetry.ts` PASS（0 违规）。
- [ ] 5.2 **人工验收 Gate（NOT_RUN）**：尚未在重新打包后的 Electron 桌面实例中由用户人工走查普通插件启停/配置热更与防火墙人工审批队列交互（需后续如需新安装包时按授权构建并人工确认）。
- [x] 5.3 汇总真实验证结果、未执行的人工验收项（`NOT_RUN`）及残余风险并交付。

## 1. 审批模型与宿主控制服务

- [x] 1.1 扩展 `apps/server/src/plugins/PluginApprovalStore.ts` 支持宿主级审批类型（`host-settings-patch`、`provider-mutation`、`legacy-import`、`system-action`），并扩展 `PluginControlPlane.ts` 支持注册 `hostMutationExecutor` 回调、广播 `ui-command` 事件及查询最近 UI 指令状态。
- [x] 1.2 新建 `apps/server/src/plugins/HostControlService.ts`，实现：能力自省目录、全量脱敏（并 `Schema.encodeSync` 纯 JSON 序列化）设置读取与高/低风险分类（含 fail-safe 关键词兜底与明文密钥拦截）、快捷键增删、Provider 实例审批门禁、`EgressProof`/出站审计/T3 只读扫描与审批导入/已启用插件安全调用/默认目录本地插件安全脚手架、UI 命令安全校验与广播、以及系统综合状态/编辑器打开/高风险存储清理与库回收与隧道与终端审批闭环。
- [x] 1.3 在 `server.ts` `layerMakeRoutes` 上下文内通过 `apps/server/src/mcp/McpHttpServer.ts` 既有 `// bytedock-seam:mcp-dynamic-bridge` 缝隙按 `Effect.serviceOption` 自动捕获并挂载 `HostControlService`（对 `apps/server/src/server.ts` 与 `seam-ledger.json` 零修改），并自动向共享 `PluginControlPlane` 单例注册 `hostMutationExecutor`。

## 2. 内置 MCP 全面控制工具扩展

- [x] 2.1 扩展 `apps/server/src/mcp/toolkits/bytedockControl/{tools.ts,handlers.ts}`，新增 `bytedock_capabilities_catalog`、`bytedock_settings_control`、`bytedock_plugin_action`、`bytedock_ui_control`、`bytedock_system_control` 五个工具，严格执行只读/linked/非活跃线程拦截与高风险操作本机主会话独占规则。
- [x] 2.2 在 `apps/server/src/mcp/McpHttpServer.ts` 既有 `// bytedock-seam:mcp-dynamic-bridge` 缝隙中注入 `HostControlService`（保持 `layerTools` 零改动），确保 `tool_search` 延迟发现全部 9 个 `bytedock_*` 工具且 `AgentContextBudget.test.ts` 通过（2/2 PASS）。

## 3. 前端实时 UI 控制总线与审批界面增强

- [x] 3.1 扩展 `apps/web/src/components/plugin/{PluginSlotStore.ts,PluginUiSlots.tsx,ByteDockControlCenterModal.tsx}`：新增安全 UI 指令处理器（打开/关闭 Control Center、打开/关闭右侧插件面板、安全站内导航、通知横幅）、经由 `@t3tools/client-runtime/rpc` `subscribe` 的单订阅控制面事件流消费器（同步待审角标与实时执行 `ui-command`），并在审批队列展示所有宿主级与插件级审批单 `kind` 标签与 diff。

## 4. 全量测试、门禁验证与交付

- [x] 4.1 编写并运行 `apps/server/src/plugins.fullControl.test.ts`（2/2 PASS）与 `apps/web/src/components/plugin/PluginSlotStore.test.ts`（4/4 PASS），验证全部 5 个新 MCP 工具、分级审批闭环、子代理/linked/只读拒绝、脚手架路径穿越拦截与前端 UI 指令安全处理。
- [x] 4.2 运行全量门禁校验：`effect-tsgo`（kernel/server/web 0 error）、`vp fmt`、`vp lint`（0 error）、`vp run knip:check`（3/3 PASS）、`AgentContextBudget.test.ts`（2/2 PASS）、`McpHttpServer.test.ts`（44/44 PASS）、`plugins.controlPlane.test.ts`（5/5 PASS）、`plugins.phase0.test.ts`（2/2 PASS）、`plugins.phase1.test.ts`（2/2 PASS）、`pluginConfigSchemas.test.ts`（5/5 PASS）、`PluginNodeRenderer.test.tsx`（3/3 PASS）、`PluginSandboxFrame.test.ts`（2/2 PASS）、`node scripts/check-seams.ts`（PASS）、`node scripts/check-zero-telemetry.ts`（PASS）、`openspec validate bytedock-full-ai-control --strict`（PASS）。
- [ ] 4.3 **人工验收 Gate（NOT_RUN）**：后续打包桌面端后由用户实测 AI 通过 MCP 操控 UI 跳转、修改设置与审批高风险宿主操作体验。
- [x] 4.4 更新 `tasks.md` 实测证据，提交、推送分支并 fast-forward 合并推送至 `main`。

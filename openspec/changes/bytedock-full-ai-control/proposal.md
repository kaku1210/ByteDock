## Why

在完成 `bytedock-ai-control-plane`（插件配置热更与 4 个插件 MCP 工具）后，AI 仍无法覆盖 ByteDock 的其余核心宿主功能：包括全量 `settings.json` 偏好与安全开关、Provider/模型实例管理、`keybindings.json` 快捷键、`EgressProof` 自证与审计日志、T3 Code/Plus 只读数据导入、默认目录本地插件脚手架、宿主 Web/Desktop 界面实时操控，以及系统诊断、存储清理、外部隧道和内置终端控制。为了支持运行在 ByteDock 内部的 AI 实现统一、可控且安全的全面操控，需要在既有 `mcp-dynamic-bridge` 与统一分级人工审批框架上补齐完整宿主控制面。

## What Changes

- 新增统一能力自省工具 `bytedock_capabilities_catalog`，向 AI 一次返回 ByteDock 全部可操控域、可用操作、对应 MCP 入口与风险分级（`read-only` / `direct` / `approval-required`），避免平铺数十个零散工具浪费上下文。
- 新增宿主设置、Provider 与快捷键控制工具 `bytedock_settings_control`：脱敏读取全量 `ServerSettings` 与 `keybindings.json`；低风险界面/行为偏好与快捷键变更即时热生效；敏感宿主开关（Provider 实例/模型、外部隧道、Guest Share、Linked Environments、设备与浏览器控制、OTLP 等）限制为仅本机主会话可发起且必须经 Control Center 人工批准后执行；严禁明文密钥写入或回显。
- 新增插件深度动作与脚手架工具 `bytedock_plugin_action`：支持运行 `EgressProof` 双段自证、读取出站审计事件、扫描本地 T3 Code / T3 Code Plus 数据源、调用已启用插件受控方法、在默认目录 `~/.bytedock/plugins/` 生成本地插件模板脚手架（默认保持停用且未审批），以及以“主会话 + 人工审批”模式发起 T3 只读数据导入。
- 新增宿主界面实时控制工具 `bytedock_ui_control`：通过既有 `plugins.subscribe` 事件流驱动宿主 Web/Desktop 实时打开/关闭 ByteDock Control Center（指定标签页）、展开/关闭右侧插件 Dock 面板、执行站内安全路径导航与通知提示。
- 新增系统诊断与受控操作工具 `bytedock_system_control`：只读查询宿主 CPU/内存资源、存储清理报告、数据库存储状态、外部隧道状态与可用编辑器；支持打开本地编辑器；并将存储清理、数据库空间回收、外部隧道操作与内置终端控制（`terminal_open`/`terminal_write`/`terminal_close`）纳入“本机主会话独占 + Control Center 人工审批”统一门禁。
- 扩展 `PluginApprovalStore`、`PluginControlPlane` 与 `ByteDockControlCenterModal` 支持宿主级审批单的展示、单次批准执行与拒绝/过期审计留痕，并全程保持零新增 `seam-ledger.json` 上游缝隙、零 `AgentContextBudget` 预算增长。

## Capabilities

### New Capabilities

- `bytedock-capabilities-catalog`: 面向 AI 的 ByteDock 全面控制能力自省目录与风险分级元数据契约。
- `bytedock-settings-and-keybindings-control`: 全量宿主设置脱敏读取、分级热更新、Provider 实例受控变更与快捷键实时管理。
- `bytedock-plugin-actions-and-scaffold`: `EgressProof` 自证、出站审计查询、T3 Code/Plus 只读扫描与审批导入、已启用插件业务调用及默认目录本地插件模板脚手架。
- `bytedock-ui-and-system-control`: 基于控制面事件流的 Web/Desktop 界面实时操控总线，以及宿主系统诊断、编辑器打开与高风险系统/隧道/终端操作的分级审批控制。

### Modified Capabilities

## Impact

- **服务端宿主控制与审批扩展**：`apps/server/src/plugins/PluginApprovalStore.ts`、`apps/server/src/plugins/PluginControlPlane.ts`、`apps/server/src/plugins/HostControlService.ts`（新增）、`apps/server/src/server.ts`（既有 `kernel-mount` 缝隙）、`apps/server/src/ws.ts`（既有 `plugins-rpc-handlers` 缝隙）。
- **内置 MCP 工具集**：`apps/server/src/mcp/toolkits/bytedockControl/{tools.ts,handlers.ts}`、`apps/server/src/mcp/McpHttpServer.ts`（既有 `mcp-dynamic-bridge` 缝隙，`layerTools` 零改动）。
- **前端 UI 控制总线与审批队列**：`apps/web/src/components/plugin/{PluginSlotStore.ts,PluginUiSlots.tsx,ByteDockControlCenterModal.tsx}`（均为 ByteDock 自有文件，零新增上游 UI 缝隙）。
- **合规护栏**：`seam-ledger.json` 零新增上游缝隙、`AgentContextBudget.test.ts` 不增长、`scripts/check-zero-telemetry.ts` 零违规、严禁向 `~/.t3` / `~/.t3-plus` 写入、明文密钥永不通过配置或 MCP 读写。

## 非目标

- 不允许 AI 通过任何控制面工具读取、回显或明文写入 `ServerSecretStore` 中的真实密钥值（继续仅通过 `request_secret` 处理）。
- 不允许任何 MCP 工具绕过人类宿主客户端自审批高风险请求。
- 不支持将本地插件脚手架写入 `~/.bytedock/plugins/` 之外的任意磁盘路径。
- 不新增独立命令行 CLI 二进制。

## 风险与验收

| 验收标准                                                                                                                                                                    | 适用验证方式与证据                                                                                            | 风险或指定人工 gate                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 能力目录与延迟发现：`bytedock_capabilities_catalog` 返回全部域与风险分级，`tool_search("bytedock")` 可发现全部 9 个 `bytedock_*` 工具且 `AgentContextBudget.test.ts` 零增长 | `vp test run apps/server/src/plugins.fullControl.test.ts apps/server/src/provider/AgentContextBudget.test.ts` | 避免工具描述过大影响延迟加载检索准确度                                  |
| 设置、快捷键与 Provider 分级控制：读取全脱敏、低风险设置与快捷键直通热更、高风险设置与 Provider 变更仅主会话可建审批单并经人类批准后落盘生效、明文密钥必拒                  | `vp test run apps/server/src/plugins.fullControl.test.ts`                                                     | 敏感字段白名单/黑名单边界必须严格覆盖防漏放                             |
| 插件动作与脚手架：`EgressProof`/审计/T3 扫描与安全脚手架可用；T3 导入仅主会话触发人工审批后执行；脚手架禁止路径穿越且默认未审批停用                                         | `vp test run apps/server/src/plugins.fullControl.test.ts`                                                     | 防止恶意插件名路径穿越或生成即自动执行                                  |
| UI 总线与系统控制：UI 控制命令经 `plugins.subscribe` 实时下发并限制安全站内路由；系统只读状态直通；存储清理/库回收/隧道/终端严格执行“主会话 + 人工审批”                     | `vp test run` 服务端与 Web 组件测试 + `vp run typecheck`                                                      | **指定人工 gate**：后续打包桌面端时由用户实测 UI 自动跳转与审批弹窗体验 |
| 工程与缝隙门禁：`effect-tsgo`、`vp lint`、`knip:check`、`check-seams.ts`、`check-zero-telemetry.ts`、`McpHttpServer.test.ts` 全绿                                           | 对应自动化命令行输出证据                                                                                      | 保持零新增上游缝隙                                                      |

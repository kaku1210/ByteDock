## Purpose

定义面向 ByteDock 内部 AI 会话的统一能力自省目录契约，使 AI 能够通过单次只读调用获取 ByteDock 全部可操控功能域、支持动作、对应 MCP 工具入口及安全风险分级，避免因工具数量膨胀而丢失可控能力视野。

## ADDED Requirements

### Requirement: 统一能力自省目录

系统 SHALL 提供只读 MCP 工具 `bytedock_capabilities_catalog`，返回 ByteDock 全部可操控域的结构化目录（涵盖插件配置热更、宿主设置与快捷键、Provider 与模型、插件动作与脚手架、宿主界面操控、系统诊断与隧道终端，以及既有线程/项目/Worktree/定时任务/预览/设备工具索引），并明确标出每类操作的风险级别（`read-only`、`direct`、`approval-required`）与当前本机已挂载服务的可用状态。

#### Scenario: AI 一次查询全部 ByteDock 可控能力

- **WHEN** 任意已认证的 AI 会话调用 `bytedock_capabilities_catalog`
- **THEN** 系统返回包含所有能力域、每个域下动作清单、风险分级、高风险保护说明以及服务可用性状态的 JSON 结构，且不包含任何明文密钥或敏感凭据

#### Scenario: 延迟暴露会话检索全部 ByteDock 工具

- **WHEN** 处于 `deferred` 工具暴露模式的会话调用 `tool_search` 搜索 `bytedock`
- **THEN** 系统能够检索并返回包括 `bytedock_capabilities_catalog`、`bytedock_settings_control`、`bytedock_plugin_action`、`bytedock_ui_control`、`bytedock_system_control` 在内的全部 ByteDock 控制面工具，且不增加基础工具集初始上下文预算

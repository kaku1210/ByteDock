## Purpose

定义 AI 实时操控 ByteDock 宿主 Web/Desktop 界面（Control Center、右侧插件面板、站内导航与通知）的命令总线契约，以及对宿主系统诊断、外部编辑器与高风险存储/数据库/隧道/终端操作实行“只读直通、高风险主会话+人工审批”的统一行为规范。

## ADDED Requirements

### Requirement: 宿主界面实时控制总线

系统 SHALL 提供 `bytedock_ui_control` MCP 工具，支持本机活跃会话下发界面指令（`open_control_center`、`close_control_center`、`open_dock_panel`、`close_dock_panel`、`navigate`、`notify`），并通过控制面实时事件流广播至已连接的宿主 Web/Desktop 客户端立即执行；其中 `navigate` MUST 仅允许合法站内相对路径（以 `/` 开头且禁止 `//`、外链协议或脚本伪协议），`open_dock_panel` MUST 仅接受安全的声明式节点结构。

#### Scenario: AI 打开 Control Center 指定标签页或展开插件面板

- **WHEN** 本机活跃主会话调用 `bytedock_ui_control` 执行 `open_control_center`（`tab: "import"`）或 `open_dock_panel`
- **THEN** 服务端向 `plugins.subscribe` 事件流发布对应 `ui-command` 事件，已连接的宿主前端即时切换弹窗/面板状态

#### Scenario: 拦截非法外部导航地址

- **WHEN** AI 调用 `bytedock_ui_control(action: "navigate")` 并传入 `https://evil.example` 或 `javascript:alert(1)`
- **THEN** 系统直接拒绝请求并返回校验错误，不向前端广播导航指令

### Requirement: 系统诊断只读查询与编辑器打开

系统 SHALL 通过 `bytedock_system_control` 支持只读 `status` 动作（返回宿主资源快照、最近存储清理报告、数据库存储状态、外部隧道状态与可用编辑器列表）以及低风险 `open_editor` 动作（调用本机配置编辑器打开指定路径）。

#### Scenario: 只读查询系统综合状态

- **WHEN** 已认证 AI 调用 `bytedock_system_control(action: "status")`
- **THEN** 系统汇总返回已挂载宿主服务的实时诊断状态，对当前未挂载的可选服务显式标明 `unavailable` 而不伪造假数据

### Requirement: 高风险系统、隧道与终端操作分级审批

系统 SHALL 将 `bytedock_system_control` 中的 `storage_cleanup`、`database_reclaim`、`tunnel_action`、`terminal_open`、`terminal_write` 与 `terminal_close` 判定为高风险宿主操作：委托子代理、linked 远程环境与外部无线程客户端 MUST 被直接拒绝且不建审批单；本机活跃主会话发起时 MUST 生成包含完整参数摘要的待审核审批单并返回 `approval_required`，仅在宿主人类客户端于 Control Center 点击批准后执行真实宿主服务调用并记录哈希链审计日志。

#### Scenario: 子代理尝试操作内置终端或外部隧道被直接拒绝

- **WHEN** 委托子代理调用 `bytedock_system_control` 执行 `terminal_write` 或 `tunnel_action`
- **THEN** 系统直接返回 `capability_denied`（`main_session_required`），不创建审批单，不触碰终端或隧道进程，并写入审计日志

#### Scenario: 主会话申请存储清理或终端操作经人工批准后执行

- **WHEN** 本机活跃主会话调用 `bytedock_system_control` 请求执行 `storage_cleanup` 或 `terminal_open`
- **THEN** 系统返回 `status: "approval_required"` 且不立即执行；当用户在 Control Center 批准该审批单后，服务端执行对应宿主动作并返回结果摘要，同时标记审批单为 `approved` 防止重复消费

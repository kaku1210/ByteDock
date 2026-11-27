## Purpose

定义 ByteDock 对全量宿主设置（`settings.json`）、Provider 实例与默认模型配置以及快捷键（`keybindings.json`）的 AI 控制行为与分级安全边界，确保读取严格脱敏、低风险个性化配置实时生效、高风险安全边界变更受本机主会话与人工审核双门禁约束。

## ADDED Requirements

### Requirement: 全量宿主设置与快捷键脱敏读取

系统 SHALL 通过 `bytedock_settings_control`（`action: "read"`）向授权 AI 返回经脱敏处理的当前 `ServerSettings` 快照（敏感凭据与密钥提供方值 MUST 保持脱敏，不得回显明文）、当前已解析的快捷键规则与可用外部编辑器列表。

#### Scenario: 脱敏读取宿主设置与快捷键

- **WHEN** 已认证 AI 调用 `bytedock_settings_control` 且 `action` 为 `read`
- **THEN** 系统返回当前脱敏后的 `settings`、`keybindings` 与 `availableEditors`，任何敏感配置字段均以脱敏标记展示而不含真实密钥

### Requirement: 低风险偏好与快捷键即时热生效

系统 SHALL 允许具备写权限的本机活跃会话通过 `bytedock_settings_control` 直接更新低风险界面/交互偏好（如语言、时间戳格式、Diff 布局、侧边栏排序与自动归档天数、字体大小、界面对比度与动效时长、自动压缩设置等）以及增删快捷键规则（`upsert_keybinding`、`remove_keybinding`），并立即持久化且热生效。

#### Scenario: 修改低风险宿主偏好与快捷键立即生效

- **WHEN** 本机活跃主会话调用 `bytedock_settings_control` 修改 `diffLayout` 或调用 `upsert_keybinding` 绑定快捷键
- **THEN** 系统校验通过后立即持久化至 `settings.json` 或 `keybindings.json` 并返回 `status: "applied"` 及最新快照

#### Scenario: 拒绝包含明文密钥的设置写入

- **WHEN** AI 在 `patch_settings` 或 `update_provider` 中提交疑似明文密钥或凭据字段
- **THEN** 系统直接拒绝该请求并返回校验错误，不写入磁盘且不创建审批单

### Requirement: 高风险宿主设置与 Provider 变更分级审批

系统 SHALL 将修改安全或外部边界相关的宿主设置键（包括 `providerInstances`、`providers`、`secretProviders`、`externalTunnel`、`guestSharingEnabled`、`linkedEnvironmentsEnabled`、`enableDeviceSupport`、`enableAgentDeviceAccess`、`deviceHosts`、`easDeviceHosts`、`simlockDeviceHosts`、`simlockDeviceHostsEnabled`、`enableAgentBrowserAccess`、`usageLimitSources`、`defaultModelSelection`、`fallbackModelSelection`、`textGenerationModelSelection`、`reviewGuideModelSelection`、`sourceControlWriterModelSelection`、`customModels`、`defaultRuntimeMode`、`runtimeMode`）以及任何 `update_provider` 变更判定为高风险操作：非本机活跃主会话（委托子代理、linked 远程环境、外部无线程客户端）MUST 直接拒绝且不建审批单；本机活跃主会话发起时 MUST 返回 `approval_required` 与审批单 `requestId`，仅在宿主人类客户端显式批准后写入生效。

#### Scenario: 子代理尝试开启外部访问或改写 Provider 被直接拒绝

- **WHEN** 委托子代理调用 `bytedock_settings_control` 尝试修改 `guestSharingEnabled` 或执行 `update_provider`
- **THEN** 系统直接返回 `capability_denied`（`main_session_required`），不修改 `settings.json`，不创建审批单，并记录审计日志

#### Scenario: 主会话申请高风险设置变更经人工批准后生效

- **WHEN** 本机活跃主会话调用 `bytedock_settings_control` 请求开启 `enableAgentBrowserAccess` 或更新默认模型，随后用户在 Control Center 点击批准
- **THEN** 首次 MCP 调用返回 `status: "approval_required"` 且不修改磁盘；用户批准后服务端原子写入 `settings.json`、标记审批单为 `approved` 并写入哈希链审计日志

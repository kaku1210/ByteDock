## Purpose

定义 ByteDock 对防火墙规则修改的主会话独占限制，以及针对高风险权限变更的分类识别、异步人工审核门禁、不可自审批约束与全链路审计行为，防止子代理、外部链接或提示词注入在未经人类明确同意的情况下削弱安全防线。

## ADDED Requirements

### Requirement: 防火墙规则仅主会话可改

系统 SHALL 将 `builtin.egress-guard` 的所有规则修改（包括切换 `mode`、增删 `allowedHosts`、`allowLoopbackHosts`、`deniedDomains`、`allowUdp` 以及停用或启用请求）严格限制为仅允许来自本机活跃主会话线程的调用；任何委托子代理、跨链接远程环境或无线程外部 MCP 客户端发起的防火墙修改请求 MUST 被服务端直接拒绝，且不得创建待审核单。

#### Scenario: 委托子代理尝试修改防火墙规则

- **WHEN** 委托子线程（`subagent: true` 或具有父任务谱系的子线程）调用 `bytedock_plugin_config_patch` 或 `bytedock_plugin_set_enabled` 修改 `builtin.egress-guard`
- **THEN** 系统直接拒绝请求并返回明确错误码（`main_session_required` / `capability_denied`），不创建审批单、不修改 `plugins.yml`，并在审计日志中记录该次被拒尝试

#### Scenario: 外部无线程或跨链接客户端尝试修改防火墙规则

- **WHEN** 非本机主会话线程的外部 MCP 客户端或 linked 环境调用方尝试修改 `builtin.egress-guard`
- **THEN** 系统直接拒绝请求且不创建审批单，当前防火墙策略保持不变

### Requirement: 重要权限变更识别与人工审核门禁

系统 SHALL 将以下操作判定为需要人工审核的重要权限变更，禁止通过 MCP 直接落盘或热生效：

1. 任何 `builtin.egress-guard` 的停用请求或规则放宽/模式变更（包括切换为 `audit-only`、放宽 `allowedHosts`、变更 `allowLoopbackHosts`、开启 `allowUdp: true`、尝试移除内置遥测拒绝域）；
2. 任何插件扩大敏感权限边界的配置或清单变更（包括新增或放宽 `networkHosts`、`secretNamespaces`、更高权限的 `rpcScopes`）；
3. 首次启用位于默认目录 `~/.bytedock/plugins/` 中尚未获人类批准的 `local-dev` 或 `community` 插件。

当本机活跃主会话发起上述重要权限变更时，系统 MUST 挂起该变更并生成待审核审批单，立即向 AI 返回 `{ status: "approval_required", requestId, riskLevel, summary, diffPreview, expiresAt }`，提示 AI 等待人工审核而不得阻塞长连接。

#### Scenario: 主会话申请放宽防火墙白名单进入人工审核

- **WHEN** 本机活跃主会话调用 `bytedock_plugin_config_patch` 向 `builtin.egress-guard` 的 `allowedHosts` 添加新外网域名（例如 `api.example.com`）
- **THEN** 系统不直接修改 `plugins.yml` 或内存 `EgressPolicy`，而是创建一条 `pending` 状态审批单并推送到宿主 Control Center 审批队列，同时向 AI 返回 `status: "approval_required"`、唯一 `requestId`、变更前后 diff 摘要与过期时间

#### Scenario: 首次启用默认目录中未审批的本地插件

- **WHEN** 主会话调用 `bytedock_plugin_set_enabled` 首次启用 `~/.bytedock/plugins/` 下的某个新写入的本地插件
- **THEN** 系统检测到该插件尚未获得人工权限批准，生成包含其声明权限清单（`networkHosts`、`secretNamespaces`、`rpcScopes`、`storage`、`hooks`）的审批单并返回 `approval_required`

### Requirement: 内置遥测拒绝域基线保护

系统 SHALL 在合并并应用 `builtin.egress-guard` 配置时默认保留内置遥测拒绝域基线（`DEFAULT_DENIED_DOMAINS`），不得因局部配置更新而静默清空或覆盖该拒绝基线。

#### Scenario: 局部更新白名单不丢失内置遥测拒绝域

- **WHEN** 经人工批准后向 `builtin.egress-guard` 应用新的 `allowedHosts` 列表
- **THEN** 生效的运行态 `EgressPolicy` 仍然包含全部 `DEFAULT_DENIED_DOMAINS`，且遥测域名命中拒绝域时依然优先拦截

### Requirement: 人工审批裁决与不可自审批约束

系统 SHALL 仅允许经认证的宿主 Web/Desktop 人类客户端通过宿主 RPC 对挂起审批单执行 `approve` 或 `reject` 裁决；任何 MCP 工具均 MUST NOT 提供自审批能力。同一审批单 MUST 仅可被消费一次，且超过有效期（默认 10 分钟）后自动失效。

#### Scenario: 用户在控制中心批准审批单后原子落盘并热更

- **WHEN** 用户在 ByteDock Control Center 查看审批单的完整变更 diff 后点击批准
- **THEN** 服务端校验审批单仍为 `pending` 且未过期，核对 `plugins.yml` CAS 版本后原子写入配置并立即应用到运行态（例如调用 `egress.updatePolicy`），将审批单标记为 `approved`，写入哈希链审计日志，并向已订阅客户端广播结果

#### Scenario: 用户拒绝审批单或审批单过期

- **WHEN** 用户点击拒绝或审批单超过 `expiresAt` 仍未被裁决
- **THEN** 服务端将审批单标记为 `rejected` 或 `expired`，`plugins.yml` 与内存运行态保持原状不变，审计日志记录该裁决结果

#### Scenario: 重复裁决已结束的审批单

- **WHEN** 客户端对已处于 `approved`、`rejected` 或 `expired` 状态的 `requestId` 再次发起裁决
- **THEN** 系统拒绝本次请求并返回冲突错误，不得二次修改配置文件

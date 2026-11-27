## Purpose

定义 ByteDock 内置 MCP 控制面与宿主 Control Center UI 之间的外部可观察交互契约，使运行在 ByteDock 内部的 AI 会话能够安全地查询插件和配置运行态、实时启停普通插件、修改合法配置并触发热重载，同时保证人工在 UI 侧始终具备完整可见性与反向恢复能力。

## ADDED Requirements

### Requirement: 内置 MCP 控制工具集与延迟发现

系统 SHALL 在内置 MCP 服务中提供 `bytedock_config_read`、`bytedock_plugin_set_enabled`、`bytedock_plugin_config_patch` 与 `bytedock_plugins_reload` 四个控制面工具。对于启用延迟工具暴露（`deferred`）的会话，这些工具 SHALL 默认不占用初始常驻工具上下文预算，而是可通过 `tool_search` 按名称或关键词检索加载；对于非延迟模式客户端，SHALL 按其权限正常可见。

#### Scenario: 延迟会话通过搜索发现并调用读取工具

- **WHEN** 处于 `deferred` 工具暴露模式的 AI 会话调用 `tool_search` 检索 `bytedock` 或 `plugin`
- **THEN** 系统返回匹配的 `bytedock_*` 工具定义并在当前会话启用它们，且不影响既有基础工具集的初始上下文预算

#### Scenario: 查询完整控制面运行态

- **WHEN** 授权 AI 会话调用 `bytedock_config_read`
- **THEN** 系统返回默认 `plugins.yml` 路径、默认插件目录路径、当前 `activeRevision`、所有插件的 `id`/`name`/`status`/`enabled`/脱敏 `config`、当前防火墙策略摘要、最近一次配置或热重载错误诊断，以及当前挂起的人工审批单摘要

### Requirement: AI 实时启停普通插件与局部更新配置

系统 SHALL 允许具备写权限的活跃 AI 会话通过 `bytedock_plugin_set_enabled` 启停普通插件、通过 `bytedock_plugin_config_patch` 对普通插件配置执行声明式局部更新，并在通过校验且不触及高风险权限规则时立即持久化到 `plugins.yml` 并热生效。

#### Scenario: AI 启用或停用普通插件

- **WHEN** 具备写权限的活跃主会话调用 `bytedock_plugin_set_enabled` 将普通插件 `builtin.token-optimizer` 的 `enabled` 设为 `false`
- **THEN** 系统校验通过、原子更新 `plugins.yml` 并热更运行态，工具返回 `{ applied: true, pluginId, enabled: false, status: "disabled", activeRevision, mtimeMs }`

#### Scenario: AI 提交非法插件配置参数

- **WHEN** AI 会话调用 `bytedock_plugin_config_patch` 提交不存在的插件 ID 或不符合该插件 Schema 的配置字段
- **THEN** 系统返回结构化校验错误，不修改 `plugins.yml`，且不改变当前运行态

### Requirement: AI 触发热重载并获取精确诊断

系统 SHALL 允许授权 AI 会话调用 `bytedock_plugins_reload` 立即重新读取 `plugins.yml` 并扫描默认插件目录执行热重载，将执行结果或编译/配置错误详情直接返回给调用方，支持“修改 → 重载 → 诊断 → 修复”闭环。

#### Scenario: 热重载成功或无变化

- **WHEN** AI 会话在修改本地插件源码或配置后调用 `bytedock_plugins_reload`
- **THEN** 若存在有效变化则返回 `status: "reloaded"` 及新旧 `activeRevision`；若内容哈希未变则返回 `status: "skipped-unchanged"` 与当前 `activeRevision`

#### Scenario: 热重载失败返回诊断明细

- **WHEN** 默认目录插件存在编译错误时 AI 会话调用 `bytedock_plugins_reload`
- **THEN** 系统返回 `status: "kept-previous-on-error"`、保持原 `activeRevision` 不变，并附带出错插件的 `file`、`line`、`column` 与错误消息

### Requirement: 调用方基础权限门禁

系统 SHALL 对所有 `bytedock_*` 写操作（`bytedock_plugin_set_enabled`、`bytedock_plugin_config_patch`、`bytedock_plugins_reload`）强制校验调用方身份与活跃状态，拒绝只读客户端、已归档或已结束 Run 的线程，以及来自外部链接环境（linked caller）的跨域写请求。

#### Scenario: 只读 MCP 客户端尝试写操作

- **WHEN** 仅获批 `read-only` 访问级别的 MCP 客户端调用 `bytedock_plugin_set_enabled`
- **THEN** 系统拒绝执行并返回 `capability_denied` 错误，不产生任何文件写入或审批单

#### Scenario: 跨链接远程环境尝试修改本机插件配置

- **WHEN** 来自其他链接机器（`linked: true`）的 MCP 调用尝试执行 `bytedock_plugin_config_patch`
- **THEN** 系统拒绝执行并返回 `capability_denied` 错误，防止远程环境篡改本机配置

### Requirement: 宿主控制中心双向可见与实时同步

系统 SHALL 在宿主 Web/Desktop 的 ByteDock Control Center 界面中展示所有插件的当前 `enabled`/`status` 状态、已生效配置摘要、最近热更诊断与待人工审核队列，并允许用户在界面上直接启停插件或撤销 AI 所做的普通配置调整；当配置文件或 MCP 触发变更时，服务端 SHALL 向已订阅客户端实时推送状态更新。

#### Scenario: AI 修改配置后控制中心实时可见并可逆

- **WHEN** AI 通过 `bytedock_plugin_set_enabled` 停用某普通插件，用户打开或已打开 ByteDock Control Center
- **THEN** 界面即时显示该插件为 `disabled` 状态，且用户可直接点击开关重新启用该插件并写回 `plugins.yml`

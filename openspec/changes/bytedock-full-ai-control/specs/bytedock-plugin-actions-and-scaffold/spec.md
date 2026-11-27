## Purpose

定义 AI 通过统一插件动作工具触发 Egress Guard 自证与审计查询、扫描及受控导入 T3 Code / T3 Code Plus 数据、调用已启用插件业务方法、以及在默认插件目录安全生成本地插件脚手架的外部行为与安全约束。

## ADDED Requirements

### Requirement: EgressProof 自证、出站审计与 T3 只读扫描

系统 SHALL 通过 `bytedock_plugin_action` 支持 AI 执行 `egress_proof`（触发双段自证报告）、`egress_audit`（读取受限条数的出站审计事件与当前策略摘要）与 `legacy_scan`（只读扫描本机 `~/.t3-plus`、`~/.t3` 或指定只读源目录），上述动作不得修改源目录或降低安全等级。

#### Scenario: AI 触发 EgressProof 自证并查询审计事件

- **WHEN** 本机授权会话调用 `bytedock_plugin_action` 且 `action` 为 `egress_proof` 或 `egress_audit`
- **THEN** 系统返回实时 `EgressProof` 自证结果或最新出站审计事件列表与统计计数

#### Scenario: AI 只读扫描本地 T3 Code / T3 Code Plus 数据源

- **WHEN** 授权会话调用 `bytedock_plugin_action` 且 `action` 为 `legacy_scan`
- **THEN** 系统以严格只读方式返回发现的来源品牌、项目/线程数量与可导入分类，绝不写入源目录

### Requirement: 受控插件方法调用与禁止自审批

系统 SHALL 允许授权 AI 通过 `bytedock_plugin_action`（`action: "invoke"`）调用已启用插件的非特权业务方法；当目标插件已停用时 MUST 拒绝执行；系统 MUST 严格禁止通过该入口调用 `builtin.control-plane`（包括任何审批裁决方法）或直接触发未审批的 `builtin.legacy-importer.import`。

#### Scenario: 禁止通过通用插件调用入口自审批

- **WHEN** AI 调用 `bytedock_plugin_action(action: "invoke")` 并指定 `pluginId: "builtin.control-plane"`
- **THEN** 系统直接拒绝请求并返回权限错误，防止绕过人工审核门禁

### Requirement: T3 只读数据导入分级审批

系统 SHALL 将 `bytedock_plugin_action` 的 `legacy_import` 判定为高风险宿主数据写入操作：非本机活跃主会话直接拒绝且不建审批单；本机活跃主会话发起时生成包含源目录、导入分类与覆盖选项的待审核单并返回 `approval_required`，仅在宿主人类批准后执行只读源复制到 `~/.bytedock`。

#### Scenario: 主会话发起 T3 数据导入需人工批准后才执行

- **WHEN** 本机主会话调用 `bytedock_plugin_action(action: "legacy_import")` 指定源目录与分类
- **THEN** 系统返回 `status: "approval_required"` 而不写入 `~/.bytedock`；待宿主人类批准后才执行导入并返回导入结果摘要

### Requirement: 默认插件目录安全脚手架生成

系统 SHALL 支持授权 AI 通过 `bytedock_plugin_action(action: "scaffold_local_plugin")` 在默认目录 `~/.bytedock/plugins/<plugin-dir>/` 内生成包含合法 `manifest.json` 与入口源码的本地插件模板；系统 MUST 拒绝路径穿越、与内置插件重名或覆盖已有插件目录的请求，且新生成的本地插件 MUST 默认保持停用及未审批状态，须走既有人工审批流程方可启用。

#### Scenario: 生成默认目录本地插件模板且保持默认停用

- **WHEN** 本机活跃主会话调用 `bytedock_plugin_action(action: "scaffold_local_plugin")` 创建合法插件 `local.hello-dock`
- **THEN** 系统在 `~/.bytedock/plugins/local.hello-dock/` 写入 `manifest.json` 与 `index.ts`，刷新插件扫描列表，新插件在控制面中可见但处于 `approved: false` 与 `status: "disabled"`

#### Scenario: 拦截目录路径穿越脚手架请求

- **WHEN** AI 在 `scaffold_local_plugin` 中传入包含 `..` 或路径分隔符的插件目录或 ID
- **THEN** 系统直接拒绝请求并返回参数校验错误，不在磁盘创建任何文件

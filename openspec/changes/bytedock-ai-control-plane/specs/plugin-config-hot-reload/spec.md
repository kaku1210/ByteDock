## Purpose

定义 ByteDock 以默认配置文件（`~/.bytedock/userdata/plugins.yml`）和默认本地插件目录（`~/.bytedock/plugins/`）为唯一持久化真源的插件启停、声明式配置 Schema 校验、文件监听实时热更及失败回滚诊断的外部可观察行为，确保人工编辑、UI 操作与 AI 控制面归口到同一条安全生效链路。

## ADDED Requirements

### Requirement: 默认路径真源与启动加载

系统 SHALL 以当前 ByteDock 状态目录下的 `plugins.yml`（默认 `~/.bytedock/userdata/plugins.yml`，开发模式跟随实际 `stateDir`）作为插件启停与声明式配置的唯一持久化真源，并以数据根目录下的 `plugins`（默认 `~/.bytedock/plugins/`）作为本地热加载插件的唯一扫描目录。首次启动且 `plugins.yml` 尚未存在时，系统 SHALL 按内置默认配置正常启动而不报错；系统 MUST NOT 接受或回显明文密钥字段，所有敏感凭证引用 MUST 仅以安全引用形式表达。

#### Scenario: 首次启动无配置文件

- **WHEN** ByteDock 在干净的 `~/.bytedock` 目录首次启动且 `plugins.yml` 不存在
- **THEN** 系统自动创建默认插件目录 `~/.bytedock/plugins/`（若不存在），以默认启停与默认参数加载所有内置插件并正常就绪

#### Scenario: 配置文件包含疑似明文密钥字段

- **WHEN** 配置更新或磁盘 `plugins.yml` 在插件配置中直接写入受保护的明文凭据键（例如 `token`、`apiKey`、`password`、`secret` 的非引用明文值）
- **THEN** 系统拒绝应用该配置变更，返回明确的 Schema/安全校验错误，保留当前生效配置不变，且不在日志或查询结果中回显该明文值

### Requirement: 普通插件启停实时热更

系统 SHALL 支持通过修改 `plugins.yml` 中普通插件（非高风险权限受保护项）的 `enabled` 布尔值或通过控制面写操作，在不重启 ByteDock 进程的前提下实时启用或停用该插件，并将最新状态同步到插件列表接口与客户端界面。

#### Scenario: 停用普通插件即时生效

- **WHEN** 用户或授权控制面将某普通插件（如 `builtin.token-optimizer` 或 `community.napcat-qq`）的 `enabled` 改为 `false`
- **THEN** 系统在防抖窗口内更新运行态，使该插件在插件列表中的状态变为 `disabled`、后续不再调度其 Hooks、不再向外暴露其动态 MCP 工具、拒绝新的业务方法调用并返回明确停用错误，同时不撕裂已钉住旧 Revision 的在途会话

#### Scenario: 重新启用已停用插件

- **WHEN** 已停用的普通插件的 `enabled` 改回 `true`
- **THEN** 系统恢复该插件为 `active` 状态，按当前已校验配置重新生效其 Hooks 与业务方法，并向已连接客户端广播状态更新

### Requirement: 插件声明式配置校验与实时热更

系统 SHALL 为每个受管插件提供强类型的声明式配置校验规则；当 `plugins.yml` 发生磁盘变更或通过控制面提交局部配置更新时，系统 MUST 先完成解析与 Schema 校验，仅在校验通过后原子落盘并立即将新配置应用到内存运行态。

#### Scenario: 合法配置实时生效

- **WHEN** `plugins.yml` 中某已启用插件的业务参数（例如 `builtin.token-optimizer` 的 `steadyStateTargetPct` 或 `community.napcat-qq` 的 `rateLimitPerMin`）被修改为合法值并保存
- **THEN** 文件监听在防抖后自动重读并校验通过，运行态配置立即更新为新值，后续插件状态查询与业务行为直接反映新参数，无需重启服务

#### Scenario: 非法 YAML 或越界字段回滚保护

- **WHEN** 用户手工保存了语法损坏的 `plugins.yml`，或提交了类型错误/越界参数（如 `rateLimitPerMin: 0`）
- **THEN** 系统拒绝切换运行态，继续保持上一个合法配置快照运行，并记录包含文件路径、涉及插件标识与失败原因的结构化诊断信息供控制面与 UI 查询

### Requirement: 并发写入乐观锁与人工手改保护

系统 SHALL 在所有通过控制面或 UI 写入 `plugins.yml` 的路径上强制执行基于文件修改时间戳（`mtimeMs`）的乐观锁（CAS）与原子替换写盘，避免后台或 AI 写操作静默覆盖用户刚完成的手工文件编辑。

#### Scenario: 检测到并发手工编辑冲突

- **WHEN** 控制面基于旧的 `mtimeMs` 快照尝试写入 `plugins.yml`，而磁盘文件在此期间已被外部编辑器修改
- **THEN** 写操作失败并返回冲突错误（`stale_config`），不得覆盖磁盘上的用户手工改动

### Requirement: 默认目录本地插件热重载与错误诊断

系统 SHALL 监听默认插件目录 `~/.bytedock/plugins/`（不引入外部自定义路径映射），并在检测到源码或清单变更或收到显式重载指令时执行内容哈希去重与隔离编译加载；任何插件编译或加载失败时，系统 MUST 保留当前活动 Revision 不受影响并暴露可定位的错误诊断。

#### Scenario: 默认目录插件源码热重载成功

- **WHEN** 默认目录 `~/.bytedock/plugins/<plugin-id>/` 下已获批准的本地插件源码发生有效改动并触发热重载
- **THEN** 系统编译并安装新的活动 Revision，原有会话保持旧 Revision 排空语义，新请求按新 Revision 执行

#### Scenario: 本地插件源码存在语法错误

- **WHEN** 默认目录下的本地插件源码存在编译错误或非法顶层 await 并触发热重载
- **THEN** 系统返回 `kept-previous-on-error`，当前活动 Revision 保持不变，且诊断信息包含 `pluginId`、`file`、`line`、`column` 与错误摘要

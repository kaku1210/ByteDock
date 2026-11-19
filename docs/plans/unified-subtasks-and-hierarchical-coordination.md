# 统一子会话与分层 AI 协调设计规范

- **状态**：已拍板定稿（可直接进入 Phase 1 拆解与实施）
- **基线版本**：`develop@3a2c0ba90`
- **关联文档**：
  - [Core Graph and Data Model](../orchestration-v2/core-graph-and-data-model.md)
  - [Thread Lineage and Context Transfer](../orchestration-v2/thread-lineage-and-context-transfer.md)
  - [Orchestrator MCP Server](../orchestration-v2/orchestrator-mcp-server.md)
  - [Feature Lifecycles](../orchestration-v2/feature-lifecycles.md)

---

## 1. 背景与目标

在长周期、高复杂度的大会话（需求分析、架构重构、专项复盘等）中，用户希望从主会话拆出多个并行分支推进子任务，同时做到：

1. **人 + AI 统一维护**：对外不再割裂「人工子会话」与「AI 子会话」，统一为任务树中的「子会话（`subtask`）」；无论是人工划词拆分还是 AI 委派创建，后续都支持人工随时多轮接管、独立切模型，也支持父会话 AI 盘点、读取与继续推进。
2. **与根级 `Side Chat` 解耦**：所有旁路答疑统一归属根会话（`rootThreadId`），不再借用 `sideChat: true` 承载任务子会话。
3. **两层防套娃与横向提级**：支持 `L0 → L1 → L2` 最多两层树形拆解；L1 发现同级新需求时上报/提级到 L0 横向新建同级 L1，避免纵向失控嵌套。
4. **双模式回传不丢不重**：支持主动「回传并交父会话处理」（排队消费）与被动 `Bring back`（多附件聚合池、等待人工下一条消息一次性注入），并与已有委派自动唤醒机制清晰结算。
5. **平滑演进为分层 AI 协调流程**：L0 根会话可专注总控协调，按任务复杂度分层调度不同模型（示例：L0 最强模型、L1 负责人、L2 执行员工），配合树形多 Agent 协作总览页与共享工作树协作策略，默认不擅自创建隔离 worktree。

---

## 2. 核心概念与实体边界

| 概念                                 | 建议 Lineage 语义           | 侧栏主列表展示                              | 人 / AI 操作权限                                                                            | 典型用途                                         |
| ------------------------------------ | --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **根会话（L0）**                     | `kind: null`                | 显示                                        | 人 + AI 均可                                                                                | 大任务总控、需求拆解、最终收口                   |
| **任务子会话（`subtask`，L1 / L2）** | `kind: "subtask"`           | 隐藏（归属在任务树/总览下）                 | 人 + AI 双维护                                                                              | 划词拆分、人工新建子任务、T3 app-owned AI 委派   |
| **根级 `Side Chat`**                 | `sideChat: true`（归属 L0） | 隐藏（在根与各子会话的 Side Chat 面板共享） | 人 + AI 旁路问答                                                                            | 临时查问、背景核对；不可建子会话或嵌套 Side Chat |
| **历史普通分支（`fork`）**           | `kind: "fork"`              | 按现有逻辑保留                              | 保留原语义                                                                                  | 继承父时间线的对话分支                           |
| **Provider 原生子 Agent**            | 外部只读 `subagent`         | 按现有逻辑                                  | 只读展示（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L6722） | Codex / Claude 等运行时内部只读子代理            |

### 2.1 `L0 → L1 → L2` 两层矩阵

- **深度上限**：固定 2 层（`L0 = 0`，`L1 = 1`，`L2 = 2`），服务端硬拒绝 L3。
- **交叉创建规则**：
  - 人工可从 L0 拆出 L1；可从人工 L1 与 AI L1 拆出人工 L2。
  - AI 可从 L0 委派 AI L1；可从人工 L1 与 AI L1 向下委派 AI L2。
  - L2 禁止继续向下拆分或委派（UI 隐藏/禁用入口，服务端同步拒绝）。
- **横向提级规则**：L1 执行中发现与自身同级的新需求时，禁止向下挂为 L2/L3，而是上报/提级到 L0 横向新建同级 L1（UI 提供「提级到根会话新建 L1」，MCP 提供结构化提级动作）。

---

## 3. P0 架构与契约硬约束（动工前必须锁定）

以下 7 项约束均基于 `OrchestrationV2` 现有源码核验，直接决定数据模型、协议兼容与核心体验正确性。

### P0-1：拆分 Lineage 三件事——长期归属、来源锚点、单轮自动唤醒

- **现状问题**：
  - 现有 `OrchestrationV2AppThreadLineage`（[orchestrationV2.ts](../../packages/contracts/src/orchestrationV2.ts) L167）仅有 `fork | subagent | null` 及 `sideChat`、`temporary`。
  - 普通 `fork` 会继承父时间线（[ProjectionStore.ts](../../apps/server/src/orchestration-v2/ProjectionStore.ts) L1605）；委派子会话强依赖活跃的 `parentRunId` / `parentNodeId` 并立即触发 `subagent_spawn`（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L9563）。
- **约束设计**：
  1. T3 可双维护子任务统一使用 `kind: "subtask"`。
  2. **长期归属**：使用 `parentThreadId`、`rootThreadId` 表达任务树拓扑，`createdBy: "user" | "agent"` 仅作来源标识。
  3. **上下文来源锚点**：独立记录 `sourceAnchor`（`sourceThreadId`、`sourceRunId` / `sourceMessageId` / 选区快照与截止序号），与长期归属解耦。
  4. **单轮唤醒绑定与干预边界**：是否自动唤醒父 Run 绑定在**具体一次未结算的委派任务（Run / Task）**上，而不是永久焊死在线程上：
     - **未结算期间的人工中途调整**：A 委派的 AA 在完成结算前，人工发消息调整需求或补充约束，仍属于该次委派生命周期——AA 最终完成后仍按原委派唤醒/通知 A，并在回报中注明“执行期间已按人工调整要求完成”及变更摘要。
     - **已结算之后的人工续聊**：AA 已经完成并向 A 交差后，人工继续在 AA 中追问/微调属于人工主导的新任务，默认**不再自动唤醒 A**；如需交回 A，由人工显式触发「回传并交父会话处理」或 `Bring back`。

### P0-2：服务端统一判定树深度，并同步改造 SQLite 解码与家族索引

- **现状问题**：
  - `McpHttpServer.depthOf`（[McpHttpServer.ts](../../apps/server/src/mcp/McpHttpServer.ts) L1004）仅服务于遥测，且只沿连续的 `subagent` 边计数；中间插入人工子会话就会截断计数。
  - **高危兼容坑**：`ProjectionStore.shellIndexLineage`（[ProjectionStore.ts](../../apps/server/src/orchestration-v2/ProjectionStore.ts) L1187）对未知枚举值会解码为 `null`，而 `isListedThreadLineage` 会默认把 `null` 暴露进主侧栏列表。
- **约束设计**：
  1. 在服务端所有建子命令入口（UI 拆分、MCP 创建/委派、提级建 L1）统一沿任务父边计算深度：拒绝缺失父节点、拒绝成环、拒绝超过 `depth = 2`（L3）。
  2. 新增 `subtask` 枚举时，必须同步更新 `ProjectionStore.shellIndexLineage`、`isListedThreadLineage`、全局列表/归档查询、事件重放与旧客户端能力协商。
  3. 复用已有 `rootThreadId` 家族索引（[089_ShellThreadReadIndexes.ts](../../apps/server/src/persistence/Migrations/089_ShellThreadReadIndexes.ts) L15），补齐按直接 `parentThreadId` 查询能力；注意区分历史 `fork` 与 `subtask`，以及现有委派恢复索引（[079_DelegatedRecoveryIndexes.ts](../../apps/server/src/persistence/Migrations/079_DelegatedRecoveryIndexes.ts) L9）的覆盖范围。
  4. 跨环境节点使用 `(environmentId, threadId)` 标识；当远端祖先链路无法验证深度时，服务端应显式限制继续拆层。

### P0-3：主动回传、阶段性进度汇报、被动挂载与委派自动唤醒的统一结算

- **现状问题**：
  - `t3_thread_send`（[ThreadManagementService.ts](../../apps/server/src/orchestration-v2/ThreadManagementService.ts) L876、[orchestratorMcp.ts](../../packages/contracts/src/orchestratorMcp.ts) L546）默认不一定走排队，可能将消息送入父会话正在执行的轮次。
  - 已结束的 app-owned 子会话在收到人工或父 AI 后续消息后，服务端可能自动创建 follow-up task 并设 `completionWake: "always"`（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L9721），导致与显式回传冲突、父会话重复处理两次。
- **约束设计**：
  1. 用 `(childThreadId, childRunId, reportKind, resultVersion)` 唯一标识一份回传，其中 `reportKind: "interim" | "final"` 严格区分**阶段性进度汇报**与**终态交差结论**。
  2. **主动「回传并交父会话处理」**必须显式以 `mode: "queue"` 写入父会话消息队列，并返回父端 `messageId` / `runId` 回执。
  3. **运行中阶段性汇报（`reportKind: "interim"`）**：当子会话仍在工作中，人工可在对话中指示子会话“先把当前进度汇报给父会话”，或通过 UI 显式触发阶段性汇报；该汇报显式打标 `[阶段性进度]` 并进入父会话队列，**不提前关闭/结算当前未完成的委派任务**，待子会话最终完成后仍按正常流程提交 `final` 结论结算。
  4. **被动 `Bring back`** 仅挂载待合并记录，不创建父 Run。
  5. 当子会话存在尚未投递的委派完成通知时，显式 `final` 回传应与之**合并或替换**；对已送达父会话的同一结果版本仅展示回执。**除非人工或 AI 明确请求父会话再次处理，否则绝不触发第二次终态结算。**

### P0-4：多附件聚合池的精确消费点与状态机（解除 4 处现有 `merge_back` 拦截）

- **现状问题**：
  - `dispatchThreadMergeBack`（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L5826）要求来源是目标的直接 `fork` 且存在原始 `fork` transfer（委派子会话只有 `subagent_spawn` 会直接被拒），同时拒绝活跃或已有队列的父会话。
  - 父端在消息排队时拒绝 pending `merge_back`（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L7491），在启动时拒绝多来源 pending `merge_back`（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L7847，且有反向测试断言 [ThreadFork.execution.test.ts](../../apps/server/src/orchestration-v2/ThreadFork.execution.test.ts) L1426）。
  - `consumed` 在 `run.created` 命令阶段提前写入（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L9216），早于 provider 实际投递（[ProviderTurnStartService.ts](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts) L1756）。
- **约束设计**：
  1. 对归属合法的 `subtask`（不要求历史 `fork` transfer）开放 `merge_back` 多附件挂载，解除父端活跃/排队/多来源三处拦截，并同步更新旧反向测试。
  2. **精确消费点**：在父会话命令锁内，仅由 **“下一条新提交的父会话人工普通消息”** 原子绑定当前池中全部未绑定附件清单（即便该人工消息需进入队列，清单也随该 `messageId` / `runId` 走）。
  3. **严格排除项**：此前已排队的旧消息、子会话主动回报、自动 wake、审批/提问回答、`/compact` 命令，**均不得消费池中附件**。
  4. **三态生命周期**：附件状态拆分为 **`pending`（待挂载）→ `bound`（已绑定本轮）→ `delivered`（已送达）**。provider 实际接收前取消/启动前失败则回退 `pending`；provider 确认接收后发生业务失败则保留 `delivered` 记录，不再静默重放；崩溃导致投递不确定时按已有原生投递记录恢复（[ContextHandoffDelivery.ts](../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts) L113）。

### P0-5：根级 `Side Chat` 的归属、跨层承载与删除级联

- **现状问题**：
  - `ChatView` 当前隐藏子 Agent 的 Side Chat 入口（[ChatView.tsx](../../apps/web/src/components/ChatView.tsx) L2832），右侧面板标签按当前 `threadRef` 存储（[rightPanelStore.ts](../../apps/web/src/rightPanelStore.ts) L736），`SideChatPane` 直接把传入 `parentRef` 作为 `Bring back` 目标（[SideChatPane.tsx](../../apps/web/src/components/chat/SideChatPane.tsx) L76），关系视图亦有优先取 `forkedFrom.threadId` 的路径（[threadRelationships.ts](../../packages/client-runtime/src/state/threadRelationships.ts) L37）。
  - 服务端删除级联沿原始 `fork` transfer 查找直属 Side Chat（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L1830）。
- **约束设计**：
  1. **归属固定为 L0（`rootThreadId`）**：在 L0、L1、L2 打开的 Side Chat 面板共享同一组根级 Side Chat，当前 L1/L2 仅负责承载面板；`Side Chat` 内部禁止建子会话或嵌套 Side Chat。
  2. **上下文与回传无歧义**：新建 Side Chat 默认锚定根上下文；若从 L1/L2 划词带入，则保留真实来源层引用。`Bring back` 目标**固定为 L0**，按钮明确显示 **“挂到〈根会话名〉的下一条消息”**；临时 Side Chat 继续禁止回传。
  3. **服务端归属与工作区对齐**：服务端持久化归属与删除级联统一对齐 `rootThreadId`（含旧数据迁移兼容）；独立 worktree 场景下，Side Chat 面板内置终端与 diff 必须指向 Side Chat 实际工作区。

### P0-6：MCP 树内访问权限、L1 横向提级协议与防死循环

- **现状问题**：
  - `t3_thread_list` 目前按项目或全局查询，默认含 `subagent`、排除 `Side Chat`，缺少「仅返回当前调用方直系子任务」的过滤（[OrchestratorMcpService.ts](../../apps/server/src/mcp/OrchestratorMcpService.ts) L3160、[ThreadManagementService.ts](../../apps/server/src/orchestration-v2/ThreadManagementService.ts) L843）。
  - `t3_thread_send`（映射到 `sendToThread`，[OrchestratorMcpService.ts](../../apps/server/src/mcp/OrchestratorMcpService.ts) L3362）受跨线程权限模式校验（[McpToolAccess.ts](../../apps/server/src/mcp/McpToolAccess.ts) L197），低权限 L1 可能无法直接驱动高权限 L0。
- **约束设计**：
  1. **树内可见性**：新增服务端鉴权后再分页的直系 `children` 查询（支持展示“待人工首发”的持久子会话），使父会话 AI 可盘点、读取（`t3_thread_read`）或接手推进（`t3_thread_send`）。
  2. **跨权限向上回报**：向上回报与提级使用结构化意图；低权限子会话允许向父端“入箱”提交回报/提级，但是否自动启动高权限父轮仍须满足父端权限策略。
  3. **L1 提级新建同级 L1（幂等协议）**：使用持久化 `requestId` + 来源 L1 标识。人工提级可在 L0 下直建草稿子会话；AI 提级提交根待办由 L0 接单创建同级 L1。重复接单返回同一 `childThreadId`；若根会话已归档、删除或不可达，返回明确终态错误。
  4. **防互发死循环**：所有跨节点自动转发/唤醒携带因果链 ID（`causationChain`），同一因果链重复回到同一节点时强制停止自动唤醒。

### P0-7：禁止 AI 擅自新开独立 worktree 的服务端审批闸门

- **现状问题**：
  - 本地 `delegate_task(isolation: "worktree")` 当前直接解析父 checkout HEAD 生成 `workspaceStrategy` 并交由准备流程创建工作树（[OrchestratorMcpService.ts](../../apps/server/src/mcp/OrchestratorMcpService.ts) L2659、[ThreadLaunchService.ts](../../apps/server/src/orchestration-v2/ThreadLaunchService.ts) L695）；远端委派已明确拒绝 `worktree`（[RemoteDelegation.ts](../../apps/server/src/peer/RemoteDelegation.ts) L289）。
- **约束设计**：
  1. 默认所有子会话共享父会话工作目录/工作树。
  2. 任何由 AI 发起的独立 worktree 请求必须在服务端转为**持久化待批准请求**，绑定 `projectId`、父子任务 ID、基准提交 SHA 与 `requestId`，由已鉴权人工客户端批准一次后才可执行。
  3. 拒绝、超时过期或父任务已取消时终止；重放同一已批准 `requestId` 复用同一结果，不重复创建工作树。
  4. 委派（`delegate_task`）、通用启动（`ThreadLaunchService`）与重试准备共用同一审批闸门。
  5. 若需同时约束 provider 在 shell 内自行执行 `git worktree add`，依赖对应运行时的工具权限审批能力，并在协作总览页明示当前约束覆盖范围。

---

## 4. P1 状态机与并发边界规范

| 边界领域                         | 现有代码关键落点                                                                                                                                                                                                                                                                                                                                                                                                                               | 必须补齐的约束行为                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主动回传遇父等待/暂停/切模型** | 队列暂停（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L2517）、人工消息释放暂停（L7465）、出队选模（L1016）                                                                                                                                                                                                                                                                                                      | 父会话处于等待审批/提问时仅入队、不打断原请求；父队列处于暂停态时仅入队并提示回父会话确认恢复，**不自动释放暂停队列**；回报出队时跟随父会话当前配置模型并展示实际模型与阻塞原因；UI 双击/MCP 重试复用同一回报 ID 保证幂等；子会话仍在运行时支持由人工指令或显式按钮触发 `[阶段性进度]` 中途回报（不提前结算最终委派任务）。                                                           |
| **同源多次挂载、撤销与预算裁剪** | 同源覆盖（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L5928）、增量范围（L8788）、聚合预算（[ContextHandoffDelivery.ts](../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts) L41）                                                                                                                                                                                                                  | 同版本重复点 `Bring back` 幂等返回原挂载；同源新版本替换尚未绑定的旧版；已消费部分按来源截止位置去重。父输入框展示待合并清单（来源、覆盖范围、版本），支持预览与撤销未绑定项。多份附件共享总上下文预算，每个来源保底保留结论摘要与 `childThreadId` 回查引用，并明示省略部分；最低预算也装不下时保留待处理清单提示人工裁剪。                                                           |
| **划词草稿、断线恢复与来源锚点** | 划词锚点（[AssistantSelectionToolbar.tsx](../../apps/web/src/components/chat/AssistantSelectionToolbar.tsx) L127）、现有立即发送与超时删空会话（[useSideChat.ts](../../apps/web/src/components/chat/useSideChat.ts) L91）、本地草稿（[composerDraftStore.ts](../../apps/web/src/composerDraftStore.ts) L133）、无稳定 run 例外（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L5704）                              | 划词拆分与一键拆分共用同一持久创建命令（带客户端幂等键），仅预填草稿不自动发、不因超时删空会话；断线重连找回同一子会话。保存选区快照与来源截止序号，父会话后续推进不漂移；后续进展由子会话按需 `t3_thread_read` 回查。父 AI 可见“待人工首发”状态，但未经显式接手不得抢先发送。                                                                                                        |
| **首轮摘要真实投递内容**         | fork 决策（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L8451）、Side Chat 摘要（[ContextHandoffService.ts](../../apps/server/src/orchestration-v2/ContextHandoffService.ts) L249）、投递取值（[ContextHandoffDelivery.ts](../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts) L55）                                                                                                                | `subtask` 首轮强制跳过原生 fork，走独立摘要投递策略（不复用带“不要继续主任务”的 Side Chat 提示词，避免 `ContextHandoffDelivery` 因带 `history` 而跳过 `summaryText`）。确保 provider 实际收到：预算内结构化骨架（目标、约束、已做决定、未决项、来源截止点）+ 人工/委派指令 + `parentThreadId` 回查引用；测试直接断言 provider 收到的最终输入。                                        |
| **父子归档、删除、Stop 与锁序**  | 归档检查（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L4257）、删除回执处置（[ThreadDeletion.ts](../../apps/server/src/orchestration-v2/ThreadDeletion.ts) L130）、锁顺序（[Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts) L15642）                                                                                                                                                    | 父会话点 Stop 仅取消本轮绑定的委派，不终止独立人工子会话。归档/删除存在持久子任务或待回传记录的父节点前，先列出受影响对象并执行明确规则。子任务删除或取消时同步终结父端等待态、关联提级请求与未投递挂载。所有多节点操作严格沿**根到叶**顺序取锁，避免子回传与父删除互锁。                                                                                                             |
| **共享工作树路径归因与写入冲突** | checkpoint 扫描（[CheckpointService.ts](../../apps/server/src/orchestration-v2/CheckpointService.ts) L464）、HEAD 未变返回 `null`（[GitVcsDriver.ts](../../apps/server/src/vcs/GitVcsDriver.ts) L2071）、启动锁释放（[ProviderTurnStartService.ts](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts) L1879）、回滚保护（[CheckpointRestoreSafety.ts](../../apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts) L9） | 总览明确区分三类路径状态：**① 计划修改、② 本 run 工具确认写入、③ 工作树观察到但归属待核实**（避免把共享工作树的混杂 diff 误归因给单个子会话）。不同路径并行；重叠文件在可控写工具上预约规范化路径（覆盖目录包含、重命名两端与别名），冲突时等待前写者退出后重读最新内容再写；不可拦截的 shell/provider 如需强顺序保证，按整个 checkout 串行安排写者。既有共享区文件回滚保护继续生效。 |

---

## 5. P2 演进与分期路线

### 5.1 关键演进点

- **Phase 2 LLM 语义压缩缓存**：现有 `TextGeneration` 接口（[textGeneration.ts](../../packages/provider-core/src/server/textGeneration.ts) L125）需扩展会话摘要用途；缓存键不能仅用 `(parentThreadId, sourceRunId)`（流式更新、重试或回滚会改变内容），必须纳入**内容版本/截止点 + 摘要策略版本**。同输入并发共享一次生成；超时/模型不可用/超预算时降级返回带原因标注的 MVP 骨架摘要，并保留可配合 `t3_thread_read` 分页回查的位置或 `itemId`（[orchestratorMcp.ts](../../packages/contracts/src/orchestratorMcp.ts) L441）。
- **树形多 Agent 协作总览页**：基于根级家族快照（[orchestrationV2.ts](../../packages/contracts/src/orchestrationV2.ts) L3947）按需展开详情，取代仅看直属关系的局部控件（[ThreadRelationshipsControl.tsx](../../apps/web/src/components/chat/ThreadRelationshipsControl.tsx) L543）。清晰区分「会话状态 / 任务状态 / 投递状态」，避免用户仅浏览总览就误触发终态结果确认送达副作用（[OrchestratorMcpService.ts](../../apps/server/src/mcp/OrchestratorMcpService.ts) L3322）。
- **L0 协调者角色模板**：按当前环境实际可用模型动态配置，README 中提及的 `neon` / `carbon` / `hydrogen` 仅作分层示例，不写死模型名。

### 5.2 推荐分期实施

1. **Phase 1（底座与核心闭环）**：`subtask` 契约与 SQLite 解码/深度校验 + 划词/一键拆分草稿态 + MVP 骨架摘要懒注入 + 双模式回传（显式 `mode: "queue"` 主动回传 + 三态多附件 `Bring back` 池）+ 根级 `Side Chat` 解耦 + MCP 直系 `children` 查询。
2. **Phase 2（协同与治理）**：树形多 Agent 协作总览页 + L1 横向提级幂等协议 + 服务端 worktree 人工审批闸门 + 共享工作树三层路径归因与重叠冲突提示/预约机制。
3. **Phase 3（智能提效）**：基于 `TextGeneration` 的版本化语义压缩缓存 + L0 总控「协调者模式 / 角色模板」。

---

## 6. 核心验收场景（E2E 必过）

1. **草稿幂等与混合两层树**
   - 从 L0 旧消息划词创建人工 L1，模拟“服务端已建成功但客户端未收到回执”断线；重连后仅存在 1 个子会话，选区与草稿可恢复。
   - L0 继续新增消息后，人工在 L1 确认发送首轮：确认前 provider 启动次数为 `0`；确认后恰好启动 `1` 次、未调用原生 fork，且注入摘要仍锚定原截止点。
   - 分别从人工 L1 与 AI L1 创建 L2 均成功；再分别从 UI 与 MCP 尝试创建 L3，服务端均硬拒绝。
2. **忙父会话接双主动回报与委派去重**
   - 父会话正等待审批（或运行中），L1-A、L1-B 依次触发主动「回传并交父会话处理」，同时对 A 制造双击/网络重试。
   - 结果：父会话审批不被打断，父队列仅新增 A、B 两条回报（无重复）；若父会话切换模型，出队时按约定模型与 A→B 顺序消费。
   - 将 A 换为带自动完成通知的 AI 委派任务，显式回传后同一结果版本仅在父会话处理 `1` 次。
3. **三份被动挂载、队列隔离与三态故障恢复**
   - 父会话已有排队消息 `X`，随后 L1-A、L1-B、L1-C 依次点 `Bring back`（期间重复挂 A，撤销并重挂 B）。
   - 结果：`X` 与自动 wake 均不取走附件；用户切回父会话发送 1 条综合指令后，一次性带入 3 份唯一来源、共享总预算、仅跑 1 轮，下一轮不再重复注入。
   - 故障分支：分别模拟「provider 接收前取消」与「provider 接收后业务失败」，验证前者附件退回 `pending` 池、后者保留 `delivered` 记录且下一轮不静默重放。
4. **跨层根级 `Side Chat` 与幂等提级**
   - 在 L2 中打开根级 Side Chat，确认入口展示与 L0/L1 完全一致、独立 worktree 下终端/diff 指向正确、`Bring back` 按钮明示“挂到〈L0〉的下一条消息”，且 Side Chat 内无法建子会话或再开 Side Chat。
   - L1 针对同一同级需求分别通过 UI 与 MCP 重试提级，根下仅产生 1 个同级 L1；若与“归档根会话”并发，结果必须是可追溯的成功或明确拒绝。
5. **共享工作树路径归因与 worktree 人工审批闸门**
   - 子会话 A、B 修改不同路径可并行推进；两者操作同一文件时按策略提示/串行等待，B 读取 A 写入后的最新版本；期间夹杂一次人工外部修改，总览正确归类为“工作树观察到、归属待核实”。
   - AI 调用 `delegate_task(isolation: "worktree")` 后：人工批准前 worktree 创建次数为 `0`；拒绝后仍为 `0`；批准并重放同一请求后恰好创建 `1` 个。
6. **父 Stop 隔离与多节点清理一致性**
   - 父会话点击 Stop 时，仅取消本轮绑定的 AI 委派，独立人工子会话继续保留运行或待命状态。
   - 删除/归档含子任务的父会话或取消运行中子任务时，父端等待态、关联提级请求与未投递挂载同步清理且无死锁。
7. **委派中途人工调整、阶段性进度汇报与结算后人工续聊隔离**
   - A 委派 AA 执行中，人工向 AA 发出中途需求调整，并指示 AA 先把当前进度回报给 A：A 队列收到标有 `[阶段性进度]` 的汇报，AA 的委派任务保持未结算并继续推进。
   - AA 最终完成后，自动唤醒/通知 A 结算本次委派，并在最终结论中带出“执行期间已按人工调整要求完成”的变更说明。
   - 结算完成后，人工继续在 AA 中发起新一轮续聊，AA 完成后**不再自动唤醒 A**；仅当人工显式点「交父会话处理」或 `Bring back` 时才回流到 A。

---

## 7. 已拍板的产品语义（Locked Decisions）

以下 6 项产品语义均已确认锁定，作为 Phase 1–3 实施与测试的唯一口径：

1. **委派生命周期与人工介入后的父会话通知边界**
   - **进行中（未结算）的人工调整**：A 委派的 AA 尚未完成结算前，人工在 AA 中发消息调整需求或补充约束，仍属于原委派任务；AA 最终完成后**仍须自动通知 A 结算**，并说明“执行期间已按人工要求调整需求”及具体变更。
   - **已结束（已结算）后的人工续聊**：AA 已经完成并向 A 交差后，人工继续在 AA 中续聊属于人工主导的新任务，默认**不再自动唤醒 A**；如需交回 A，由人工显式点「回传并交父会话处理」或 `Bring back`。
2. **子会话运行中的阶段性进度汇报**
   - **支持运行中中途汇报**：当 AA 仍在执行时，人工可在对话中让 AA 先把当前进度汇报给 A，或通过显式入口触发；该消息显式打标为 `[阶段性进度]`（`reportKind: "interim"`）进入 A 的队列，**不提前结算当前委派任务**，待 AA 最终完成后再提交 `final` 结论完成结算。
3. **父会话队列暂停态遇主动回传**
   - **不自动恢复父队列**：仅将回报入队，并在界面提示“父会话队列已暂停，需回父会话确认恢复”，避免绕过人工故障处理。
4. **共享工作树重叠文件协作分期**
   - **分两步落地**：MVP 先落「三层路径归因（计划修改 / 工具确认写入 / 工作树观察待核实）+ 协作页重叠告警 + 协议软协作」；Phase 2 再加可控写工具的服务端路径预约锁与不可控 shell 的 checkout 串行开关。
5. **L1 横向提级新建同级 L1 的触发流**
   - **AI 提级走 L0 接单，人工提级直建草稿**：AI 提级默认进入 L0 队列/待办由 L0 协调者按当前运行模式接单创建（不额外打断全自动协调）；人工在 UI 点「提级到根会话新建 L1」则直接在 L0 下建持久化草稿并打开编辑。
6. **父会话归档 / 删除对名下持久 `subtask` 的处置**
   - **列出受影响项 + 整树一致处理**：操作前展示受影响子会话与待回传清单；归档默认整棵任务树一并归档（运行中先确认停止），删除默认级联清理整棵任务树与根级 `Side Chat`（不留孤儿节点）。

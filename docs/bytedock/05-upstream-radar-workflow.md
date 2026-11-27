# 05 · AI 上游追踪与选择性吸收流水线（Upstream Radar）

> 本文档定义 ByteDock 上游追踪与选择性吸收流水线（Upstream Radar）工程规范。

---

## 一、核心理念：从“被动 `git merge`”转向“AI 语义级 PR 选择性吸收”

随着 `ByteDock` 成为独立品牌与插件化架构产品，继续做批量 `git merge upstream/main` 会带来两大弊端：

1. 每次合并被迫处理大量品牌文案、遥测埋点与单体结构冲突；
2. 为了迁就 Git 文本合并，不敢在架构上彻底演进。

因此采用 **「微内核同构保护区 + AI 持续巡检 `pingdotgg/t3code` PR 语义移植」** 机制：

- **内核保持同构（控制语义距离）**：`apps/server/src/orchestration-v2/`、`packages/client-runtime/`、`apps/mobile/` 保持与上游一致的概念和目录结构，ByteDock 的特色只通过 11 处薄接缝挂入独立插件目录。这样上游每出一个棘手的并发竞态、WS 性能优化或 Provider 协议修复，AI 都能 **1:1 高保真移植**。
- **插件化吸收上游新功能**：上游新增的有价值垂直功能，不直接往内核堆砌，而是由 AI **转写为 `plugins/plugin-*`** 接入 ByteDock 的扩展点。
- **把 `Upstream Radar` 本身做成 ByteDock 的 0 号自动化插件（Dogfooding）**，基于仓库现成的 `scheduledTasks` 定时运行。

---

## 二、Upstream Radar 四类自动化分诊流程

```text
定时拉取 pingdotgg/t3code 新合入 PR / Commits（对照 upstream-ledger.jsonl 水位线去重）
        │
        ▼  [阶段 1：只读巡检 + 低成本快速模型分类 Triage]
        │   读取 PR 标题、正文、diff stat、变更文件路径、是否命中遥测/敏感词
        │
        ├── A 类：内核修复 / 并发竞态 / 性能 / 安全 / Mobile 同步
        │        （触及 orchestration-v2、client-runtime、ws 底座、React 性能）
        │        └─► 自动派发移植子任务：在独立 worktree 按单 PR 语义 1:1 移植 + 连同原测试迁入
        │            + 跑 vp run check:changed 与定向测试 → 生成待审 PR / 摘要卡通知人工拍板
        │
        ├── B 类：Provider / SourceControl / Issue / Secret 适配更新
        │        （触及 packages/provider-*、source-control-*、ACP 协议兼容）
        │        └─► 隔离度极高，AI 几乎零摩擦同步更新对应 driver/plugin 包 + 跑对应 replay 测试
        │
        ├── C 类：上游新垂直功能（新面板、新 MCP 工具、新第三方集成）
        │        └─► 先输出一页《价值与插件化评估卡》推给界面 / Bot：
        │            - 确认需要 → AI 不污染内核，而是【转写为 ByteDock 插件】接入标准 Hook/Slot
        │            - 不需要 → 标为 skipped 并记入台账
        │
        └── D 类：明确拒绝项（PostHog/Sentry 遥测、官方品牌/商业云 Clerk 绑定、已被 ByteDock 方案超越的功能）
                 └─► 自动标记 skipped + 写入拒绝理由到 upstream-ledger.jsonl，永不重复打扰
```

---

## 三、保证流水线长期稳定的 7 条工程纪律（含 R1/R3 补强 & 用户增补 `idea-sync` 柔性吸收）

1. **按「单 PR 粒度」分三种方式灵活吸收，绝不攒 50 个 commit 硬合，也不为硬 `cherry-pick` 自我设限**
   - **`derivation: "cherry-pick"`（最省事）**：无冲突的纯底层 A 类修复（如 WS 竞态、SQLite 锁修复）直接单 PR `cherry-pick` + 连同原测试迁入，随时可回滚；
   - **`derivation: "idea-sync"`（只同步思路 + AI 原生重写一版 · 一等公民吸收方式）**：凡触及已分叉区域、代码风格/耦合过重、或更适合按 ByteDock 自己架构实现的改动（不仅限于 C 类新功能，也涵盖 A/B 类复杂修复），**不需要硬搬上游补丁**——由 AI 提炼上游 PR 的**问题根因、核心思路、边界条件与测试场景**，在 ByteDock 插件区或自有代码结构里干净重写一版，并补齐等价回归测试验证，台账标记 `derivation: "idea-sync"`；
   - **`derivation: "semantic"`**：仅在轻度接缝冲突且保留原文件结构更划算时，对原补丁做语义移植 + 人工评审。
2. **D 类零遥测与凭证门禁前置到 Stage 1 巡检阶段**
   - 与 `EgressProof` 共享同一份禁用域名/依赖规则真源（`posthog` / `sentry` / `clerk` / 非授权读取 `~/.claude.json` 等），在 Stage 1 分诊阶段即自动降级为 D 类，永不进入 A 类移植队列。
3. **双 tag 接缝柔性守卫（`scripts/check-seams.ts`）与保护区漂移指标（`normalized-diff%`）**
   - 维护机读台账 `seam-ledger.json`（每条目含 `{ id, file, tagCount, anchor: "block" | "import" | "both", mode?: "strict" | "diverged", driftThresholdPct, review: "auto" | "manual" }`，v0.1 共 12 处，接缝 5/6/7/8 标 `review: "manual"`）；
   - **双 tag 协议**：函数体/区块采用 `// bytedock-seam:<id> ... // end-bytedock-seam:<id>`，顶部 1–2 行 import 采用行尾注释 `// bytedock-seam-import:<id>`；
   - **git-diff 锚定 CI 规则（`vp run check:seams` 并入 `check:changed`，防误改不卡死主动演进）**：① 默认（`mode: "strict"`）防止**无意间**改乱未 tag 的上游既有行或整文件重排格式化，确保一眼可辨“哪几行是 ByteDock 插口”；② 当团队明确采用 **`idea-sync`（只同步思路、AI 原生重写）** 或主动演进某老文件时，只需在 `seam-ledger.json` 显式登记 `mode: "diverged"`（或在对应改动注明 `// bytedock-idea-sync:<prNumber>` 并入 `upstream-ledger.jsonl`），守卫即切换为提示/留痕而非机械红灯阻断；③ 配 4 件套回归 fixture（clean / untagged-upstream-edit / tagged-import / explicit-idea-sync-diverged）；每周输出 `normalized-diff%` 漂移周报供决策参考。
4. **幂等持久化台账 `upstream-ledger.jsonl` + 周期复验**
   - 以 `prSha` 为幂等键追加记录，防止重复消费 Token；每周期跑一次 reconciliation job 复验已移植项的定向回归测试依然全绿：
   ```json
   {"prNumber":38874,"prSha":"abc1234","title":"Structured Thread Results","category":"C","derivation":"plugin","decision":"ported_as_plugin","targetPlugin":"plugin-orchestration-pro","localCommit":"def5678","verifiedWith":"vp test run ...","reason":"转为编排插件标准结构化回传能力","processedAt":"2026-11-27T02:00:00Z"}
   {"prNumber":38901,"prSha":"bcd2345","title":"Add PostHog funnel event","category":"D","derivation":"none","decision":"skipped","reason":"Stage 1 命中零遥测策略，自动跳过","processedAt":"2026-11-27T02:00:05Z"}
   ```
5. **Stage 1 → Stage 2 解锁门禁**：Stage 1（只读每日巡检日报）需连续人工校验分类准确率达标后，才开启 Stage 2（独立 worktree 自动移植 + 定向测试 + 一键审批卡）；且 **Dockview 换壳等高摩擦 UI 改造必须排在 A/B 类流水线至少跑通一轮实战之后**。
6. **Provider 插件回放夹具准入**：B 类 Provider 变更与未来社区 Provider 插件必须通过真实录制回放夹具测试，复用 `docs/internals/03_providers.md` 的已知陷阱检查表。
7. **独立 `scheduledTasks` 托管**：通过接缝 15 接入宿主 `ScheduledTaskService`，让 `plugin-upstream-radar` 作为 0 号插件持续自举运行。

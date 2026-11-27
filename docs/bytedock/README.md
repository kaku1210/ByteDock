# ByteDock 架构设计与开发文档索引

本目录收录 **ByteDock** 的长期核心架构设计、插件平台规范、ADR 决策台账、上游同步工作流与持续演进的开发进度总账，供开发者与 AI 代理在任意工作区直接查阅。

> **真源优先级说明**：当早期蓝图文档中的部分文件名、接口草案或阶段规划与仓库最新实现存在演进差异时，以**当前仓库代码**、[seam-ledger.json](../../seam-ledger.json)、[openspec/changes/](../../openspec/changes/) 及 [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md) 为最高真源。

## 文档导航

| 文档                                                                                       | 核心内容                                                                                                           | 适用场景                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [DEVELOPMENT_STATUS.md](./DEVELOPMENT_STATUS.md)                                           | **开发进度与发布总账**：已完成阶段 0–3、AI 全面控制面、`t3code-plus` 同步记录、Release 校验账与下一阶段待办清单    | 新会话启动、了解现状、规划下一步工作                                          |
| [01-brand-and-positioning.md](./01-brand-and-positioning.md)                               | 品牌独立定位、`~/.bytedock` 目录边界与去商标耦合清单                                                               | 涉及品牌文案、路径、图标或发布配置                                            |
| [03-plugin-platform-spec.md](./03-plugin-platform-spec.md)                                 | 插件内核包拓扑、4 级权限模型、Revision Pinning、12 冻结声明式 UI 原语与热重载防坑铁律                              | 开发/修改 `@bytedock/plugin-kernel`、插件 SDK 或前端 UI 渲染器                |
| [04-product-features-and-roadmap.md](./04-product-features-and-roadmap.md)                 | ByteDock 特色矩阵、4 大旗舰插件族（安全与省 Token、多 Agent 工程控制、自有订阅 Bots、动态 Provider）与分阶段路线图 | 规划下一阶段特性（如 Dockview 分屏、Token X-Ray 面板、Bots UI、Colab 算力舱） |
| [05-upstream-radar-workflow.md](./05-upstream-radar-workflow.md)                           | AI 上游追踪与选择性吸收流水线（A/B/C/D 分诊、`idea-sync` 标记规范与纪律）                                          | 同步 `t3code-plus` 或官方 `pingdotgg/t3code` 上游改动                         |
| [07-redteam-review-synthesis-and-adrs.md](./07-redteam-review-synthesis-and-adrs.md)       | 架构红队评审综合裁决与 **ADR-01 ~ ADR-12** 封板记录                                                                | 理解架构边界与关键取舍原因，避免重复踩坑                                      |
| [09-final-architecture-and-dev-blueprint.md](./09-final-architecture-and-dev-blueprint.md) | 终版 10 章研发施工总蓝图（总架构、内核契约、缝隙手术卡、Egress Guard、UI 渲染与验收矩阵）                          | 深入查阅插件内核与各子系统详细设计                                            |

## 相关规范与规格入口

- AI 协作与工程门禁规范：[AGENTS.md](../../AGENTS.md)
- 上游 14 处严格缝隙台账：[seam-ledger.json](../../seam-ledger.json)
- 自动化校验脚本：[scripts/check-seams.ts](../../scripts/check-seams.ts) · [scripts/check-zero-telemetry.ts](../../scripts/check-zero-telemetry.ts)
- AI 控制面一期 OpenSpec：[openspec/changes/bytedock-ai-control-plane/](../../openspec/changes/bytedock-ai-control-plane/proposal.md)
- AI 全面控制面二期 OpenSpec：[openspec/changes/bytedock-full-ai-control/](../../openspec/changes/bytedock-full-ai-control/proposal.md)

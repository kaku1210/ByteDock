<h1 align="center">ByteDock</h1>

<p align="center">
  <strong>Your open, zero-telemetry, hot-reloadable multi-agent engineering dock</strong><br />
  <a href="https://byte.didyou.eat">byte.didyou.eat</a>
</p>

> **Independent Open-Source Notice**: ByteDock is an independent open-source project evolved from MIT-licensed source code and is **not affiliated with, endorsed by, or sponsored by T3 Tools, Inc.** All local runtime data is isolated under `~/.bytedock/` (never modifying `~/.t3/` or `~/.t3-plus/`), and all outbound commercial telemetry / crash reporting is stripped and statically gated in CI (`scripts/check-zero-telemetry.ts`).

## ByteDock Roadmap & Heritage TODO

- [x] 优化侧栏分组与折叠体验（已随上游原生能力覆盖）：支持按仓库 / 路径 / 独立分组与 `Boring sidebar` 按项目折叠、折叠态四态圆点提示（等待审批 / 失败 / 未读 / 运行中）及计数、项目与会话置顶排序、`Cmd/Ctrl+K` 跨环境定位与 `Settle` / `Archive` 分离。
- [x] 优化会话内模型切换与任务交接（主体已由上游 + Plus Phase 1–3 覆盖）：已具备 `ModelSwitchRow` / `HandoffRow` 切换与交接展示、`ProviderStatusBanner` 失效/未登录处理入口，以及统一子会话与协作总览交接闭环。
  - [ ] （可选微调）运行中切模型与交接详情提示：在输入框明确区分本轮运行模型与下轮生效模型，并在 `HandoffRow` 中补充交接方式（原生续接 / 历史摘要）与失败原因详情。
- [x] 完善多 Agent 协作页面：整合已有父子任务关系、子 Agent 状态与工作记录。
  - [x] 提供任务总览，展示主任务、子任务、执行模型与当前状态。
  - [x] 集中展示运行中、等待审批和失败任务的进度与阻塞原因。
  - [x] 支持打开子会话、返回父会话，并按实际能力提供取消、继续等操作。
  - [x] 汇总各 Agent 的结论、产物与修改文件。
  - [x] 展示各任务使用的目录或工作树，帮助识别修改范围重叠。
- [x] 支持在大会话中统一发起并维护子会话（详细架构约束、边界规范与验收场景见 [统一子会话与分层 AI 协调设计规范](./docs/plans/unified-subtasks-and-hierarchical-coordination.md)）：对外统一为支持人 + AI 共同维护的任务树「子会话」（`createdBy` 仅作来源标识），与根级 `Side Chat` 解耦；底层按是否绑定父 Run 自动唤醒复用不同通道。
  - [x] 划词或从会话一键「拆为子会话」：创建持久化子会话并打开视图，仅将选中段落预填到输入框草稿、不自动发送，由人工选模型并补充指令后手动发送。
  - [x] 三层上下文策略：首轮发送时跳过重型原生 fork，懒注入父会话完整上下文的压缩摘要（已完成 MVP 受控预算结构化骨架摘要，以及 Phase 3 基于 `TextGeneration` 按不可变版本 SQLite 缓存的 LLM 语义压缩与降级回退）并附带 `parentThreadId`，支持按需调用 `t3_thread_read` 回查原文。
  - [x] `Side Chat` 根会话归属规则：同一大任务下的所有 `Side Chat` 统一隶属于根会话（`rootThreadId`），在根会话与任意子会话中均保留入口并共同查看/打开根会话的 `Side Chat`；`Bring back` 目标固定为根会话，`Side Chat` 本身不支持创建子会话或再嵌套 `Side Chat`。
  - [x] 支持 `L0 → L1 → L2` 两层子会话矩阵（服务端统一深度校验，封顶 2 层防套娃）：人工可从 L0 开 L1，也可给人工 L1 与 AI L1 开出人工 L2；AI 可从 L0 委派 AI L1，也可从人工 L1 与 AI L1 向下委派 AI L2；L2 不再继续向下拆层。L1 过程中发现同级新需求时，不上套成 L2/L3，而是上报/提级到 L0 横向新建同级 L1（UI 同步提供「提级到根会话新建 L1」入口）。
  - [x] 人 + AI 双维护闭环：子会话支持人工多轮交互与独立切模型，同时在父会话的 `t3_thread_list` 中提供鉴权过滤的直系非临时子会话查询，使父会话 AI 可直接通过 `t3_thread_read` / `t3_thread_send` 盘点、汇总或接手推进。
  - [x] 双模式回传与排队聚合（含与委派自动唤醒的统一结算及三态故障恢复，详见设计规范）：
    - [x] 主动「回传并交父会话处理」：将子会话结论摘要与 `childThreadId` 引用组装为结构化消息，显式以 `mode: "queue"` 发给父会话复用消息排队队列（空闲立刻开跑，父会话运行中/等待审批时按序排队消费，父队列暂停态不自动恢复；支持运行中按人工指示发送 `[阶段性进度]` 中途汇报且不提前结算委派；委派进行中人工调整需求完成后仍通知父会话并说明变更，委派结算后人工续聊不再自动唤醒父会话）。
    - [x] 被动 `Bring back`（`thread.merge_back` 多附件聚合池）：仅向父会话挂入待合并增量上下文、不立刻启动父会话；放宽单条 pending `merge_back` 限制，支持连续挂载多份子会话结论，仅由下一条新提交的父会话人工普通消息一次性绑定打包注入（只跑 1 轮，且区分 `pending → bound → delivered` 防未送达丢附件）。
    - [x] 回传验收场景：① 父会话运行中或等待审批时，L1-A、L1-B 依次点「交父会话处理」，两条回报幂等进入父会话消息队列按序处理且不重复触发委派唤醒；② 父会话已有排队消息时，L1-A、L1-B、L1-C 连续点 `Bring back` 均成功挂载且不被既有排队消息或自动 wake 抢走，人工发 1 条综合指令后一次性带入 3 份结论，并在接收前取消/接收后失败场景下正确恢复。
- [x] 演进为分层 AI 协调流程（与上方「多 Agent 协作页面」联动，详见 [设计规范](./docs/plans/unified-subtasks-and-hierarchical-coordination.md)）：支持根会话只做总控协调，按任务复杂度分层调度不同模型（如 L0 总控用最强模型、L1 负责人用 `neon`/`carbon`、L2 执行员工按需用 `hydrogen`）。
  - [x] 树形多 Agent 协作总览页（重点细化）：以 `L0 → L1 → L2` 树状结构集中呈现各层子会话的模型、状态、产物、阻塞原因、分层路径归因（计划修改 / 工具确认写入 / 工作树观察待核实）与根级 `Side Chat`，支持快速跳转与人工/AI 随时介入。
  - [x] 工作目录/工作树协作策略：默认共用父会话所在需求工作树（不同路径并行；若涉及重叠文件且影响可控，优先在同一工作树内按序协作——一个写完释放后再由另一个读取最新内容写入，并在协作页提示路径重叠）；开启独立 worktree 必须在服务端经人工明确审批确认，不允许 AI 擅自新开隔离工作树。
  - [x] L0 总控「协调者模式 / 角色模板」：提供可复用协调者设定，按当前可用模型动态配置，约束根会话默认专注任务拆解、分层派活、进度验收与最终收口，减少在主上下文里亲自执行底层琐碎操作。
- [x] 优化会话中引导消息（Steer）打断后的消息展示：被新消息打断产生的 `Superseded attempt`（`attempt-fold` /「因引导消息而中断」）默认保持展开，不再默认收起内容，同时保留被打断状态的清晰标识。
- [x] 支持主动让 AI 把任务添加到右侧任务列表（新增 `t3_task_list` MCP 工具与 `thread.todo-list.update` 编排命令，支持读取、新增、更新、替换与清空当前会话右侧 `ThreadTaskList`，补齐 Antigravity ACP 等无原生 `update_plan` 时的写入能力）。
- [ ] 品牌重塑与跨平台基建（暂定名 `T3 Zest`，`v0.1 首版 · P0`）：主打 Windows 一等公民体验与跨平台轻量演进，尽量不侵入上游 DB schema。
  - [ ] 完成 `T3 Zest` 品牌标识、图标与独立数据目录（`~/.t3-zest`，与官方 `~/.t3` 隔离共存）切换。
  - [ ] 打通 GitHub Actions 自动构建与发布 Windows（`.exe`/`.msi`）+ macOS（`.dmg`/`.zip`）双端安装包。
  - [ ] 精修 Windows 原生体验：标题栏/深色模式适配、PowerShell 与路径转义、中文输入法与剪贴板、系统通知（AUMID）。
- [x] 额度 Pace 刻度线与用量直达（已随上游 `#38789` 原生合入）：周限额 / 5 小时窗口进度条时间节奏刻度（Pace Indicator）与用量行点击跳转完整 Usage 页面已由上游实现。
- [ ] 内置 `Zest Dark / Light` 主题预设（`v0.1 首版 · P0`）：上游已具备主题系统与社区主题导入能力，后续仅补充高辨识度的默认 `Zest Dark / Light` 主题预设（深灰底 + 柑橘橙高亮）。
- [ ] 长会话压缩防失忆与会话续接（`v0.1 首版 · P0`）：采用 Prompt / Hook 轻耦合方案，降低上游合并冲突。
  - [ ] 为 Claude（`systemPrompt.append` + `PreCompact` Hook）与 Codex（`developer_instructions`）注入压缩保留清单，留存任务目标、硬约束、已改文件路径、进行中子代理 `taskId` 与下一步计划。
  - [ ] 增加压缩后 / 续接会话恢复提示（如 `SessionStart[compact]`），提醒先通过 `t3_thread_read` / `t3_thread_list` 检查在跑子任务，避免失忆后重复派发。
- [ ] 提速插件集成（`agy-fast` 模式，`v0.1 轻接入 / v0.2 深化 · P1`）：减少碎片化工具调用往返，压降耗时与 Token 消耗。
  - [ ] `v0.1`：在设置页提供加速 MCP 插件（首批支持 `agy-fast`）的状态检测、一键安装与开关，并提示批处理改文件可能跳过部分原生 Diff 卡片的取舍。
  - [ ] `v0.2`：探索面向 Claude / Codex 等多 Provider 的通用批处理工具与精简工作区快照开关。
- [ ] 多账号可观测性与全端生态补齐（`v0.2 ~ v0.3 · P2`）：
  - [ ] 多账号额度拆分卡片（同厂商不同登录账号独立计量与重置倒计时）与输入框底栏实时统计（轮次 / 耗时 / Token / 缓存命中率）。
  - [ ] 补齐 Linux（AppImage / `.deb`）桌面构建，持续打磨 iOS 端远程推送、Pace 额度与待处理任务展示。
  - [ ] 搭建 `zest.didyou.eat` 官网、下载页与社区主题画廊（支持一键复制 JSON）。

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** Source code is MIT licensed. If you don't like something, fork it under your own branding (see [Trademarks and forks](#trademarks-and-forks)).

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork the source code and build the tool that you want, under your own name and branding.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/00_development.md#first-checkout). The [architecture overview](./docs/internals/01_architecture.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Trademarks and forks

The MIT license applies **only to the source code**. It does not grant any rights to T3 Tools, Inc.'s trademarks, branding, or trade dress, including the **T3 Code** name, wordmark, logos, and application icons.

If you fork, redistribute, or build on T3 Code's source code:

- **Use your own branding.** Replace the T3 Code name, wordmark, logos, and application icons in any public fork, redistributed build, website, package, or app store listing.
- **Be explicitly clear that your project is unofficial.** Do not use the T3 Code name, wordmark, logo, or branding in your own projects without making it unmistakably clear that your project is unofficial and not affiliated with or endorsed by T3 Tools, Inc.

Using our name, wordmark, logo, or branding in a way that suggests official status or affiliation is trademark infringement and unlawful. **Any project indicating or implying that it is an official version of T3 Code when it is not will be pursued to the full extent of the law.**

See [TRADEMARK.md](./TRADEMARK.md) for the full trademark and branding policy.

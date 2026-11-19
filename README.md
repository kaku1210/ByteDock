<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code Plus</h1>

## T3 Code Plus TODO

- [ ] 优化侧栏分组与折叠体验：参考 Codex，复用已有项目分组、折叠状态记忆与状态提示。
  - [ ] 明确同一仓库的多个工作树、临时项目和远程项目的分组规则。
  - [ ] 优化项目置顶、最近活跃排序、会话查找与当前会话定位。
  - [ ] 优化折叠后的运行中、等待审批、失败和未读结果提示。
  - [ ] 检查并统一归档会话、导入历史与空项目的展示。
- [ ] 优化会话内模型切换与任务交接：复用已有模型选择、Provider 切换、上下文交接与子任务委派能力。
  - [ ] 区分本轮正在使用的模型与下一轮选择的模型，明确切换何时生效。
  - [ ] 明确运行中等待当前任务结束、停止后切换等操作的流程与影响。
  - [ ] 展示上下文从哪个模型交给哪个模型、采用原生续接还是历史传递，以及失败原因。
  - [ ] 完善会话内子任务交接入口：指定子任务和目标模型，查看进度与结果，并返回主任务。
  - [ ] 为模型不可用、登录失效和交接失败提供明确的处理入口。
- [ ] 完善多 Agent 协作页面：整合已有父子任务关系、子 Agent 状态与工作记录。
  - [ ] 提供任务总览，展示主任务、子任务、执行模型与当前状态。
  - [ ] 集中展示运行中、等待审批和失败任务的进度与阻塞原因。
  - [ ] 支持打开子会话、返回父会话，并按实际能力提供取消、继续等操作。
  - [ ] 汇总各 Agent 的结论、产物与修改文件。
  - [ ] 展示各任务使用的目录或工作树，帮助识别修改范围重叠。
- [ ] 支持在大会话中统一发起并维护子会话：对外统一为支持人 + AI 共同维护的任务树「子会话」（`createdBy` 仅作来源标识），与根级 `Side Chat` 解耦；底层按是否绑定父 Run 自动唤醒复用不同通道。
  - [ ] 划词或从会话一键「拆为子会话」：创建持久化子会话并打开视图，仅将选中段落预填到输入框草稿、不自动发送，由人工选模型并补充指令后手动发送。
  - [ ] 三层上下文策略：首轮发送时跳过重型原生 fork，懒注入父会话完整上下文的压缩摘要（MVP 先用受控预算的结构化骨架摘要，后续支持基于 `TextGeneration` 按 `(parentThreadId, sourceRunId)` 缓存的 LLM 语义压缩）并附带 `parentThreadId`，支持按需调用 `t3_thread_read` 回查原文。
  - [ ] `Side Chat` 根会话归属规则：同一大任务下的所有 `Side Chat` 统一隶属于根会话（`rootThreadId`），在根会话与任意子会话中均保留入口并共同查看/打开根会话的 `Side Chat`；`Side Chat` 本身不支持创建子会话或再嵌套 `Side Chat`。
  - [ ] 支持 `L0 → L1 → L2` 两层子会话矩阵（深度封顶 2 层防套娃）：人工可从 L0 开 L1，也可给人工 L1 与 AI L1 开出人工 L2；AI 可从 L0 委派 AI L1，也可从人工 L1 与 AI L1 向下委派 AI L2；L2 不再继续向下拆层。L1 过程中发现同级新需求时，不上套成 L2/L3，而是上报/提级到 L0 横向新建同级 L1（UI 同步提供「提级到根会话新建 L1」入口）。
  - [ ] 人 + AI 双维护闭环：子会话支持人工多轮交互与独立切模型，同时在父会话的 `t3_thread_list` 中暴露名下非临时子会话，使父会话 AI 可直接通过 `t3_thread_read` / `t3_thread_send` 盘点、汇总或接手推进。
  - [ ] 双模式回传与排队聚合：
    - [ ] 主动「回传并交父会话处理」：将子会话结论摘要与 `childThreadId` 引用组装为结构化消息直接发给父会话，复用父会话现有消息排队队列（空闲立刻开跑，父会话运行中自动按序排队消费，不触发 `merge_back` 忙时限制；同时兼容子会话 AI 通过 `t3_thread_send` 主动交棒）。
    - [ ] 被动 `Bring back`（`thread.merge_back` 多附件聚合池）：仅向父会话挂入待合并增量上下文、不立刻启动父会话；放宽单条 pending `merge_back` 限制，支持连续挂载多份子会话结论，等人工回到父会话发下一条消息时一次性打包注入并全部标为已消费（只跑 1 轮）。
    - [ ] 回传验收场景：① 父会话运行中，L1-A、L1-B 依次点「交父会话处理」，两条回报自动进入父会话消息队列，父会话忙完当前轮后按序处理、不报错；② 父会话空闲时，L1-A、L1-B、L1-C 连续点 `Bring back` 均成功挂载且不提前触发父会话，切回父会话发送 1 条综合指令后一次性带入 3 份结论并全部标记已消费，下一轮不再重复注入。
- [ ] 演进为分层 AI 协调流程（与上方「多 Agent 协作页面」联动，作为后续重点）：支持根会话只做总控协调，按任务复杂度分层调度不同模型（如 L0 总控用最强模型、L1 负责人用 `neon`/`carbon`、L2 执行员工按需用 `hydrogen`）。
  - [ ] 树形多 Agent 协作总览页（重点细化）：以 `L0 → L1 → L2` 树状结构集中呈现各层子会话的模型、状态、产物、阻塞原因、实际修改路径与根级 `Side Chat`，支持快速跳转与人工/AI 随时介入。
  - [ ] 工作目录/工作树协作策略：默认共用父会话所在需求工作树（不同路径并行；若涉及重叠文件且影响可控，优先在同一工作树内按序协作——一个写完释放后再由另一个读取最新内容写入，并在协作页提示路径重叠）；开启独立 worktree 必须由人工明确确认，不允许 AI 擅自新开隔离工作树。
  - [ ] L0 总控「协调者模式 / 角色模板」：提供可复用协调者设定，约束根会话默认专注任务拆解、分层派活、进度验收与最终收口，减少在主上下文里亲自执行底层琐碎操作。

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
- **Open.** MIT licensed. If you don't like something, fork it.

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

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

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
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)

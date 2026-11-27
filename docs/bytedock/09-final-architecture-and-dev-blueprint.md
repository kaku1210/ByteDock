# 09 · ByteDock 终版架构与开发设计流程（R4 · Fable 5.2 · 研发执行蓝图）

> **文档定位**：面向工程团队与 AI Coding Agent 的**零歧义施工总手册**。本文档一次性整合 R1/R2/R3 + Opus 5.5 基准四轮评审的全部封板结论、12/12 锁定 ADR、5 份核心契约与 `t3code` 真实源码锚点，可直接按章拆解为 Git Issue / Sprint 卡片，指导 Week 1 Day 1 动工。
>
> **生成方式**：单轮冷启动纯文本生成（0 工具调用），全部结论锚定 `07-redteam-review-synthesis-and-adrs.md` 与内嵌真实源码切片；与 `01/03/04/05/07` 封板裁决逐条对齐，无任何新增架构裁决（若发现需新裁决，触发 R3 文末 No-Go 条款回炉，不在本文档内自行拍板）。
>
> **全篇三大硬不变量（任何章节、任何任务卡、任何代码注释都不得与之矛盾）：**

| 不变量                  | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 校验位置               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **V1 时间窗口**         | `v0.1-lite` = **4–8 周**（完整 v0.1 = 8–10 周）；Dockview / `plugin-usage-hub` / 延迟接缝 9、12、13、14 归 **v0.2**；第三方 `trusted-worker` 子进程轨 / Mobile 轨 / 30+ 社区 Provider 归 **v0.3**；`plugin-colab-gpu` 为 P2 侧挂实验件                                                                                                                                                                                                             | 第 1 章 §1.3 / 第 9 章 |
| **V2 薄接缝**           | `v0.1-lite` **精确必切 12 处（16 文件，~585 行宿主 diff）**，双 tag 机械守卫（`// bytedock-seam:<id>` 块 + `// bytedock-seam-import:<id>` 行注释）+ `seam-ledger.json` + `scripts/check-seams.ts`；`ServerSettings` **零触碰**                                                                                                                                                                                                                     | 第 4 章                |
| **V3 UI 原语 + 热重载** | 原语**严格锁死 12 个**（`Stack / Row / Card(含封闭 kpi 块) / Text(仅 i18nKey) / Badge / Tabs / Button / Toggle / Select / Progress / StreamLog / TerminalView`），渲染组件宿主化于 `apps/web/src/components/plugin/`（Tailwind 零改动）；热重载**唯一方案 α**：单文件 CJS + `vm.compileFunction` + 宿主内存 `HostModuleRegistry` 注入虚拟 `require`，**严禁** `worker_thread`、宿主 ESM `?rev=N`、外置 `effect` 进 `CLI_RUNTIME_EXTERNAL_PREFIXES` | 第 3/6/7 章            |

**上游冲突风险三档定义（全文统一）**：`auto` = 上游同构区追加，`git cherry-pick` 冲突即机械合并；`manual` = 触及函数体锚点（接缝 5/6/7/8），上游改动即触发人工评审，台账 `driftThresholdPct` 收紧（3% vs 默认 8%）。

---

## 第 1 章 · 总览、品牌独立边界与版本演进策略

### 1.1 品牌独立与去 T3 化边界（Milestone 0 前置项，Week 1 完成）

| 资产项         | ByteDock 终值                                                                                     | 备注                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 产品显示名     | `ByteDock`                                                                                        | 全网 AI 编程赛道 0 撞车（2026-11-26 实测）                                    |
| 官网 / 宣传站  | `https://byte.didyou.eat`                                                                         | 与 `share.didyou.eat` 家族统一                                                |
| npm 裸包 / CLI | `bytedock`（`npx bytedock`）                                                                      | 实测空闲，Week 1 占位                                                         |
| npm Scope      | `@bytedock/*`                                                                                     | 内部 monorepo 包与 SDK                                                        |
| GitHub 组织    | `bytedock-dev/bytedock`                                                                           | 实测 404 空闲                                                                 |
| 本地数据目录   | `~/.bytedock/`（含 `plugins/`、`plugins.yml`、`plugins-data/<pluginId>.sqlite`、`audit/*.jsonl`） | 与 `~/.t3` / `~/.t3-plus` 完全隔离，一次性只读导入向导不改写 `~/.t3/userdata` |
| 插件清单       | `bytedock-plugin.json`                                                                            | 强 Effect Schema 校验 + 4 级权限                                              |
| 工作区配方     | `bytedock.recipe.yaml`（项目根 `.bytedock/`，v0.3 分享）                                          | —                                                                             |
| Windows AUMID  | `dev.bytedock.desktop`                                                                            | 独立通知 / 安装目录 / 更新源 / Defender 排除项                                |
| 视觉基因       | 深灰底 + 柑橘橙 `#f97316` 高亮（`ByteDock Dark/Light`）                                           | 彻底区分官方黑白与 Docker 蓝                                                  |

**商标合规门禁（进 CI 禁遥测/品牌门禁同一批）**：完全去除 `T3` 前缀与官方 Logo；README 声明「独立开源项目，基于 MIT 协议源码演进，与 T3 Tools, Inc. 无隶属关系」；协议头 `t3://` → `bytedock://`；自动更新源 / Release 仓库 / Linux 安装脚本全指向 `ByteDock` 自有基础设施；CI 静态检测禁止上游移植带回 PostHog / Sentry / Clerk 商业追踪或未授权读取外部 CLI 认证文件（与 R3 靶心 3「D 类零遥测门禁前置 Stage 1」共享同一份禁用域名字段真源 `scripts/egress-denied-domains.json`）。

### 1.2 分层总架构图（上游同构保护区 vs 自主区）

```text
                                ┌────────────────────────────────────────────────────┐
                                │                 ByteDock 宿主进程（Electron 主 /  │
                                │  CLI / vp pack / Node SEA，四形态单例一致）       │
                                │                                                  │
                                │  ┌──────────── 上游同构保护区（Thin-Seam Core） ──────┐ │
   Web 壳层                    │  │ apps/server/src/orchestration-v2/（状态机/投影）     │ │
   apps/web ──WS RPC─────────► │  │ apps/server/src/ws.ts（278 Rpc.make 闭合组）        │◄─┼── 12 处薄接缝（// bytedock-seam:<id>）
   （4 个 v0.1 Slot +          │  │ packages/client-runtime / apps/mobile（v0.1 只读）  │  │   16 文件 ~585 行，双 tag + ledger 机械守卫
    12 原语渲染器 +            │  │ apps/server/src/mcp/McpHttpServer.ts（17 Toolkit） │◄─┘
    StreamLog ring）          │  │ apps/server/src/persistence/Migrations.ts（#126 末位）│
   宿主机渲染 12 原语         │  └──────────────────────────────────────────────────────┘
   apps/web/src/components/
    plugin/                   │  ┌──────────── 完全自主区（Sovereign Plugin Zone） ─────┐
        ▲                     │  │ packages/plugin-sdk（契约/Manifest/12 原语 Schema） │
        │ JSON 节点树+chunk   │  │ packages/plugin-kernel（Scope 轨/Revision/热重载     │
        │（低频 ≤15Hz）       │  │   编译器/HostModuleRegistry/EgressGuard/ConfigSvc） │
        │                     │  │ packages/plugin-ui-renderer（仅协议+Schema+iframe 桥）│
        │  高频流走宿主       │  │ plugins/*（4 个第一方内置，编译期可打包+开发态热重载）│
        │  ring buffer(4096)  │  │ ~/.bytedock/plugins/*（用户安装，v0.3 第三方子进程轨）│
   轨 2 重交互画布            │  └──────────────────────────────────────────────────────┘
   PluginSandboxFrame.tsx ◄───┼──► PluginKernel 单例（Context.Tag 注入，四形态同一）
   （sandbox="allow-scripts"， │
    回包定向 "null"，          │  Egress Guard L1（宿主 JS 层 100%：undici 双闸 +
    四条件 nonce 握手）        │  双层 DNS + UDP 拒 + Chromium setProxy）
        │                     │  ┌ 出站白名单 ───────────────────────┐
        ▼                     │  │ L2 loopback 代理 + NODE_USE_ENV_PROXY │
   隔离 iframe（Canvas/看板/  │  │ （子进程 CLI 全审计，封锁 best-effort）│
   2D 工厂，v0.2 主力）       │  │ L3 OS 防火墙硬模式（opt-in）          │
                              │  └────────────────────────────────────┘
   Desktop（Electron 44）    │
   apps/desktop ──IPC 冻结──►│  （v0.2 接缝 13 PluginDesktopCapability；v0.1 零改动）
   移动端（v0.1 只读 outbox）│
                              └────────────────────────────────────────────────────┘
        ▲
        │ HTTP webhook（auth:"token" + raw-body HMAC + 50/min 限速 + X-Frame-Options:DENY）
        │
   NapCatQQ（OneBot v11，loopback 127.0.0.1，出站进 Egress L1 loopback 全审计）
   飞书/钉钉/企微/Telegram/GitHub 通道 = v0.2 第一方插件（manifest 抄 NapCat 安全样板）
```

**信任边界三条铁律**：① 插件永远拿不到 `ServerSettings` 写权与 `EventSink` 事务（配置走 `plugins.yml` 单写者 CAS + `plugin_kv`，重数据走 `isolated-sqlite` 独立连接）；② v0.1 无 `caller.kind:"plugin"` 存在（禁插件互调，横向面源头切除）；③ 出站路径唯一合法出口 = Egress Guard 双闸链，`EgressProof` 双段自证 + hash-chained 审计日志是信任牌本体。

### 1.3 12/12 锁定 ADR 终态速查表（R3 后全绿，本文档逐条继承）

| ADR | 议题                                                                                                                                                                                           | 终态 | 本文档落点   |
| :-: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--: | ------------ |
| 01  | 保护区/自主区 + 接缝台账                                                                                                                                                                       |  ✅  | 第 1/4 章    |
| 02  | 双轨：同契约、非同构（v0.1/v0.2 仅同进程 `CloseableScope`；子进程轨 v0.3 走可序列化 `PluginWorkerBridge`）                                                                                     |  ✅  | 第 3 章 §3.3 |
| 03  | Revision Pinning（`frozenAt` 锚点 + 三段回收）                                                                                                                                                 |  ✅  | 第 3 章 §3.1 |
| 04  | 热重载驱逐 = 单文件 CJS + `vm.compileFunction` + `HostModuleRegistry` 宿主内存注入 + ~35 条 `effect/*` 编译期白名单 + 最小 `node:*` 集 + boot `Context.Tag` 单例探针（β/`worker_thread` 双死） |  ✅  | 第 3 章 §3.2 |
| 05  | 四格存储硬边界（`plugins.yml` CAS / `plugin_kv` ≤64KB·32MB / `isolated-sqlite` / JSONL hash-chained 三态轮转）                                                                                 |  ✅  | 第 7 章      |
| 06  | CacheGuard 六铁律双轨（`AdapterCacheProfile` 路由 + `profileKey` 5 位 hash + `ProfileShiftEvent` + `outboundUserText` 双字段 + per-`providerSessionId` `list_changed` + X-Ray 三态铁律⑥）      |  ✅  | 第 3 章 §3.4 |
| 07  | Egress 三级口径 + Dispatcher 双闸 + 双层 DNS/SSRF + 双段 `EgressProof` + 三句诚实措辞                                                                                                          |  ✅  | 第 5 章      |
| 08  | v0.1 禁插件互调 + `PluginSandboxFrame`（移除 `allow-forms` + 回包 `"null"` + pending 队列 + 四条件 nonce） + webhook 逐路由鉴权 + 五要素审计                                                   |  ✅  | 第 3/6 章    |
| 09  | 12 原语封闭 `switch` 宿主化 + `gt` ignore + `knip` 4 workspace + `StreamLog` 三段背压                                                                                                          |  ✅  | 第 2/6 章    |
| 10  | 共享 5 原语数据模型（Thread/TaskTree/Milestone 唯一真相源 + `DockTask`/`DecisionGate`）                                                                                                        |  ✅  | 第 8 章      |
| 11  | `registerDriver` v0.3 前仅第一方 + 上游 `cherry-pick` / `idea-sync`（只同步思路 AI 重写）双轨 + 双 tag 柔性守卫 + `normalized-diff%` 周报                                                      |  ✅  | 第 4/8 章    |
| 12  | v0.1-lite 切口：12 必切接缝 + NapCatQQ Bot 闭环爆点 + Dockview 整段移 v0.2（`dockPanel` 容器接口 v0.1 定型零返工）                                                                             |  ✅  | 第 4/8/9 章  |

### 1.4 版本演进边界与「绝不提前做」清单（V1 不变量的执行面）

**v0.1-lite（4–8 周，本文档第 9 章 Week 1–8 计划本体）交付物**：品牌独立 + 插件底座 v0（内核/SDK/四格存储/Broker 禁互调）+ 12 处必切接缝 + 4 个第一方插件（`egress-guard` / `token-optimizer` / `bots-core` + `channel-napcat-qq` / `upstream-radar`）+ 无泄漏热重载 MVP + Windows/macOS 桌面发布 + `byte.didyou.eat` 公测。

**绝不提前做（提前 = 违反 V1/V2/V3，CI 红灯 + 评审 No-Go）**：

| 事项                                                                         | 归属版本 | 提前做的代价                                                                                          |
| ---------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Dockview 分屏壳 / 顶栏多会话标签                                             | v0.2     | 破坏「A/B 类上游移植流水线先跑通一轮」前置；v0.1 只定型 `dockPanel` 容器接口（挂现有右栏多 Tab）      |
| `plugin-usage-hub`（接缝 9 额度段）                                          | v0.2     | `UsageLimitSources` ~20 行宿主 diff 白切；`UsageLimitSources` 闭合枚举双变体扩容归 v0.3 接缝 9 引擎段 |
| 接缝 12（client-runtime 订阅续传）/ 13（Desktop IPC 白名单）/ 14（命令面板） | v0.2     | 各 25–45 行宿主 diff，v0.1 无消费方；Mobile 实时写同步随接缝 12                                       |
| 接缝 11 三个延迟子项（`composerItem` / `sidebarView` / `composerBanner`）    | v0.2     | v0.1 只切 4 Slot（`dockPanel` / `timelineRenderer` / `statusBarItem` / `settingsSection`）            |
| `registerDriver` 第三方可用（`ProviderDriverKind` 闭合枚举双变体 +80 行）    | v0.3     | 唯一改闭合枚举的硬骨头，v0.1 零消费不切；v0.3 配合回放夹具 CI 门禁开放                                |
| 第三方 `trusted-worker` 子进程轨（`PluginRemoteContext` JSON 帧）            | v0.3     | v0.1/v0.2 同进程轨已验证全部钩子语义；子进程轨 = 同一份 `PluginWorkerBridge` 可序列化契约换传输       |
| Mobile 原生 12 原语渲染（`plugin-ui-renderer/mobile` RN 实现）               | v0.3     | 全端同 UI 的 RN 侧样式管线；v0.1 Mobile 仅经 outbox 只读当前配置（ADR-12）                            |
| 30+ 社区 Provider 插件 + ACP 16 项扩展                                       | v0.3     | `registerDriver` 门禁未开                                                                             |
| `plugin-colab-gpu`（5 工具 MCP + 计时 PiP 胶囊）                             | P2 侧挂  | 明确定位实验件，不进 v0.1/v0.2 主线                                                                   |
| Creator Mode（`bytedock plugin dev --check --shot` AI 自验证闭环）           | v0.3     | 依赖子进程轨与 Decision 确认卡                                                                        |

---

## 第 2 章 · Monorepo 包拓扑、宿主化构建与 CI 一次过配置终稿

### 2.1 完整目录树（新增项标 ★，宿主既有项不动）

```text
t3code/（仓库本体，ByteDock fork 演进）
├─ packages/
│  ├─ plugin-sdk/ ★ @bytedock/plugin-sdk（纯契约，零运行时依赖）
│  │  ├─ src/manifest.ts        # ByteDockPluginManifest + 4 级 execution + 7 钩子 + 4 级权限 Schema
│  │  ├─ src/bridge.ts          # §3.3：可序列化 RPC/Stream/Hook 契约 + PluginScopeBroker
│  │  ├─ src/cacheGuard.ts      # §3.4：双轨 CacheGuard 全部契约类型
│  │  ├─ src/server.ts          # PluginServerContext（hooks/events/rpc/mcp/http/providers/usage/vcs/channels/storage/notifications/orchestration）
│  │  ├─ src/client.tsx         # defineClientPlugin + 12 原语 TSX 出口（转译后产出 JSON 节点树）
│  │  └─ locale/*.json          # 插件 i18n 运行时合并源（gt 构建期提取的禁区）
│  ├─ plugin-kernel/ ★ @bytedock/plugin-kernel（宿主运行时，被 apps/server 静态 import）
│  │  ├─ src/revision.ts        # §3.1：Revision Pinning 状态机
│  │  ├─ src/sessionGate.ts     # §3.1b：ThreadSessionGate 5 态转换
│  │  ├─ src/hostModules.ts     # §3.2：方案 α HostModuleRegistry + vm.compileFunction 装载器
│  │  ├─ src/compiler.ts        # esbuild/Sucrase 双转译 + onResolve 白名单拒载 + fork 子进程管理
│  │  ├─ src/configService.ts   # §7.2：plugins.yml 单写者 lane + mtime CAS + 三通道推送
│  │  ├─ src/broker.ts          # PluginScopeBroker 实现 + 五要素审计 JSONL writer
│  │  ├─ src/egressGuard.ts     # §5：GuardDispatcher 双闸 + 双层 DNS + UDP 拒 + EgressProof runner
│  │  ├─ src/storage.ts         # §7.1：四格存储（plugin_kv 池 / isolated-sqlite / JSONL 轮转）
│  │  └─ src/layer.ts           # PluginKernel.layer（Context.Tag 全部入口，接缝 4 静态挂载点）
│  ├─ plugin-ui-renderer/ ★ @bytedock/plugin-ui-renderer（仅协议 + Schema + iframe 桥）
│  │  ├─ src/protocol.ts        # §3.5：12 原语封闭 Schema + StreamLog 三段背压 + AtomSpec
│  │  └─ src/sandboxBridge.ts   # 轨 2 引导桥协议（nonce 四条件 / pending 队列消息类型封闭枚举）
│  └─ shared/ contracts/       # 既有：接缝 1/3 的改动落点（rpc.ts / environment.ts）
├─ apps/
│  ├─ web/src/components/plugin/ ★ 宿主化 12 原语渲染器（ADR-09：Tailwind 零配置）
│  │  ├─ PluginNodeRenderer.tsx # 封闭 12 分支 switch（JSON 节点树 → 宿主组件）
│  │  ├─ primitives/           # 12 个宿主组件（Stack/Row/Card+KpiBlock/Text/Badge/Tabs/
│  │  │                        #  Button/Toggle/Select/Progress/StreamLog/TerminalView）
│  │  ├─ StreamLogHost.ts      # rAF 16ms 合并 + 4096 ring buffer + tail-follow 哨兵行
│  │  ├─ PluginSandboxFrame.tsx# §6.2：轨 2 沙箱（基座 HtmlSandboxFrameBase 抽自 BrowserDocumentFrame）
│  │  └─ HtmlSandboxFrameBase.tsx（BrowserDocumentFrame 重构后共享基座）
│  ├─ server/                  # 接缝 2/4/5/6/7/8/10/15/16 落点（§4 手术卡）
│  └─ desktop/                 # v0.1 零改动（session.setProxy 经 Egress Guard 宿主能力调用，接缝 13 归 v0.2）
├─ plugins/ ★ 第一方内置插件（编译期可打包 + 开发态同协议热重载）
│  ├─ plugin-egress-guard/     # §8.1：bytedock-plugin.json + shared/ + server/ + client/
│  ├─ plugin-token-optimizer/  # §8.2
│  ├─ plugin-bots-core/        # §8.3a
│  ├─ channel-napcat-qq/       # §8.3b（含完整安全样板 Manifest）
│  └─ plugin-upstream-radar/   # §8.4（0 号自举）
├─ scripts/
│  ├─ check-seams.ts ★         # §4.3：双 tag 机械守卫（vp run check:seams → 并入 check:changed）
│  └─ egress-denied-domains.json ★ # D 类零遥测门禁 + Egress L1 共用禁用域名字段真源
├─ seam-ledger.json ★          # §4.3：12 接缝机读台账
└─ 既有 CI（vp / pnpm check:changed）：check:seams 并入变更集门禁
```

### 2.2 直接可复制落盘的配置终稿

**① `pnpm-workspace.yaml` 增量**（仅追加 4 项，依赖边界：`plugin-sdk` 零依赖；`plugin-kernel` 仅依赖宿主既有 `effect@4.1.5` + `undici` + `@parcel/watcher` + `esbuild` + `sucrase`；`plugin-ui-renderer` 零依赖；`plugins/*` 只准 import `@bytedock/plugin-sdk` 与宿主白名单，由 esbuild `onResolve` 编译期强制）：

```yaml
packages:
  # ... 既有条目不动 ...
  - "packages/plugin-sdk"
  - "packages/plugin-kernel"
  - "packages/plugin-ui-renderer"
  - "plugins/*"
```

**② `apps/web/gt.config.json` 显式 ignore 终稿**（R3 靶心 5.1：插件 i18n 走随包 `locale/*.json` 运行时合并，`<Text>` 仅许 `i18nKey`；显式 ignore 让「插件代码混进 i18n 提取」从「恰好没配」变「机器保证没有」）：

```jsonc
{
  "defaultLocale": "en",
  "locales": ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "sv", "zh"],
  "src": [
    "src/**/*.{ts,tsx}",
    "../../packages/client-runtime/src/**/*.{ts,tsx}",
    "../../packages/shared/src/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
  ],
  // ★ ByteDock：显式排除全部插件与内核包源码（未来 workspace 扩包不会意外进 src glob）
  "ignore": ["../../packages/plugin-*/src/**/*.{ts,tsx}", "../../plugins/**/*.{ts,tsx}"],
  "files": { "gt": { "output": "src/i18n/translations/[locale].json" } },
}
```

**③ `knip.jsonc` 4 个新 workspace 片段 + `knip-schemas.test.ts` 断言补丁**（R3 靶心 5.3：kernel 的「谁 import」由 `apps/server` entry 闭包解决——**前提接缝 4 已切，这是 Week 1–2 切 1/2/3/4/10/15/16 先于 knip 全量的原因**；`apps/server.ignoreDependencies` 不动，`effect` 保持内联 + `@effect/platform-node-shared` 既有条目原样）：

```jsonc
// knip.jsonc "workspaces" 增量：
"packages/plugin-sdk": { "project": ["src/**/*.ts"] },
"packages/plugin-kernel": { "project": ["src/**/*.ts"] },
"packages/plugin-ui-renderer": { "project": ["src/**/*.ts"] },
"plugins": {
  "project": ["*/**/*.ts", "!*/**/*.test.ts", "*/bytedock-plugin.json"],
  "ignore": ["plugins/*/dist/**"]
}
```

```ts
// scripts/knip-schemas.test.ts 断言补丁（一行测试改动，随本周 PR 进）：
const ALLOWED_WORKSPACES = new Set([
  ".",
  "evals",
  "scripts" /* ... 既有条目 ... */,
  "packages/plugin-sdk",
  "packages/plugin-kernel",
  "packages/plugin-ui-renderer",
  "plugins",
]);
expect(Object.keys(config.workspaces)).toEqual(
  Object.keys(config.workspaces).filter((w) => ALLOWED_WORKSPACES.has(w)),
);
```

**④ `apps/server/vite.config.ts` 与 Electron 44 打包注意事项**（R3 靶心 0 事实核验 + R1 C7 三条 Windows 铁律，全部「零改动确认」项 + 一条新增 unpack 项）：

| 项                       | 终态                                                                                                                                               | 说明                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect` 内联            | **保持 `shouldBundleCliDependency` 现状，不加 `CLI_RUNTIME_EXTERNAL_PREFIXES`**                                                                    | `vp pack` 的 `dist/bin.mjs`/`binMain.mjs` 内联 effect 全量；方案 α 依赖宿主 bundle 里那份内存单例（§3.2）。任何 PR 把 `effect`/`@effect/*` 加进外置名单 = R3 靶心 0 β 复活，评审 No-Go |
| `ESBUILD_BINARY_PATH`    | Electron 打包指向 `app.asar.unpacked/node_modules/esbuild/bin/esbuild`                                                                             | 打包后 `spawn` 否则 `ENOTDIR`（铁律 2）                                                                                                                                                |
| `@parcel/watcher`        | `asarUnpack` 其 `win32-x64` 二进制；dev 热重载目录用 `os.homedir()` 拼接（避开 OneDrive/环境变量重定向）；**明确不支持 WSL 路径/网络盘**（铁律 6） | 宿主 `@parcel/watcher` 是唯一 dev 监听源                                                                                                                                               |
| `ELECTRON_RUN_AS_NODE=1` | `fork` 编译子进程与子进程轨（v0.3）拉起时设置；**`fork` 仅加载已编译 CJS 产物，绝不 fork `.ts/.tsx` 源码**（铁律 7）                               | 独立 `fork` esbuild 空闲 1–5s 自退，防 `worker_thread` 僵尸（铁律 1）                                                                                                                  |
| Windows Defender         | dev 模式首次启动一次性 UAC 前置引导添加 `~/.bytedock` 排除项；添加失败不阻塞启动，热重载延迟 1–3s 可容忍                                           | 退避重试：Defender 实时扫描导致的 `EBUSY`/`EPERM`（临时文件 rename）按 200/400/800ms 三次退避后标 `stale-write` 告警而非崩溃                                                           |

**CI 一次过清单（`check:changed` 变更集，全部既有门禁 + 3 条新增）**：`vp run typecheck` / `vp run lint` / `vp run test:changed` / `vp run check:knip`（含 §③ 新 workspace 与 schema 断言）/ `vp run check:seams`（§4.3）/ 禁遥测静态检测（`scripts/egress-denied-domains.json` 命中即红灯）/ React Compiler 100% 覆盖 / Tailwind v4 静态扫描（**零新 `@source`**，渲染器宿主化后类名全在宿主扫描域）。

---

## 第 3 章 · 内核五大核心契约终稿（Effect 4.1.5 风格，R3 全部补丁已整合）

> 五份契约 = ① `revision.ts` + `sessionGate.ts` ② `hostModules.ts` ③ `bridge.ts` ④ `cacheGuard.ts` ⑤ `protocol.ts`。以下代码为「可直接建文件编译」终稿：Effect 4.1.5 API、`Data` 不可变值对象、`Context.Tag` 服务、`Layer` 生命周期，错误域全部 `Data.TaggedError`。行内 `// R3:` 注释标注 R3 修补点。

### 3.1 `packages/plugin-kernel/src/revision.ts`（Revision Pinning 完整生命周期）

```ts
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Scope from "effect/Scope";
import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";

export type RevisionState = "loading" | "active" | "draining" | "evicted" | "closed";

export interface PluginRevision {
  readonly rev: number;
  readonly scope: Scope.CloseableScope; // 本修订全部插件 Scope 的根（LIFO close）
  readonly manifests: ReadonlyArray<ByteDockPluginManifest>;
  readonly state: RevisionState;
  readonly frozen: boolean; // true 后拒绝新 pin（新会话一律钉 active）
  readonly installedAt: number; // epoch ms
  // R3 靶心 1.1：drainDeadline/forceReapAt 锚点从 installedAt 改为 frozenAt（仅 frozen 时赋值，active 恒 undefined）
  readonly frozenAt: number | undefined;
  readonly drainDeadline: number | undefined; // = frozenAt + graceMs；refCount→0 进 draining 时复检 refCount
  readonly forceReapAt: number | undefined; // = frozenAt + forceReapMs，单调钟硬上限
  readonly refCount: () => number;
}

/** 单调寿命 pin（R3 靶心 1.4：expires_at 从墙钟改单调寿命，免疫休眠 8h 唤醒误杀） */
export interface PinRecord {
  readonly sessionId: string;
  readonly rev: number;
  readonly pinnedAt: number;
  readonly graceRemainingMs: number; // 单调寿命剩余（plugin_kv ns=pin 落盘列）
  readonly wallAtLastCalib: number; // 最近一次单调校准的墙钟时间
  readonly state: "live" | "idle-detached" | "stale-revision";
}

/** R3 靶心 1.3：forceReap 强切在途工具后，turn 状态机的精确终态信号 */
export interface ProviderSessionLost {
  readonly reason: "revision-evicted" | "idle-detached-expired";
  readonly revision: number;
  readonly inFlightAtEvict: ReadonlyArray<{
    readonly toolName: string;
    readonly attemptId: string;
  }>;
}

/** R3 靶心 1.2：per-thread 串行门，openSession / runTurn / reOpen / unpin 全临界区化 */
export interface ThreadSessionGate {
  readonly withGate: <A, E, R>(f: () => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class SubpathNotWhitelisted extends Data.TaggedError("SubpathNotWhitelisted")<
  SubpathNotWhitelisted,
  {
    readonly subpath: string;
    readonly file: string;
    readonly line: number;
    readonly column: number;
  }
> {}
export class CompileError_ extends Data.TaggedError("CompileError")<
  CompileError_,
  {
    readonly pluginId: string;
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly message: string;
    readonly reason?: "SubpathNotWhitelisted" | "Syntax" | "BoundaryViolation";
  }
> {}
export class ManifestError extends Data.TaggedError("ManifestError")<
  ManifestError,
  {
    readonly pluginId: string;
    readonly reason: string;
  }
> {}
export class BootError extends Data.TaggedError("BootError")<
  BootError,
  {
    readonly pluginId: string;
    readonly cause: unknown;
  }
> {}
export class SingletonSplitError extends Data.TaggedError("SingletonSplitError")<
  SingletonSplitError,
  {
    readonly pluginId: string;
    readonly detail: string;
  }
> {}
export class EsmTlaRejected extends Data.TaggedError("EsmTlaRejected")<
  EsmTlaRejected,
  {
    readonly pluginId: string;
    readonly dependency: string;
  }
> {}
export type ReloadFailure =
  | CompileError_
  | ManifestError
  | BootError
  | SingletonSplitError
  | EsmTlaRejected;

export interface PluginKernel {
  readonly active: () => Effect.Effect<PluginRevision>;
  readonly stateOf: (rev: number) => Effect.Effect<RevisionState>;
  readonly pin: (sessionId: string) => Effect.Effect<number>; // 写 plugin_kv ns=pin（单调寿命）
  readonly unpin: (sessionId: string, reason: "closed" | "idle-detach") => Effect.Effect<void>;
  readonly reload: (opts?: {
    readonly force?: boolean;
  }) => Effect.Effect<PluginRevision, ReloadFailure>;
  readonly revisions: () => Effect.Effect<ReadonlyArray<PluginRevision>>;
}

export interface RevisionPolicy {
  readonly graceMs: number; // 默认 30_000：refCount→0 后排空窗口（锚 frozenAt）
  readonly drainInFlightMs: number; // R3 默认 15_000（可配 5–60s）：forceReap 前等待在途 MCP fiber 自然结束，
  // 超时强切 → 每个被强切 fiber 记 EvictedInFlightEvent 入审计 + 置 aborted-revision-evicted
  readonly idleDetachMs: number; // 默认 30min（可配 5min–24h）：僵死 Tab 的 pin 自动脱落
  readonly forceReapMs: number; // 默认 24h（硬上限 72h）：frozen 修订无视 refCount 的回收上限
  readonly coalesceMs: number; // 默认 500：watcher 保存风暴 debounce 合并窗口
  /** R3 靶心 1.4 联动公式（kernel 启动期纯函数计算并 assert）：
   *  maxTouchInterval = min(10min, forceReapMs / 4)
   *  touchThreshold   = max(25%, forceReapMs / maxTouchInterval * 0.5)
   *  forceReapMs=5min → touch 上限 75s、阈值 50%；forceReapMs=24h → 退化为 10min/25%（行为不变） */
  readonly touch: { readonly maxIntervalMs: number; readonly thresholdPct: number };
}

/** R3 不变量 I1–I5（kernel 内部 assert + 第 10 章 fuzz 靶心 1）：
 *  I1 至多一个 state === "active" 修订；
 *  I2 frozen === true ⇒ 拒绝任何新 pin，且终将 draining → evicted → closed；
 *  I3 R3 加固：evict(rev) ⇔ (state === "draining" ∧ refCount === 0 ∧ now >= drainDeadline)
 *        ∨ (state === "frozen-due" ∧ now >= forceReapAt)
 *      —— "frozen-due" = 已 frozen 且 refCount→0 复检连续失败 >3 轮的中间态；active 修订永不被 forceReapAt 误伤；
 *  I4 evicted/closed 修订从 ModuleRegistry<rev> 摘除且 Scope.close(LIFO) 完成，
 *      WeakRef(旧 registry 条目).deref() === undefined（§3.2 装载序列第 5 步机验）；
 *  I5 forceReap 殃及的会话：pin 行 state="stale-revision" 落盘（崩溃重启对账可读），
 *      后续动作返回 ProviderSessionLost("revision-evicted")（含 inFlightAtEvict），在途 run 置
 *      aborted-revision-evicted，禁止停留 running。 */
export declare const PluginKernel: Context.Tag<PluginKernel, PluginKernel>;
```

### 3.1b `packages/plugin-kernel/src/sessionGate.ts`（ThreadSessionGate 精确 5 态转换表，R3 封板）

```ts
/** 每 threadId 一个 Semaphore(1)：openSession / runTurn / reOpen / unpin 全临界区化。
 *  关键不变量：refCount++/-- 与 pin 行状态迁移必须在 withGate 临界区内原子完成
 *  （R2 复检制要盖住的「复检窗口恰好 re-pin」洞，gate 使其结构性不可能）。 */

/** 态转换表（实现者照抄，禁止自由发挥）：
 *  live@revN ──turn 结束 + idle idleDetachMs──► idle-detached@revN
 *      （unpin、refCount--、pin 行 state="idle-detached" 落盘、turn 队列不丢）
 *  idle-detached@revN ──新 turn 到达──► opening
 *      （withGate 内：re-pin active（拒 frozen/draining）→ 复跑 agent.open.before → adapter.openSession）
 *  opening ──同毫秒第二个 turn──► opening（同 thread gate 串行排队，绝不并发 open）
 *  live@revN ──forceReap 到期──► stale-revision
 *      （先有界 drain drainInFlightMs → 强切写审计 → run 置 aborted-revision-evicted，ProviderSessionLost 携 inFlightAtEvict）
 *  idle-detached ──恢复时 active 已换新 rev 且旧 rev frozen──► opening@newRev
 *      （前缀重置一次，X-Ray 记 "resume re-pin"，非 violation）
 *  唤醒校准（R3 靶心 1.4）：宿主检测到系统休眠唤醒（powerMonitor / uv tick 跳变 > 5min），
 *      对每条存活会话 pin 立即无条件 touch 一次（该次不计 maxIntervalMs 节流）；
 *      graceRemainingMs 为负者「恢复」而非标 stale；标 stale 唯一合法入口 = forceReapAt 到期（单调钟 + 唤醒校准）。
 *  每日对账 job（接缝 15 托管）：会话活跃但 pin 缺失 → 补写 pin + 记 pin-repaired 审计行（双向自愈）。 */
export declare const ThreadSessionGate: Context.Tag<ThreadSessionGate, ThreadSessionGate>;
```

### 3.2 `packages/plugin-kernel/src/hostModules.ts`（方案 α 完整实现契约，R3 0 号核弹终裁）

```ts
import * as Context from "effect/Context";

/** R3 0.2①：白名单 = 宿主 apps/server 已静态导入的内存单例字符串表（~35 条，纯静态数据，零 bundle 增量）。
 *  ① 完整 effect/* 子路径白名单（与宿主 bundle 内联实例一一对应，扩表走 kernel 版本升级，插件永远不能自造 effect）：
 *    effect, effect/Schema, effect/Effect, effect/Layer, effect/Stream, effect/Context,
 *    effect/Scope, effect/Fiber, effect/FiberRef, effect/Channel, effect/PubSub,
 *    effect/ReadableSignal, effect/Deferred, effect/Semaphore, effect/Queue, effect/Data,
 *    effect/Option, effect/Either, effect/Duration, effect/Clock, effect/Exit, effect/Chunk,
 *    effect/Iterable, effect/Cause, effect/Redact, effect/MutableRef, effect/HashMap,
 *    effect/HashSet, effect/InspectableCollection, effect/STM, effect/STM/T,
 *    effect/rpc, effect/rpc/RpcGroup, effect/Tracer, effect/Logger,
 *    @bytedock/plugin-sdk, undici            （共 ~35 条，kernel 内维护 Set 镜像 + 编译期同一张表）
 *  ② 最小 node:* 白名单（v0.1 冻结）：node:path, node:url, node:events,
 *    node:fs/promises（仅当 manifest.permissions.storage === "isolated-sqlite" 时放开，且限
 *    ~/.bytedock/plugins-data/ 目录，宿主包装层做路径前缀校验）。
 *    其余 node:*（child_process/net/dgram/tls）v0.1 直接 onResolve 拒载——与 Egress L1「JS 层 100%」口径自洽。 */
export interface HostModuleRegistry {
  readonly get: (id: string) => unknown; // 仅返回宿主已静态 import 的内存单例
  readonly subpathWhitelist: ReadonlySet<string>; // esbuild onResolve 共享的字符串镜像
  readonly allowedNodeBuiltins: ReadonlySet<string>;
}

export interface CompiledPluginArtifact {
  readonly pluginId: string;
  readonly rev: number;
  readonly code: string; // esbuild format=cjs 单文件产物（sourcemap:"inline"）
  readonly contentHash: string; // 保存风暴幂等去重（coalesceMs debounce 之后仍同 hash → 不重载）
  readonly cachedData?: Uint8Array; // 可选 V8 produceCachedData 二开加速（~/.bytedock/compiled/<rev>-<hash>.v8），非 v0.1 必须
}

/** R3 0.2②③ 装载序列（零 require.cache 污染——vm.compileFunction 走 v8::Script 不经 CJS loader；
 *  同 V8 realm，instanceof Error/Array/Map 与 Symbol.for 全部同一套内建；全免疫 vp pack/Electron 侧车/SEA
 *  四形态差异，因为 effect 永远来自宿主 bundle 内联的那份内存实例，路径上不存在 require(esm)）：
 *  1. esbuild 转译：external:["effect",/^effect\//,"@bytedock/plugin-sdk","undici",/^node:/]，
 *     onResolve 钩子对 external 子路径做 subpathWhitelist / allowedNodeBuiltins 比对；
 *     未命中 → 编译失败，产 ReloadFailure{ CompileError, reason:"SubpathNotWhitelisted" } + file:line:column
 *     （esbuild 天然带坐标，经 inline sourcemap 还原为插件源坐标，插件根本不进 boot）；
 *     ESM 顶层 await 依赖命中 → EsmTlaRejected（单文件 CJS 不支持 TLA，拒载）。
 *  2. vm.compileFunction(code, ["exports","require","module","__filename","__dirname"],
 *       { filename: "plugins/<id>/server/index.ts" })——宿主当前 realm 编译，未还原堆栈也指向插件源文件名。
 *  3. 注入绑定 HostModuleRegistry 的 pluginRequire（虚拟 require）并执行导出；
 *     插件图只活在内核 ModuleRegistry<rev>（rev → { moduleExports, compiledFn, sourceMap, weakRef }）。
 *  4. boot 单例探针：pluginRequire("effect").Context.Tag === HostModuleRegistry.get("effect").Context.Tag
 *     （同一 Symbol 实例断言）；不等 → ReloadFailure{ SingletonSplitError } 拒载（β 死因的机验闸门）。
 *  5. 卸载/evict：delete ModuleRegistry[rev] + Scope.close(LIFO)；
 *     evict 后断言 WeakRef(registry[rev]).deref() === undefined（进 1000 次 fuzz 靶心 1 与 GC 回归），
 *     完成 I4「模块图与注册资源已全部释放」。
 *  运行期堆栈还原：宿主 source-map 包 SourceMapConsumer.with(code+map) 挂 Error.prepareStackTrace。
 *  性能基线：单文件 5–50MB CJS compileFunction 实测 50–150ms，agent.open.before 2000ms 预算内。 */
export declare const HostModuleRegistry: Context.Tag<HostModuleRegistry, HostModuleRegistry>;
```

### 3.3 `packages/plugin-sdk/src/bridge.ts`（可序列化契约边界 + `PluginScopeBroker`，ADR-02/08 封板）

```ts
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/** 可序列化契约边界（ADR-02 同契约非同构）：跨 wire（v0.3 子进程轨）时逐字段 JSON 编码；
 *  禁跨：Effect / Stream / Scope / FiberRef / Symbol / Function。
 *  v0.1 同进程轨直调不序列化，wire 轨编码同一份类型——插件代码写一份契约两端复用。 */

export type RpcNamespace = string; // "plugins.<id>.<method>"，正则 ^plugins\.[^.]+\.[a-z][a-z0-9]*$ + 注册表双校验

export interface CallerRef {
  readonly kind: "host-client"; // R3 靶心/ADR-08：v0.1 严禁插件互调——无 "plugin" caller，横向面源头切除
  readonly sessionHash: string; // （v0.2 互调开放 = 单独 ADR，新增 kind:"plugin" + callerPluginId）
}

export interface RpcRequest {
  readonly seq: number;
  readonly ns: RpcNamespace;
  readonly body: unknown; // 可序列化
  readonly caller: CallerRef;
  readonly callerScopes: ReadonlyArray<string>; // AuthEnvironmentScope 名
  readonly deadlineMs: number;
}
export interface RpcResponse {
  readonly seq: number;
  readonly ok: boolean;
  readonly body?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface StreamFrame {
  readonly seq: number;
  readonly ns: RpcNamespace;
  readonly chunks?: ReadonlyArray<unknown>; // 增量帧（StreamLog 三段背压的消费端）
  readonly done?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}
/** 钩子分档预算：agent.open.before 2000ms / agent.turn.before 全插件总额 500ms（热路径）/ agent.compact.before 2000ms */
export interface HookInvocation {
  readonly name: string; // PluginHookName（manifest.ts 7 钩子封闭枚举）
  readonly input: unknown;
  readonly revision: number; // PluginRuntimeDescriptor 必携 revision（接缝 3）
  readonly deadlineMs: number;
}
/** per-plugin 隔离：单插件 deny 不连坐，fail-closed 仅安全类钩子（onError:"deny"） */
export interface HookDecision {
  readonly verdict: "pass" | "deny";
  readonly contribution?: unknown; // OpenContribution / TurnContextContribution / CompactContribution
  readonly reason?: string;
}

/** v0.3 子进程轨消费同一份类型（PluginRemoteContext JSON 帧协议）；v0.1 同进程轨直调不序列化 */
export interface PluginWorkerBridge {
  readonly rpc: (req: RpcRequest) => Effect.Effect<RpcResponse>;
  readonly stream: (req: RpcRequest) => Stream.Stream<StreamFrame>;
  readonly hook: (inv: HookInvocation) => Effect.Effect<HookDecision>;
}

export type BrokerDenyReason =
  | { readonly _tag: "UnknownNamespace" }
  | {
      readonly _tag: "ScopeIntersectionEmpty";
      readonly required: ReadonlyArray<string>;
      readonly have: ReadonlyArray<string>;
    }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "PluginNotActive"; readonly revision: number };

/** ADR-08 封板：前置白名单（ns 必须命中插件注册表 plugins.<id>.<method>）
 *  + 交集判定（callerScopes ∩ manifest.rpcScopes ∩ method.minScopes ≠ ∅）
 *  + 全量裁决落 append-only 审计 JSONL（五要素：actor / callerHash / target / scope 交集 / verdict） */
export interface PluginScopeBroker {
  readonly authorize: (args: {
    readonly caller: CallerRef;
    readonly callerScopes: ReadonlyArray<string>;
    readonly pluginId: string;
    readonly method: string;
  }) => Effect.Effect<
    | { readonly allowed: true; readonly auditId: string }
    | { readonly allowed: false; readonly reason: BrokerDenyReason },
    never
  >;
}
```

### 3.4 `packages/plugin-sdk/src/cacheGuard.ts`（双轨 CacheGuard + X-Ray，ADR-06 R3 封板）

```ts
/** R2 2.1 + R3 靶心 2：Adapter 声明能力位，kernel 按 profile 路由策略，绝无隐式降级与伪造指标 */

export type CacheTrack = "stateless-api" | "stateful-cli" | "stateful-acp";

export interface AdapterCacheProfile {
  readonly track: CacheTrack;
  readonly prefixChannel: "request-prefix" | "open-params";
  readonly turnAppend: "suffix-request" | "payload-wrap" | "unsupported";
  readonly compaction: "host-boundary" | "native-command" | "none";
  readonly usageVisibility: "full" | "opaque";
}
/** R3 靶心 2.1：profileKey = 5 能力位全 hash（sha256(track|prefixChannel|turnAppend|compaction|usageVisibility) 取 5 位）；
 *  PrefixImmutabilityViolation 比对域 = (stablePrefixBlocksHash, mcpExposureSnapshot, profileKey) 三元组整体一致才算不变；
 *  profileKey 变化 ⇒ 发 ProfileShiftEvent（expected reset，CI 门禁与违规计数均排除）+ 旧 profile 会话一律 close、新 profile 全量重开
 *  （CLI 轨 open-params 钉制物与 API 轨 request-prefix 不可互换；重开成本记 X-Ray "profile-shift re-open"，可审计） */
export interface ProfileShiftEvent {
  readonly fromProfileKey: string;
  readonly toProfileKey: string;
  readonly turnOrdinal: number;
  readonly trigger: "model-switch" | "provider-switch";
}

/** 接缝 6 两阶段 Open 贡献：① prepareMcpSession 之前（OpenPrepareContribution，改动 mcpServers 必须进入凭证 reservation）
 *  ② 之后、adapter.openSession 之前（OpenContribution，固化 env 与稳定前缀块 + 钉住 PluginRevision 写 plugin_kv ns=pin） */
export interface OpenPrepareContribution {
  readonly mcpServerOverrides?: ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>;
  readonly mcpExposure?: {
    readonly directTools: ReadonlyArray<string>;
    readonly deferred: boolean;
  };
}
export interface OpenContribution {
  readonly env?: Record<string, string>; // 如 L2 loopback 代理注入（NODE_USE_ENV_PROXY）
  readonly roleBlock?: string; // RoleProfile / SOUL.md
  readonly stablePrefixBlocks: ReadonlyArray<{
    readonly id: string;
    readonly hash: string;
    readonly body: string;
  }>;
  readonly mcpExposure: { readonly directTools: ReadonlyArray<string>; readonly deferred: boolean };
}

/** agent.turn.before 唯一合法产出（铁律④：禁改前缀；stateful 轨走 payload-wrap 通道）。
 *  R3 靶心 2.2 双字段防气泡污染（拦截点 = turn.before 产出后、adapter.startTurn 之前的 wire 组装层）：
 *  outboundUserText = wrap(appendContext, projectedMessage) 为独立 wire-only 变量；
 *  adapter.startTurn 入参 schema 强制拆 { projectedMessage: 原始只读, outboundUserText: wire-only }，
 *  类型层面禁止 adapter 把 wrap 串写回任何投影通道；
 *  /compact 判定（RunExecutionService L2347–2349 既有逻辑）永读 projectedMessage，wrap 串不得使其绕过压缩判定；
 *  CI 断言：ProjectionStore 投影事件流 userMessage payload hash 逐 turn 等于 ingestion 原文 hash（机验回归）。
 *  R3 靶心 2.3：MCP notifications/tools/list_changed 按 providerSessionId 独立延迟队列，
 *  仅在该会话自己的 turn 边界 flush，按 client 连接定向推送，禁全局广播
 *  （工具注册 mcp.registerToolkit 是全局的、list 可见性是 per-session 的——不对称写死在 03 §二.5 注释）。 */
export interface TurnContextContribution {
  readonly appendContext?: string; // 防失忆清单 / MEMORY.md 追加 / 活跃子任务索引
  readonly forceCacheReset?: { readonly reason: string; readonly compactProof: string }; // 仅 compact.before 合法
}
export interface CompactContribution extends TurnContextContribution {
  readonly handoffSummary?: string; // compact 专属：重置前缀时顺势注入
}

export type CacheGuardError =
  | {
      readonly _tag: "PrefixImmutabilityViolation";
      readonly offender: string;
      readonly revision: number;
    }
  | { readonly _tag: "TurnAppendUnsupported"; readonly adapter: string }
  | { readonly _tag: "ForceResetOutsideCompact"; readonly reason: string };

/** 铁律⑤：Compactor 只在 Turn 边界替换历史，飞行中绝不改工具输出；agent.tool.after 仅打溢出 artifactRef 标记并原文落盘 */
export interface ToolCompactionStrategy {
  readonly thresholdTokens: number;
  readonly boundaryOnly: true;
  readonly idempotentToolsOnly: boolean;
  readonly artifactDir: string; // ~/.bytedock/artifacts/<threadId>/（强切 abort 路径复用：长跑工具 checkpoint 续推）
}

/** R3 铁律⑥：X-Ray 三态，宿主永不伪造 Provider 缓存指标 */
export interface CacheImpactReport {
  readonly threadId: string;
  readonly turnOrdinal: number;
  readonly status: "measured" | "native" | "opaque"; // opaque 轨不虚标命中率
  readonly cachedInput?: number;
  readonly input?: number;
  readonly cacheCreation?: number;
  readonly hostInvariants: {
    readonly prefixHashStable: boolean;
    readonly mcpSnapshotStable: boolean;
    readonly contributionInBounds: boolean;
  };
  readonly invalidatedBy?: ReadonlyArray<string>;
  readonly estimatedSavingsUsd?: number; // 仅 measured 轨出数
}
// CI 门禁（第 10 章矩阵 2）：stateless-api fixture 稳态 cachedInput/(cachedInput+input+cacheCreation) >= 0.90；
// stateful-cli/acp fixture 断言 hostInvariants 全 true + X-Ray 标 opaque + 三类 case：
//   前缀突变 → 1 violation；mid-thread model switch → 0 violation + 1 ProfileShiftEvent + 两侧宿主不变量全 true。
```

### 3.5 `packages/plugin-ui-renderer/src/protocol.ts`（12 冻结原语 + StreamLog 三段背压 + atom 去抖，ADR-09 R3 封板）

```ts
/** 12 冻结原语（v0.1 正式封板：R3 5.4 将 StatRow 并入 Card.kpi，计数/CI 封闭 switch 分支数/knip 追踪面三方严格对齐 12；
 *  布局展示 6 + 低频交互 4 + 宿主原生流 2。原语扩容走 v0.2 ADR，v0.1 冻结不动） */
export type PrimitiveName =
  | "Stack"
  | "Row"
  | "Card"
  | "Text"
  | "Badge"
  | "Tabs"
  | "Button"
  | "Toggle"
  | "Select"
  | "Progress"
  | "StreamLog"
  | "TerminalView";

export interface CardKpiItem {
  readonly labelI18n: string;
  readonly value?: string | number;
  readonly tone?: "neutral" | "info" | "success" | "warning" | "error";
}

/** 封闭 props：禁 className、禁任意 style；Text 仅许 i18nKey（禁裸字符串，随包 locale/*.json 运行时合并）。
 *  12 原语渲染组件物理放 apps/web/src/components/plugin/（ADR-09：Tailwind 零配置、bundledDev 同构） */
export interface PrimitiveProps {
  readonly gap?: "sm" | "md" | "lg";
  readonly justify?: "start" | "between" | "center";
  readonly tone?: "neutral" | "info" | "success" | "warning" | "error";
  readonly size?: "sm" | "md" | "lg";
  readonly kpi?: ReadonlyArray<CardKpiItem>; // Card 专属封闭 KPI 块（替代原 StatRow）
  readonly i18n?: string;
  readonly i18nArgs?: ReadonlyArray<unknown>;
  readonly labelI18n?: string;
  readonly value?: string | number;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly labelI18n: string }>;
  readonly sinkId?: string; // StreamLog 专属
  readonly columns?: ReadonlyArray<string>; // StreamLog 专属
  readonly capacityHint?: number; // StreamLog ring 容量提示（宿主实际固定 4096）
  readonly terminalThreadId?: string; // TerminalView 专属（直挂宿主 PersistentThreadTerminalPanel 数据面）
  readonly openOnMount?: boolean; // TerminalView 专属
  readonly on?: { readonly action: string; readonly ns?: string }; // 交互动作 → plugins.invoke RPC
}

/** JSON 节点树（仅低频面板 <100 节点 & <=10–15Hz；所有列表子节点必带稳定 key） */
export interface JsonNode {
  readonly k?: string;
  readonly t: PrimitiveName;
  readonly p: Partial<PrimitiveProps>;
  readonly c?: ReadonlyArray<JsonNode>;
}

/** StreamLog 三段背压（语义钉死：tail-follow，非全文回放；高频日志/Token/终端绝不走全树 diff）：
 *  ① 服务端队列 cap 64 drop-oldest（溢出帧带 droppedOldest 计数）
 *  ② 客户端 rAF 16ms 合并刷屏（coalesceMs:16）
 *  ③ 客户端 ring buffer 4096 条淘汰（淘汰计数入哨兵行，UI 顶部钉 "已省略 N 条旧日志" 不可展开） */
export interface StreamChunk {
  readonly ts: number;
  readonly text?: string; // 日志行
  readonly record?: Record<string, unknown>; // 结构化记录（columns 渲染）
}
export interface StreamChunkFrame {
  readonly sinkId: string;
  readonly seq: number;
  readonly chunks: ReadonlyArray<StreamChunk>;
  readonly droppedOldest?: number; // 服务端 64 溢出 / 客户端 4096 淘汰计数帧
  readonly reset?: boolean;
}
export interface RingSpec {
  readonly capacity: 4096;
  readonly evict: "oldest";
  readonly coalesceMs: 16;
}

/** atom({persist}) 去抖契约（R3 靶心 5 封板）：
 *  storage 轨 → plugin_kv ns=state.<pluginId>（≤64KB，宿主写去抖 >= 500ms，与 plugins.yml CAS 同 lane）；
 *  memory 轨 → 仅插件进程内，重载保留（persist:"memory" 的 atom 前端局部重挂时保留）；
 *  流式关联 atom（每秒变化 >1 次）强制 persist:"memory"，编译期 lint 拒 storage；
 *  schemaVersion 变更 → kernel 调插件声明的 migrate(prevValue) 钩子，迁移失败置默认值 + UI 告警（不静默丢） */
export interface AtomSpec {
  readonly key: string;
  readonly persist: "memory" | "storage";
  readonly schemaVersion: number;
}
```

---

## 第 4 章 · 12 处必切薄接缝文件级手术卡 + `seam-ledger.json` + `check-seams.ts` 规格

> 切开顺序（V2 不变量执行面）：**W1–2: 1/2/3/4/10/15/16 → W3–4: 6/7/8 → W5: 5 → W7: 11**。每卡含：精确文件路径、锚点行区（对照 R3 内嵌真实切片行号）、双 tag 写法、核心植入代码片段、风险评级。`ServerSettings`（`packages/contracts/src/settings.ts`）全章零出现——插件配置一律走 `plugins.yml` + `plugin_kv`（ADR-05）。

### 4.1 标准手术卡（12 张，按切开顺序）

**卡 1 · 协议契约（W1，`auto`）**

- 文件：`packages/contracts/src/rpc.ts`（锚 L2709–2988，`WsRpcGroup` 闭合组末尾）
- 植入：纯加性 4 个元 RPC `plugins.list` / `plugins.reload` / `plugins.invoke` / `plugins.subscribe`（~50 行）。`subscribe` 带 `since(cursor)` 断线续订 + QoS 分级（`interactive`/`log`/`diagnostic`，移动蜂窝默认关 log 档——QoS 常量先定型，消费随接缝 12 进 v0.2）
- tag：块 tag（组末尾追加）`// bytedock-seam:rpc-plugins` … `// end-bytedock-seam:rpc-plugins`；顶部 import 挂行尾 `// bytedock-seam-import:rpc-plugins`
- 冲突风险：`auto`（纯追加闭合组尾部；上游在组中间插入行 → 机械合并）

**卡 2 · 权限鉴权（W1，`auto`）**

- 文件：`apps/server/src/auth/RpcAuthorization.ts`（锚 L45–65 `RPC_REQUIRED_SCOPES`）
- 植入（~35 行）：4 个元 RPC 注册进 `CLIENT_GUARDED_RPC_SCOPES` 扩展块；`invoke`/`subscribe` 前置**命名空间白名单**（`plugins.<id>.<method>` 必须命中 kernel 注册表，正则 + 注册表双校验）+ 委托 `PluginScopeBroker.authorize`（`callerScopes ∩ manifest.rpcScopes ∩ method.minScopes ≠ ∅`）；全量裁决经 broker 落五要素审计 JSONL
- 植入片段：
  ```ts
  // bytedock-seam:rpc-auth
  [RPC_METHODS.pluginsInvoke]: [/* host-client guard scope */],
  [RPC_METHODS.pluginsSubscribe]: [/* host-client guard scope */],
  const guardInvoke = Effect.fn("guardInvoke")(function* (ns, caller, callerScopes, method) {
    return yield* pluginScopeBroker.authorize({ caller, callerScopes, pluginId: nsToId(ns), method });
  });
  // end-bytedock-seam:rpc-auth
  ```
- 顶部 import（PluginScopeBroker / 注册表）挂行尾 `// bytedock-seam-import:rpc-auth`
- 冲突风险：`auto`（对象字面量尾部追加；上游新增 RPC 行不冲突）

**卡 3 · 能力发现（W1，`auto`）**

- 文件：`packages/contracts/src/environment.ts`（锚 L88–180 `ExecutionEnvironmentCapabilities`）
- 植入（~25 行）：能力对象加 `plugins?: ReadonlyArray<PluginRuntimeDescriptor>`，**必含 `revision` 字段**；三端发现插件与识别修订号。不修改闭合 `ServerSettings` Struct（配置走 `plugins.yml` + 专用 RPC，ADR-C4）
- tag：块 tag `// bytedock-seam:capability-plugins`；import 行尾 `// bytedock-seam-import:capability-plugins`
- 冲突风险：`auto`

**卡 4 · 服务端装配（W1，`auto`）**

- 文件：`apps/server/src/server.ts`（锚 L915–994 Layer 静态装配区）+ `apps/server/src/ws.ts`（锚 L1465 附近 4 个元 RPC handler 挂接）
- 植入（~80 行）：`import { PluginKernel } from "@bytedock/plugin-kernel"`（**行尾 `// bytedock-seam-import:kernel-mount`**——此静态 import 是 knip `packages/plugin-kernel` workspace「entry 闭包含住」的前提，第 2 章 §③ 依赖它）+ `PluginKernel.layer` 并入启动 Layer 链 + HTTP 动态前缀 `/api/plugins/:pluginId/*`（webhook 逐路由鉴权中间件挂此）+ UI 托管 `/plugins-ui/:pluginId/*` + 4 元 RPC handler
- 冲突风险：`auto`；Radar 台账标 A 类人工审查点（上游 server.ts 装配区高频变动，`driftThresholdPct` 收紧到 5%）

**卡 10 · 数据隔离（W1，`auto`）**

- 文件：`apps/server/src/persistence/Migrations.ts`（锚 L1–20 顺序编号迁移表尾）
- 植入（~25 行）：Migration **#126（且是 v0.1 唯一新增、必须最后 1 张）**：
  ```sql
  CREATE TABLE plugin_kv (
    plugin_id TEXT NOT NULL,
    ns TEXT NOT NULL,                 -- pin | descriptor | state.<pluginId> | audit-index
    key TEXT NOT NULL,
    json_value TEXT NOT NULL,
    expires_at INTEGER,               -- 仅 ns=pin 使用（单调寿命语义，§3.1b）
    PRIMARY KEY (plugin_id, ns, key)
  );
  -- Schema 硬约束（应用层 + CHECK 双保险）：length(json_value) <= 65536（超限报错，不截断）
  ```
- 硬约束（入 kernel 启动校验 CI）：per-plugin 默认配额 32MB（可调 4–64MB）；`ns=pin` touch 节流联动公式（§3.1）；卸载 `DELETE WHERE plugin_id=?` + 每日 TTL sweep；**严禁参与 `EventSink` 事务**（写走 post-commit outbox 独立连接，防 WAL 锁交叉，第 7 章 §7.1）
- 冲突风险：`auto`（追加迁移号；若上游 #126 先占号 → 台账改 #127，CI 断言「插件迁移恒为当前最后 1 张」）

**卡 15 · 定时任务桥接（W1，`auto`）**

- 文件：`apps/server/src/scheduledTasks/ScheduledTaskService.ts`（锚 L1–84 服务接口区）
- 植入（~30 行）：向 `PluginKernel` 暴露受控 `ctx.schedule({ task, interval, owner: pluginId })` 注册/撤销接口，绑定插件 `Scope`（修订 evict 时自动撤销）；托管 `plugin-upstream-radar` 定时巡检、pin 每日对账 job、Bot Cron 触发器
- tag：块 tag `// bytedock-seam:schedule-bridge`；import 行尾 `// bytedock-seam-import:schedule-bridge`
- 冲突风险：`auto`

**卡 16 · Outbox 跨端通知 & Secret 命名空间（W1，`auto`）**

- 文件：`apps/server/src/orchestration-v2/EffectWorker.ts`（outbox 投递挂点）+ `apps/server/src/secrets/SecretResolver.ts`（锚 L1–21，`layer` 组装区）
- 植入（~45 行）：① `notifications.send` 经宿主 outbox 投递（Decision Gate 三端可达：Web/Desktop/Mobile v0.1 只读）；② `SecretNamespaceBroker` 按 Manifest `secretNamespaces` 隔离 Webhook 凭据读取（插件只认 `secretRef: "<ns>.<name>"`，禁明文，CI lint）
- tag：块 tag 两块 `// bytedock-seam:outbox-notify` / `// bytedock-seam:secret-ns-broker`
- 冲突风险：`auto`

**卡 6 · Session 装配两阶段（W3，`manual`）**

- 文件：`apps/server/src/orchestration-v2/ProviderSessionManager.ts`（锚 L3311–3331：`prepareMcpSession` 与 `adapter.openSession` 调用之间——真实切片 L3311/L3331）
- 植入（~30 行，两阶段）：
  ```ts
  // bytedock-seam:open-session-rev-pin
  const openPrepare = yield* pluginKernel.hooks.runPrepare(          // ① prepareMcpSession 之前
    "agent.open.before", { threadId: input.threadId, revision });    // OpenPrepareContribution（mcpServers 覆写 → 必须进凭证 reservation）
  const prepared = yield* prepareMcpSession(applyMcpOverrides(input.threadId, openPrepare), input.modelSelection.instanceId);
  const pinned = yield* pluginKernel.pin(input.threadId);            // ② openSession 之前：钉住 active 修订
  const openAfter = yield* pluginKernel.hooks.runAfterPrepare(
    "agent.open.after-prepare", { pinned, ... });                    // OpenContribution：固化 env + 稳定前缀块
  // end-bytedock-seam:open-session-rev-pin
  ```
  pin 行写 `plugin_kv ns=pin`（`expires_at = pinnedAt + forceReapMs`，touch 节流 `<= max(1 次/10min, forceReapMs/4)`）；`ThreadSessionGate.withGate` 包裹整段（§3.1b 态转换表）
- 冲突风险：`manual`（函数体锚点，上游 `prepareMcpSession` 签名变动 = 强制人工评审；`driftThresholdPct: 3`）

**卡 7 · Turn / Compact 装配（W3，`manual`）**

- 文件：`apps/server/src/orchestration-v2/RunExecutionService.ts`（锚 L2306–2360：`turnInput` 组装 L2310 与 `/compact` 判定 L2347–2349 之间——真实切片）
- 植入（~40 行）：`agent.turn.before` 仅接受追加式 `TurnContextContribution`（热路径全插件总预算 500ms，超时 per-plugin 隔离不连坐）；`agent.compact.before` 允许重置前缀（`CompactContribution.handoffSummary`）；Turn 边界执行 Compactor 历史替换。`/compact` 判定行（L2347–2349）**不得触碰**——它读 `input.message.text` 投影原文，wrap 串天然免疫（§3.4 R3 2.2 契约③）
- 冲突风险：`manual`（`driftThresholdPct: 3`）

**卡 8 · 出站网络与代理（W4，`manual`）**

- 文件：`apps/server/src/outboundHttp.ts`（锚 L14–32 `installHttp1FetchDispatcher`——真实切片全文 69 行）+ `apps/desktop/src/main.ts` `session.setProxy` 挂点
- 植入（~75 行，R3 靶心 3 封板双闸时序，完整规格见第 5 章）：
  ```ts
  // bytedock-seam:egress-guard-mount
  installHttp1FetchDispatcher(); // 既有：保留 EnvHttpProxyAgent / allowH2:false 原语义
  egressGuard.install({ wrap: undici.getGlobalDispatcher() }); // 闸 1：GuardDispatcher 包裹当前 dispatcher
  egressGuard.hijackGlobalSetDispatcher(undici); // 闸 2：劫持 undici.setGlobalDispatcher 本体
  egressGuard.installDnsLayer(); // 全局 dns.lookup 合成 ENOTFOUND + AsyncLocalStorage 防递归
  egressGuard.denyDgramUdp();
  // end-bytedock-seam:egress-guard-mount
  ```
  Desktop 侧：`session.setProxy({ proxyRules: <guard loopback 代理> , bypassRules: [] })`——`bypassRules` 置空是硬约束（渲染器流量全量进 guard 审计）
- 冲突风险：`manual`（`outboundHttp.ts` 是上游性能/协议修复高频区；`driftThresholdPct: 3`；上游动 L14–32 任何一行 → 强制人工评审 + 靶心 3 攻防回归电池重跑）

**卡 5 · MCP 动态桥（W5，`manual`）**

- 文件：`apps/server/src/mcp/McpHttpServer.ts`（锚 L1510–1575 `layerToolExposure` / `layerDeferredListing`——真实切片）
- 植入（~55 行）：暴露修订号绑定的动态工具注册（`mcp.registerToolkit` 全局注册，`tools/list` 可见性与 `list_changed` 广播**按 `providerSessionId` 独立延迟队列**，per-connection 定向推送，§3.4 R3 2.3）；复用既有 `MCP_TOOL_EXPOSURE_HEADER: deferred + tool_search` 按 RoleProfile 钉制直出工具集；`list_changed` 仅在该会话自己的 Turn 边界广播；`agent.tool.after` 仅打溢出 `artifactRef` 标记（历史替换延迟到 Turn 边界，铁律⑤）
- 冲突风险：`manual`（`driftThresholdPct: 3`）
- 排在 W5 的原因：依赖卡 6/7 的 pin/contribution 通道全通，MCP 快照语义才完整可测

**卡 11 · 前端 UI Slot v0.1 精简 4 Slot（W7，`manual`）**

- 文件：`apps/web/src/components/chat/RightPanelSurfaceContent.tsx`（锚 L94–250，`dockPanel` 挂现有右栏 tab——**容器接口 v0.1 定型，v0.2 Dockview 换壳零返工**）· `apps/web/src/components/settings/SettingsSidebarNav.tsx`（锚 L94–121，`settingsSection`：`/settings/plugin/$pluginId` 壳 + 侧栏注册 + 设置搜索 + runtime i18n）· `apps/web/src/components/chat/MessagesTimeline.tsx`（锚 L1820–1848，`timelineRenderer`：稳定 kind `"plugin-card"`）· `apps/web/src/components/ChatView.tsx`（锚 L4269，`statusBarItem` 底栏挂载）
- 植入（~90 行）：4 个封闭插槽点各一个渲染分支（`case "plugin-card": return <PluginNodeRenderer node={...} />`），12 原语渲染器宿主化组件全在宿主扫描域，React Compiler 100% / `gt-react` / Tailwind v4 静态扫描 CI 门禁不破。`composerItem`/`sidebarView`/`composerBanner` **本卡不切**（v0.2 子项）
- 冲突风险：`manual`（4 文件均为 Web 壳层高频区；`driftThresholdPct: 3`；W7 才切保证前三周宿主 UI 零 diff，降低并行冲突面）

### 4.2 完整初始版 `seam-ledger.json`（12 条，与卡号一一对应）

```json
{
  "schemaVersion": 1,
  "version": "v0.1-lite",
  "seams": [
    {
      "id": "rpc-plugins",
      "file": "packages/contracts/src/rpc.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "rpc-auth",
      "file": "apps/server/src/auth/RpcAuthorization.ts",
      "anchor": "both",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "capability-plugins",
      "file": "packages/contracts/src/environment.ts",
      "anchor": "both",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "kernel-mount",
      "file": "apps/server/src/server.ts",
      "anchor": "both",
      "tagCount": 1,
      "driftThresholdPct": 5,
      "review": "auto",
      "cutOrder": "W1",
      "note": "静态 import 是 knip kernel workspace 闭包前提；另含 ws.ts handler 块 tag seam:plugins-rpc-handlers"
    },
    {
      "id": "plugins-rpc-handlers",
      "file": "apps/server/src/ws.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "plugin-kv-migration",
      "file": "apps/server/src/persistence/Migrations.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1",
      "note": "Migration #126 恒为当前最后 1 张；上游先占号则顺延并同步本台账"
    },
    {
      "id": "schedule-bridge",
      "file": "apps/server/src/scheduledTasks/ScheduledTaskService.ts",
      "anchor": "both",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "outbox-notify",
      "file": "apps/server/src/orchestration-v2/EffectWorker.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "secret-ns-broker",
      "file": "apps/server/src/secrets/SecretResolver.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 8,
      "review": "auto",
      "cutOrder": "W1"
    },
    {
      "id": "open-session-rev-pin",
      "file": "apps/server/src/orchestration-v2/ProviderSessionManager.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 3,
      "review": "manual",
      "cutOrder": "W3",
      "note": "两阶段：prepareMcpSession 前 + adapter.openSession 前；ThreadSessionGate 临界区"
    },
    {
      "id": "run-turn-contrib",
      "file": "apps/server/src/orchestration-v2/RunExecutionService.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 3,
      "review": "manual",
      "cutOrder": "W3",
      "note": "/compact 判定行不得触碰"
    },
    {
      "id": "egress-guard-mount",
      "file": "apps/server/src/outboundHttp.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 3,
      "review": "manual",
      "cutOrder": "W4",
      "note": "Desktop main.ts session.setProxy(bypassRules:[]) 同卡联审"
    },
    {
      "id": "mcp-dynamic-bridge",
      "file": "apps/server/src/mcp/McpHttpServer.ts",
      "anchor": "block",
      "tagCount": 1,
      "driftThresholdPct": 3,
      "review": "manual",
      "cutOrder": "W5"
    },
    {
      "id": "ui-slots-v01",
      "file": "apps/web/src/components/{chat/RightPanelSurfaceContent.tsx,settings/SettingsSidebarNav.tsx,chat/MessagesTimeline.tsx,ChatView.tsx}",
      "anchor": "block",
      "tagCount": 4,
      "driftThresholdPct": 3,
      "review": "manual",
      "cutOrder": "W7",
      "note": "v0.1 仅 4 Slot；composerItem/sidebarView/composerBanner 归 v0.2 子项"
    }
  ],
  "totals": { "seams": 14, "files": 16, "estDiffLines": 585 }
}
```

> 注：14 条台账 = 12 处接缝（卡 4/10/16 各自拆成 2 个物理落点文件），物理文件 16 个，合计 ~585 行——与 V2 不变量「12 处必切（16 文件）」逐字对齐。

### 4.3 `scripts/check-seams.ts` 核心校验逻辑与 4 件套回归测试（支持 `idea-sync` 显式演进放行）

```ts
// 校验规则（git-diff 锚定，防无意改乱 + 免疫 prettier 假红灯，同时不卡死「只同步思路 AI 原生重写」）：
// R1 合法性：PR 触碰 mode:"strict"（默认）的保护区文件时，diff 新增行必须（a）位于成对 // bytedock-seam:<id> 块内，
//    或（b）是挂 // bytedock-seam-import:<id> 的单行 import；且 <id> ∈ seam-ledger.json
// R2 上游行柔性保护：
//    - 对 mode:"strict" 文件：未登记的既有上游行修改（含误触全文件格式化）→ 红灯提醒「无意修改上游行，请只触碰 seam 块」；
//    - 对已显式登记 mode:"diverged" 或携带 // bytedock-idea-sync:<prNumber> 意图标记并同步登记 upstream-ledger.jsonl 的改造
//      （例如「只同步上游思路，由 AI 按 ByteDock 架构原生重写一版」）→ 放行并转入人工审阅/测试门禁，不强行卡死演进！
// R3 台账对账：ledger 每条目 { id, file, anchor, tagCount, mode?: "strict" | "diverged", driftThresholdPct, review }；
//    review:"manual"（open-session-rev-pin / run-turn-contrib / egress-guard-mount / mcp-dynamic-bridge / ui-slots-v01）
//    的接缝 diff → 人工评审 + driftThresholdPct=3 漂移提醒
export function checkSeams(diffs: FileDiff[]): CheckResult {
  const ledger = loadLedger("seam-ledger.json");
  for (const diff of diffs) {
    if (!ledger.files(diff.path)) continue; // 非台账文件：保护区外，放行
    if (ledger.modeOf(diff.path) === "diverged") {
      // 已主动演进/思路重写分叉的文件：只做漂移记录，不红灯卡死
      recordDriftNotice(diff);
      continue;
    }
    for (const line of diff.changedLines) {
      if (line.isPureAddition && (inTaggedBlock(diff, line) || isTaggedImportLine(diff, line)))
        continue;
      if (hasExplicitIdeaSyncMarker(diff, line)) continue; // 显式「只同步思路 AI 重写」标记：放行 + 要求台账与等价回归测试
      return fail(
        diff.path,
        line,
        "检测到未登记的上游行修改或新增行未挂 seam tag（若为刻意思路重写，请登记 idea-sync/diverged）",
      );
    }
    assertTagIdsSubsetOfLedger(diff, ledger); // R1 <id> ∈ ledger
    if (ledger.reviewOf(diff.path) === "manual") requireHumanReview(diff); // R3
  }
  return pass();
}
```

**4 件套回归 fixture（随 PR 进仓，`vp run check:seams` 干跑全绿）**：

1. `fixtures/clean.diff`：全部新增行在 `// bytedock-seam:rpc-plugins` 块内 + 一条 tagged import → **绿**
2. `fixtures/untagged-upstream-edit.diff`：无意修改 1 行未 tag 的上游既有行（或全文件格式化污染）→ **红**（CI 消息逐行指认）
3. `fixtures/tagged-import.diff`：仅 2 行行尾注释 import → **绿**
4. `fixtures/explicit-idea-sync.diff`：已登记 `mode: "diverged"` 或带 `// bytedock-idea-sync:<pr>` 的主动思路重写改动 → **绿**（附带漂移/测试校验提醒）
   零假红灯终审：块内代码被 prettier 缩进仍属「块内新增行语义」→ 绿；只拦“无意改乱老代码”，绝不束缚“只学上游思路、AI 自己写一版更好的”。

### 4.4 延迟接缝 v0.2/v0.3 预留锚点（证明零返工）

| 接缝                  | 预留锚点                                                                                                                                                                                                                                                                       | 归属        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 9 引擎/额度           | `ProviderInstanceRegistryHydration.ts` L55–66 + `UsageLimitSources.ts` L131–160：v0.2 切 `UsageLimitSources` 扩展段（~20 行，`plugin-usage-hub` 消费）；`ProviderDriverKind` 双变体 + `registerDriver` 第三方可用段（~80 行）v0.3，唯一改闭合枚举的硬骨头，v0.1 零消费不提前切 | v0.2 / v0.3 |
| 12 客户端流同步       | `packages/client-runtime/src/state/environmentStreams.ts` L1–35：接缝 1 已定型的 `since(cursor)`/QoS 常量在此**纯追加**桥接进 `followStreamInEnvironment`（~45 行），随 Mobile 轨 1 进 v0.2                                                                                    | v0.2        |
| 13 Desktop 能力白名单 | `packages/contracts/src/ipc.ts` L1–80 + `apps/desktop/src/main.ts`：冻结 `PluginDesktopCapability` 白名单，插件经 `plugins.invoke` 间接调用（~40 行），随 `plugin-windows-essentials` 进 v0.2                                                                                  | v0.2        |
| 14 命令面板           | `apps/web/src/commandPaletteStore.ts` L1–84 + `CommandPalette.tsx`：单点追加命令搜集 + `replaces` 前置拦截（2s 超时回退内置动作，~25 行）                                                                                                                                      | v0.2        |
| 11 三子项             | `composerItem` / `sidebarView` / `composerBanner`：v0.2 追加卡 11 同文件区（卡 11 的 4 Slot 锚点行区已避开这三个挂载位，上游移植不冲突）                                                                                                                                       | v0.2        |

---

## 第 5 章 · Egress Guard 三级防火墙与双段 `EgressProof` 实现规格

### 5.1 Dispatcher 双闸（精确实现时序，R3 靶心 3.1 封板）

```text
启动序列（apps/server 启动，kernel 挂载点 = 接缝 8 卡）：
① installHttp1FetchDispatcher()            // 既有语义零改动：EnvHttpProxyAgent(allowH2:false, clientFactory 保 h1) 或 Agent
② GuardDispatcher.wrap(undici.getGlobalDispatcher())   // 闸 1：guard 实现 undici.Dispatcher，
   dispatch(req, opts) → 判定放行域（域名白名单 + scripts/egress-denied-domains.json 禁表）
   → 委托内部 dispatcher（h1 语义 / clientFactory / macOS EINVAL 补丁原样保留）
③ undici.setGlobalDispatcher = guardedSetGlobalDispatcher   // 闸 2（劫持换闸）：
   guardedSetGlobalDispatcher(d) { undici.__native_setGlobalDispatcher(guardWrap(d)); audit("dispatcher-swap", d.constructor.name); }
   —— 宿主后续任何代码（含第三方 SDK）再换 dispatcher 都被自动包进 guard 链，「事后换闸绕过」后门关闭
④ 经 Context.Tag 注入 GuardDispatcher：kernel fetch/http 出口统一经 Tag 取 dispatcher；
   outboundHttp.ts 7 个导出函数执行完 freeze 当前引用
⑤ 自持实例兜底：第三方 new Agent() 直连 → 走自己的 node:net.connect → 被 5.2 connect 层 patch 兜住
   （dispatcher 层防 undici 用户，connect 层防所有 TCP/TLS 用户，双层无死角）
```

### 5.2 双层 DNS 拦截 + UDP + Chromium 代理

```text
全局层（防直接 getaddrinfo 泄露）：
  patch dns.lookup / dns.promises.lookup / dns.resolve*：
  · strict 模式：非白名单域名 lookup 本身返回合成 ENOTFOUND（零字节出网）；audit-only 模式记录
  · patch 保存 native 原引用 + AsyncLocalStorage<guardFrame> 重入标记：
    guard 自身白名单校验的 lookup 走 native 引用 → 递归在结构上不可能（AsyncLocalStorage 防递归回归必测）
连接层（undici 专属，防 SSRF DNS Rebinding——R3 靶心 3.2 精确定位）：
  guard dispatcher 的 connect 选项（Agent({ connect }) / clientFactory 内挂，非全局 net.connect patch）：
  a) 域名白名单判定（此时还有主机名）
  b) dns.lookup(host, { all: true, family: opts.family }) 拿全部地址
  c) 逐 IP 二次校验：127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16 → 非显式 loopback 白名单一律拒
     （SSRF Rebinding 在 c 处死掉：恶意域名白名单过审、解析到 127.0.0.1，c 处看 IP 不看域名）
  d) 透传 autoSelectFamily + autoSelectFamilyAttemptTimeout（镜像宿主 1000ms 全局值，Happy Eyeballs 行为不变，
     Node 26 与 Electron 44 均安全）
  e) undici 7+ 的 setLocalAddress 语义 pin 已校验 IP → 消除「校验后、连接前」再解析 TOCTOU 窗口
双栈 { all: true } 语义：v4/v6 全部地址过 c 才放行；任一命中私网 → 本次 lookup 全拒（不做「剔除私网放行公网」半吊子）
dgram：UDP deny-by-default（R2 维持）
Electron：session.setProxy({ proxyRules: <guard loopback 代理> , bypassRules: [] })——bypassRules 置空，渲染器流量全量进 guard 审计
Windows EBUSY/EPERM（Defender 实时扫描）：临时文件 rename 失败按 200/400/800ms 退避重试 3 次，仍失败 → stale-write 告警不崩（第 2 章 §④）
```

### 5.3 双段 `EgressProof` 报告 JSON Schema + hash-chained 审计轮转三态

```jsonc
// egress-proof.json（EgressGuard 自检产物，插件面板与发布检查表消费）
{
  "generatedAt": "<iso>", "hostPid": 0, "node": "v26.13.1", "undici": "8.x",
  "liveAttribution": {                 // 段 1：活宿主 60s 归因不变量（loopback/pipe 证明式排除，非全禁自反）
    "windowMs": 60000,
    "asserts": [
      "all outbound TCP/TLS connections attributed to: whitelist | loopback-allowed | egress-denied",
      "loopback connections only from: <具名清单，含 L2 loopback 代理>",
      "named pipes (kind:'pipe') excluded from L1 guarantees, counted in audit",
      "zero unattributed outbound bytes in window"
    ],
    "verdict": "pass" | "fail",
    "uncoveredNative": [ { "origin": "uncovered-native", "pid": 0, "path": "node-pty", "note": "归 L2/L3" } ]
  },
  "detachedAllBlock": {                // 段 2：独立离线全禁探针 runner（空白名单环境零出站断言）
    "runner": "spawned-isolated-process",
    "probes": [ "http.get('https://example.com')", "net.connect(public-ip)", "fetch via undici global" ],
    "expected": "all ENOTFOUND / ECONNREFUSED within host, zero external bytes",
    "verdict": "pass" | "fail"
  }
}
```

**`egress-audit.jsonl` hash-chained 轮转三态**：`eventHash = sha256(prevHash ‖ seq ‖ canonicalJson(payload))`，genesis = `sha256(pluginId ‖ installTs)`；64MB 轮转时**先落尾 hash 到 `plugin_kv ns=audit-index` 再删旧文件**；`bytedock audit verify` 状态机三值：

- `verified`：全链可验
- `rotated-unverified`：已轮转且尾 hash 指针存在、旧文件已删（可验至指针，指针前不可重验）——UI 黄条
- `broken`：链条断裂——UI **红条**显式告警，`bytedock audit verify` 输出断点 seq

### 5.4 完整落盘的 3 句审计级诚实安全口径文案（进 `04` 插件族 A 与 README 安全页；禁「100% 零外联」式全量宣称）

> **① 覆盖域定义**：「L1 宿主 100% 网络拦截覆盖宿主进程的 JS 层出站路径：undici/全局 `http`/`net`/`tls`/`dgram`/`node:dns` 与 Chromium `session.setProxy` 全量渲染器流量。JS 层之外——原生 N-API addon（`ffi-rs`、`node-pty`、`transcribe-cpp` 等既有依赖）与第三方子进程内部的原生 TLS/socket——不在 L1 保证域内，按设计归 L2（loopback 代理 + `NODE_USE_ENV_PROXY`，best-effort 封锁全审计）或 L3（OS 防火墙硬模式，opt-in 全量保证）。」
>
> **② 可机验承诺替代口号**：「EgressProof 双段自证：① 活宿主 60s 归因不变量（loopback/pipe 证明式排除，非全禁自反）；② 独立离线全禁探针 runner（空白名单环境零出站断言）。任何未覆盖路径的出站尝试将出现在 L2/L3 审计日志中并标记 `origin: "uncovered-native"`，我们承诺**可发现**而非**可拦截（对 JS 层外路径）**。」
>
> **③ 能力分级表**（放产品页）：「L1 = 宿主 JS 层 100% + 诚实边界声明；L2 = 子进程 CLI 全审计、封锁 best-effort；L3 = OS 级全路径保证（用户 opt-in 安装防火墙规则后才可宣称）。ByteDock 的默认安全叙事 = L1 + L2，L3 是用户的升级选项而非我们的默认口径。入站具名管道（`kind: "pipe"`，`net.connect(path)`）在 L1 外，审计计数但不拦截。」

---

## 第 6 章 · UI 三轨渲染、12 原语宿主化与 `PluginSandboxFrame` 安全规格

### 6.1 轨 1 渲染链路（全端主力，<100 节点 & <=10–15Hz 低频面板）

```text
插件 client/index.tsx（零构建 TSX，import 自 @bytedock/plugin-sdk/client）
   │ Sucrase Worker 隔离转译（单文件轻量 TSX，2s 熔断；多文件/依赖走独立 fork esbuild 子进程，空闲 1–5s 自退）
   ▼
JSON 节点树（§3.5 JsonNode，封闭 12 原语，列表子节点必带稳定 key）
   │ 低频节点 ≤10–15Hz 直发；高频日志/Token/终端强制改走增量 chunk（host.streams.log(id,{append})）
   ▼
apps/web/src/components/plugin/PluginNodeRenderer.tsx
   · 封闭 12 分支 switch（t === "Stack" | "Row" | "Card" | "Text" | "Badge" | "Tabs"
     | "Button" | "Toggle" | "Select" | "Progress" | "StreamLog" | "TerminalView"，
     默认分支红灯——13 种原语在 Schema 校验层即拒，运行时 switch 兜底 assert）
   · Card.kpi 封闭 KPI 块（§3.5 CardKpiItem）
   · Text 仅 i18nKey → 宿主 i18n 字典 + 插件随包 locale/*.json 按 localeHash 运行时合并
   · StreamLog：rAF 16ms 合并 + 4096 ring buffer 哨兵行（服务端 64 cap drop-oldest → 客户端 4096 淘汰 →
     哨兵行钉「已省略 N 条旧日志」，tail-follow 语义）
   · TerminalView：直挂宿主 PersistentThreadTerminalPanel 数据面（插件仅控制开窗 openOnMount 与订阅，
     数据面不经插件进程）
   · Button/Toggle/Select on.action → plugins.invoke RPC（经接缝 2 broker 鉴权 + 审计）
Mobile（v0.1）：12 原语同协议 RN 实现归 v0.3；v0.1 Mobile 轨 = outbox 只读通知
```

**轨 3 = 编译期第一方内置（非运行时插件 Slot）**：Dockview 壳（v0.2）、核心协作总览等强耦合内置模块走标准 React/RN 组件编译期直连，不走运行时动态加载，React Compiler 100% 与 `gt-react` 静态提取门禁不破。

### 6.2 轨 2 `PluginSandboxFrame.tsx`（空间交互与重画布：Acan 2D 工厂 / Vibe Kanban / Canvas）

```text
新建 apps/web/src/components/plugin/PluginSandboxFrame.tsx，
从 BrowserDocumentFrame.tsx 抽公共基座 HtmlSandboxFrameBase（postTheme 主题同步 / 快捷键白名单转发 /
高度自适应 / 外链拦截 openLink 白名单——宿主既有模式，BrowserDocumentFrame L441–448 的
useLayoutEffect commit 挂载即「首包早于 passive effect」竞态的既有答案，直接复用）
子类差异（R3 靶心 4.1 裁决）：
  · sandbox 最终值 = "allow-scripts"（移除 allow-forms：插件 UI 交互全走原语 on.action → plugins.invoke RPC，
    表单提交在契约上没有合法用途，移除零功能损失；钓鱼提交面根除）
  · 无 allow-same-origin（opaque origin，页面出宿主 session）
  · 回包定向：frame.contentWindow?.postMessage(payload, "null")（无 allow-same-origin 时插件源为 "null"；
    基座既有 "*" 是文档渲染器容忍项，插件基座不得沿用）
  · allow-popups-to-escape-sandbox 默认关（仅 manifest permissions.ui.popups 显式声明时开）
nonce 四条件握手（R3 靶心 4.2 封板，零丢首包 + nonce 零进 URL/Referer）：
  ① event.origin === "null"
  ② event.source === frame.contentWindow
  ③ data.nonce === issued（issued = 每插件实例 crypto.randomUUID()，onLoad 时 postMessage 注入，
     存 sessionStorage 作用域，不进 URL query → 不进 history → 不进 Referer → 不进任何日志；
     srcdoc 形态同一通道，与加载方式解耦）
  ④ 消息类型 ∈ 封闭枚举（sandboxBridge.ts 协议类型）
  重放窗口 = 该 iframe 存活期，unmount 即 nonce 作废
  引导脚本（构建产物 plugin-sandbox-bridge.js）：postHostMessage 实现为 pending 队列 + 状态机——
  nonce 未到手前所有消息入队，window.onHostInit 后按序 flush；宿主 useLayoutEffect commit 挂载
  监听 → 首包在任何 effect 时序下不丢
  window.open 逃逸：无 allow-popups → 天然被 sandbox 拒绝；外链走宿主 openLink 白名单转发
横向攻击电池（第 10 章矩阵 4）：跨 iframe 源伪造 / nonce 重放 / allow-forms 回归 lint / 首包竞态 / URL-Referer nonce 泄漏
```

### 6.3 插件 runtime i18n 与 `atom({persist})` 迁移钩子

- `Text` 编译期禁裸串（`<Text>` 只许 `i18nKey`，`gt.config.json` ignore + 插件 `locale/*.json` 按 `localeHash` 合并——同 localeHash 已合并则跳过，防热重载重复 merge）
- `atom({persist:"storage", schemaVersion})`：宿主写去抖 >=500ms → `plugin_kv ns=state.<pluginId>`（≤64KB，同 lane CAS）；`schemaVersion` 变化触发插件声明的 `migrate(prevValue)` 钩子，迁移失败置默认值 + UI 告警（不静默丢数据）；流式关联 atom 强制 `persist:"memory"`（编译期 lint）

---

## 第 7 章 · 四格存储、`PluginConfigService` 三通道与热重载开发态闭环

### 7.1 四格存储精确规约（ADR-05 终裁，Manifest 校验 + CI Lint 双入口）

| 存储层                                                            | 唯一允许存放                                                                                                                                                                  | 严禁存放                                                                                        | 机验硬约束                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.bytedock/plugins.yml`（含 `profiles/*.yml`）                  | 插件启用开关、经 manifest `configSchema` 校验的用户配置、场景 Profile、Egress 白名单覆写                                                                                      | 运行态数据、>50KB 单文件、Secret 明文（仅 `secretRef: "<ns>.<name>"`）、日志                    | kernel 单写者 lane + temp-rename 原子写 + 写前 mtime/版本戳 CAS；用户手改优先（冲突 = 用户赢 + `stale-write` UI 告警）；头部 `schemaVersion: 1` + 纯函数 `configMigration`                                             |
| `plugin_kv`（`statev2.sqlite` 最后 1 张表，Migration #126）       | 有界跨进程元数据：`ns=pin`（修订钉住必带 TTL）/ `ns=descriptor`（能力缓存）/ `ns=state.<pluginId>`（`atom({persist:"storage"})`）/ `ns=audit-index`（JSONL 轮转尾 hash 指针） | 日志流、>64KB 单值、查询型重数据、**参与 `EventSink` 事务**（写走 post-commit outbox 独立连接） | `length(json_value) <= 65536` 超限报错不截断；per-plugin 默认 32MB（可调 4–64MB）；卸载 `DELETE WHERE plugin_id=?` + 每日 TTL sweep；`ns=pin` touch 节流联动公式（§3.1）+ 单调寿命 `graceRemainingMs` + 唤醒立即 touch |
| `isolated-sqlite`（`~/.bytedock/plugins-data/<pluginId>.sqlite`） | 插件重数据：Bot `MEMORY.md` 结构化索引、X-Ray 账单明细、`DockTask`/`DecisionGate` 状态、>64KB blob                                                                            | 跨插件 SQL（kernel 仅给本插件 DB 连接，禁 join 他人表）、触碰宿主表                             | 独立连接 + 独立 WAL；每插件恰 1 文件；卸载 = 停连接并标 `orphan`（保留文件供重装，`plugins.purge` 显式清理）                                                                                                           |
| append-only JSONL（`~/.bytedock/audit/*.jsonl`）                  | 不可篡改审计流水：`egress-audit.jsonl`（hash-chained）/ `upstream-ledger.jsonl` / `decision-gates.jsonl` / RPC/HTTP/iframe 统一五要素审计                                     | 可变状态（修正须追加 + `supersedes` 指针）、聚合查询（镜像进 isolated-sqlite）、Secret 明文     | 轮转三态 `verified/rotated-unverified/broken`（§5.3）；`broken` 显式 UI 红条；`bytedock audit verify`                                                                                                                  |

**防 WAL 锁交叉规约（CI 静态检查 + 启动自检）**：`plugin_kv` 连接池与 `EventSink` 主库连接池物理分离（独立 `node:sqlite` 连接，busy_timeout 5000ms）；插件写路径 = 先 outbox 事件 → 主库 post-commit → 独立连接写 `plugin_kv`/`isolated-sqlite`，任何同事务跨格写 = `Data.TaggedError("StorageBoundaryViolation")` 硬失败，不静默。

### 7.2 `PluginConfigService` 单写者 lane + mtime CAS + 三通道推送时序

```text
~/.bytedock/plugins.yml（唯一配置真源）
  写者 1：用户手改 → @parcel/watcher watch（500ms coalesceMs debounce + hash 幂等）
  写者 2：plugins.updateConfig RPC → 单写者 lane（Semaphore(1) 串行）
        写前 mtime/版本戳 CAS：
        CAS 成功 → temp-rename 原子写 + 版本戳 +1
        CAS 失败（用户先改过）→ 用户赢：丢弃本次写入 + stale-write UI 告警（写通道 ② 事件）
        ↓
PluginConfigService（kernel 内部，按各插件 configSchema 校验；单插件失效仅该插件降级默认值，不连坐）
  通道 ① 插件服务端：ctx.config（ReadableSignal）免重载热推送
        · UI 类字段即时生效
        · 行为类字段（env / mcpServers / networkHosts）遵循 CacheGuard 语义「下一次 Session open 生效」，UI 明示
  通道 ② 客户端同步：发布 MilestoneHub 事件 kind:"plugin.config"
        · Web / Desktop 经接缝 1 plugins.subscribe（since(cursor) 断线补发）实时同步
        · Mobile v0.1 仅经 outbox 通知只读当前配置（实时写同步随接缝 12 进 v0.2）
  通道 ③ 策略消费方：EgressGuard 白名单覆写 / Upstream Radar 规则订阅同源 Signal 热生效
ServerSettings 全程零触碰（V2 不变量）。
```

### 7.3 开发态无泄漏热重载端到端时序（方案 α 全链路，报错不白屏 + 旧版永驻直到新版就绪）

```text
① 保存事件    @parcel/watcher（dev 目录 ~/.bytedock/plugins-dev/ 或仓库 plugins/；Windows Defender 已排除，
               未排除则延迟 1–3s 可容忍；WSL 路径/网络盘不支持——启动即警告）
② 合并        500ms coalesceMs debounce + 文件 contentHash 幂等（同 hash 直接跳，保存风暴零重载）
③ 编译        单文件 TSX → Sucrase Worker（2s 熔断）；多文件/依赖 → 独立 fork esbuild 子进程
               （仅加载已编译产物，fork 空闲 1–5s 自退；ESBUILD_BINARY_PATH 指向 app.asar.unpacked）
               esbuild external onResolve 白名单校验（§3.2 装载序列 1）：未命中子路径
               → CompileError(SubpathNotWhitelisted) + file:line:column，插件不进 boot
④ 装载        vm.compileFunction（宿主 realm）+ 注入 HostModuleRegistry 虚拟 require
               boot 单例探针：Context.Tag 同一 Symbol 断言（不等 → SingletonSplitError 拒载）
⑤ 发布        新版 install 并 freeze 成功 → 旧修订置 frozen（frozenAt 赋值，refCount→0 复检排空 30s grace）
               新版任何一步失败 → 旧修订永不冻结（旧版永驻不白屏），UI 角落弹精确 file:line:column 错误条
⑥ 回收        refCount→0 + 30s grace 复检 → draining → evicted：ModuleRegistry 摘除 + Scope.close(LIFO)
               + WeakRef 断言 GC 回收（I4）；idle-detach 30min / forceReap 24h 兜底（§3.1 三段防僵尸）
               前端：插件面板原地局部重挂，persist:"memory" atom 保留，persist:"storage" atom 走宿主去抖写
⑦ 报错保护    编译/首屏报错保留上一版运行中的旧修订、旧面板与旧服务——主进程不崩、面板不白屏
```

---

## 第 8 章 · 四大第一方内置插件详细开发规格（v0.1-lite 实战交付件）

> 每个插件 = `plugins/<id>/` 目录：`bytedock-plugin.json`（Manifest）+ `shared/`（纯 TS 契约）+ `server/index.ts` + `client/index.tsx`。全部 `trust:"builtin"`、同进程 `CloseableScope` 轨（ADR-02）。验收标准 = 可机验断言清单，直接进第 10 章矩阵。

### 8.1 `plugins/plugin-egress-guard`（信任头条）

**Manifest**：

```jsonc
{
  "id": "builtin.egress-guard",
  "execution": "trusted-worker", // 第一方内置 = 同进程 CloseableScope 轨（ADR-02 v0.1 唯一服务端轨）
  "trust": "builtin",
  "permissions": {
    "networkHosts": ["**"], // 本插件自身是策略消费方，白名单覆写经通道 ③ 热生效
    "secretNamespaces": ["bytedock.egress"],
  },
  "hooks": [
    { "name": "egress.request.before", "onError": "deny", "timeoutMs": 2000 }, // 安全类 fail-closed
    { "name": "worktree.create.before", "onError": "deny" },
  ],
}
```

**服务端逻辑**（`server/index.ts`）：`ctx.http.route("POST", "/report", …)` 接收 kernel `GuardDispatcher` 拦截事件（同进程直调，不走 wire）；维护 `EgressProof` 双段 runner（§5.3）：活宿主 60s 归因探针（loopback/pipe 证明式排除）+ 独立离线全禁探针子进程（空白名单环境 spawn 隔离进程跑 `http.get`/`net.connect`/`fetch` 三探针，断言零外部字节）；审计写 `~/.bytedock/audit/egress-audit.jsonl`（hash-chained，64MB 轮转三态）；`strict` 配置走 `ctx.config` ReadableSignal 热切换（UI 类即时 / 行为类下 Session 生效）。

**客户端逻辑**：`dockPanel`（v0.1 挂现有右栏 Tab，容器接口定型）= `Stack → Row(Badge 拦截计数, Button 清空) + Card(kpi:[blocked, allowed, uncovered-native 计数, proof 最近 verdict]) + StreamLog(sink="egress-audit-log", columns=[time,host,verdict,pluginId,origin])`；`statusBarItem` = 紧凑盾形状态（绿/黄/red-broken）；`timelineRenderer`（match kind `plugin-card` 且 `payload.host` 存在）= 拦截事件卡。

**验收标准**：

1. `EgressProof` 双段 runner 全绿（含 60s 归因不变量）；
2. 三句诚实口径文案逐字出现在面板与 README 安全页（§5.4，CI 文案门禁比对）；
3. `uncovered-native`（N-API addon）与 `kind:"pipe"` 在面板 KPI 独立计数、不混入 L1 拦截数；
4. 攻防电池（第 10 章矩阵 3）全过。

### 8.2 `plugins/plugin-token-optimizer`（双轨 CacheGuard + Context X-Ray）

**Manifest**：

```jsonc
{
  "id": "builtin.token-optimizer",
  "execution": "trusted-worker",
  "trust": "builtin",
  "hooks": [
    { "name": "agent.open.before", "onError": "pass", "timeoutMs": 2000 },
    { "name": "agent.turn.before", "onError": "pass" }, // 热路径：全插件总额 500ms 预算
    { "name": "agent.compact.before", "onError": "pass", "timeoutMs": 2000 },
    { "name": "agent.tool.after", "onError": "pass" },
  ],
  "contributes": {
    "statusBarItems": [{ "id": "ttft-tps-cache" }],
    "timelineRenderers": [{ "id": "xray-bill", "matchType": "plugin-card" }],
  },
  "permissions": { "storage": "isolated-sqlite" }, // X-Ray 账单明细 >64KB 走独立 DB
}
```

**服务端逻辑**（双轨 `AdapterCacheProfile` 路由，ADR-06 六铁律全量实现）：

- **无状态 API 轨**：`open.before` 前缀钉死（`stablePrefixBlocks` 确定性排序 + hash）→ `OpenContribution`；复用既有 `MCP_TOOL_EXPOSURE_HEADER: deferred + tool_search`（绝不每 Turn 裁表）；`turn.before` 仅追加 `TurnContextContribution.appendContext`（防失忆清单）；`compact.before` 唯一前缀重置点 + `handoffSummary`；`tool.after` 打 `artifactRef` 溢出标记原文落盘 `~/.bytedock/artifacts/<threadId>/`，历史替换延迟到 Turn 边界（铁律⑤）；CI 稳态 `cachedInput >= 90%` 门禁。
- **有状态 CLI/ACP 轨**：`open-params` 钉制 + `payload-wrap` 追加通道（`outboundUserText` 双字段，§3.4 R3 2.2）；仅原生 `/compact`（无原生命令则关闭宿主压缩，不虚标）；宿主层确定性不变量验证；X-Ray 标 `opaque`（铁律⑥：永不伪造 Provider 缓存指标）。
- **model/provider 中途切换**：`ProfileShiftEvent`（profileKey 5 位 hash 变化 = expected reset）→ 旧会话 close + 新 profile 全量重开 + X-Ray 记 `"profile-shift re-open"`，违规计数排除。

**客户端逻辑**：`statusBarItem` = `TTFT · tok/s · 缓存%` 三值紧凑条（`StreamLog` 增量更新，不走全树）；`timelineRenderer` = Context X-Ray 账单卡（`Card(kpi:[cachedInput%, 估算节省, 状态 measured/native/opaque])`，`opaque` 态灰显不虚标）；账单明细 >64KB 落 `isolated-sqlite`（`~/.bytedock/plugins-data/builtin.token-optimizer.sqlite`）。

**验收标准**：API 轨 Replay Fixture 稳态 `>=90%`；CLI 轨宿主不变量全 true + `outboundUserText` 零投影污染（`/compact` 判定免疫机验）；mid-thread model switch → 0 violation + 1 `ProfileShiftEvent`。

### 8.3 `plugins/plugin-bots-core` + `plugins/channel-napcat-qq`（Week 7–8 爆点，含完整安全样板 Manifest）

**`plugin-bots-core`**（Bot 大脑）：

```jsonc
{
  "id": "builtin.bots-core",
  "execution": "trusted-worker",
  "trust": "builtin",
  "hooks": [
    { "name": "agent.turn.before", "onError": "pass" }, // SOUL.md 前缀 + MEMORY.md 追加注入
    { "name": "agent.compact.before", "onError": "pass" }, // MEMORY.md 防失忆保留清单
  ],
  "contributes": {
    "dockPanels": [{ "id": "bots-manager" }],
    "commands": [{ "id": "bot.new" }],
  },
  "permissions": { "storage": "isolated-sqlite" }, // MEMORY.md 结构化索引
}
```

**服务端逻辑**：Bot = 自有订阅上的 Thread 实例（零额外 Provider 计费）；`SOUL.md`（人格与职责）经 `turn.before` 稳定前缀注入（CacheGuard 铁律①：进 `stablePrefixBlocks`，确定性排序，绝不击穿缓存）；`MEMORY.md`（人类可审阅长期记忆）**只追加**（turn 边界经 `agent.compact.before` 保留清单 + `agent.tool.after` 里程碑追加），结构化索引落 isolated-sqlite；触发源 SPI = IM `@bot`（经 `channels` SPI 接 `channel-napcat-qq`）/ Cron（`ctx.schedule`，接缝 15）/ Webhook / PR / CI 失败；遇分歧 → **Decision Gate 经宿主 outbox 三端可达**（接缝 16，Web/Desktop/Mobile v0.1 只读），审批结果回注 Thread。

**`channel-napcat-qq`**（完整安全样板 Manifest，其余通道抄此格式）：

```jsonc
{
  "id": "community.napcat-qq",
  "execution": "trusted-worker",
  "trust": "local-dev",
  "permissions": {
    "secretNamespaces": ["bytedock.napcat"], // token 只经 secretRef 引用，manifest 零明文
    "networkHosts": ["127.0.0.1", "localhost"], // NapCat loopback 直连；出站进 Egress L1 loopback 全审计
  },
  "hooks": [{ "name": "egress.request.before", "onError": "deny" }],
  "contributes": {
    "webhooks": [
      {
        "route": "/api/plugins/community.napcat-qq/onebot/event",
        "auth": "token", // 强制 Bearer：NapCat 端 Authorization 头配 secretRef 同源值
        "tokenSecretRef": "bytedock.napcat.webhook_token",
        "hmac": { "algorithm": "sha1", "mode": "onebot-custom", "rawBody": true },
        "replayDefense": { "requireMonotonicSeq": true, "windowSeconds": 300 }, // OneBot v11 post 无时间戳时取服务端接收序
        "rateLimitPerMin": 50, // ADR-08 默认 50/min 逐路由可覆写
        "frameOptions": "DENY", // X-Frame-Options 默认，不可声明放开
      },
    ],
  },
}
```

**攻防要点（写进样板注释，CI lint 执行）**：① `auth:"none"` 仅允许「路由无任何业务载荷 + 纯健康探测」两类，CI lint 对其余 `none` 路由直接红灯；② HMAC-SHA1（NapCat 自定义模式）验签**必须用 raw body**（express/undici 层先缓存 rawBuffer 再 parse——canonicalization 不一致是 OneBot 生态最常见验签绕过姿势）；③ `replayDefense`：OneBot v11 post 无时间戳时以服务端单调接收序做 300s 重放窗口；④ 用户把 NapCat 暴露公网时，入站 webhook 走宿主 8080 由 L3 硬模式兜底——manifest 注释明示「暴露公网请开 L3 硬模式」，不把入口安全承诺写成默认值。

**`channel-napcat-qq` 服务端逻辑**：OneBot v11 客户端（loopback HTTP 直连 `127.0.0.1`）；`@bot` 消息 → 经 `channels` SPI 路由到 `plugin-bots-core` 对应 Bot Thread（`SOUL.md`/`MEMORY.md` 注入）→ 回复回 QQ；Cron 触发 = `ctx.schedule`（接缝 15）；Decision Gate 三端可达 = 宿主 outbox（接缝 16）。

**验收标准**：10 扩展点端到端冒烟（第 10 章矩阵 6 脚本定义）：Manifest 校验 ✓ / 4 钩子触发 ✓ / `channels` SPI ✓ / `ctx.schedule` Cron ✓ / outbox 三端（Web+Desktop+Mobile 只读）✓ / 4 元 RPC（`plugins.list`/`reload`/`invoke`/`subscribe`）✓ / `timelineRenderer` 审批卡 ✓ / `statusBarItem` ✓ / `dockPanel` Bot 管理 ✓ / `settingsSection` ✓。

### 8.4 `plugins/plugin-upstream-radar`（0 号自举插件，挂载接缝 15）

**Manifest**：`ctx.schedule()` 定时任务 + `isolated-sqlite`（`normalized-diff%` 漂移序列）+ `upstream-ledger.jsonl`（hash-chained append-only，幂等键 `prSha`）。

**Stage 1 前置零遥测门禁（D 类自动降级，与 EgressGuard 共享 `scripts/egress-denied-domains.json` 禁用域名字段真源）**：

```text
定时拉取 pingdotgg/t3code 新合入 PR（对照 upstream-ledger.jsonl 水位线去重，prSha 幂等）
   │ 低成本快速模型分类（0 Token 确定性脚本先行：diff stat + 文件路径 + 敏感词正则）
   ▼
Stage 1 门禁：命中 posthog/sentry/clerk/非授权读 ~/.claude.json → 自动 D 类 skipped
   （拒绝理由写台账，永不进 A 类移植队列，永不重复打扰——零遥测承诺在源头守住）
   ▼
A 类（内核修复/并发竞态/性能/安全/Mobile 同步）→ 两条合法吸收路径按成本二选一：
   ① 无冲突直接单 PR cherry-pick（连同原测试，derivation:"cherry-pick"）；
   ② 涉及已分叉区域或上游写法过重时，**只同步问题根因与核心思路，由 AI 按 ByteDock 架构原生重写一版 + 补等价回归测试**（台账记 derivation:"idea-sync" + 人工拍板）
B 类（Provider/SourceControl/Issue/Secret 适配）→ 隔离度极高，可直接同步或按思路适配 + 回放夹具测试
C 类（新垂直功能）→ 一页《价值与插件化评估卡》推 UI/Bot；确认 → **只吸取核心思路，由 AI 开发为 ByteDock 独立插件（plugins/plugin-*）**，绝不照抄硬塞内核（derivation:"idea-sync" / "plugin"）
D 类（遥测/官方品牌/被超越功能）→ skipped + 拒绝理由入台账
每周期 reconciliation：已移植项定向回归全绿复验 + normalized-diff% 漂移周报（>8% 告警，manual 接缝 >3%）
```

**Stage 1 → Stage 2 解锁门禁**：Stage 1 连续人工校验分类准确率达标（人工抽检 3 轮 100%）才开 Stage 2（独立 worktree 自动移植 + 一键审批卡）；Dockview 换壳必须排在 A/B 类流水线跑通至少一轮实战之后（V1 不变量）。

**验收标准**：`upstream-ledger.jsonl` 幂等（同 `prSha` 重放零消费）；D 类门禁在 Stage 1 拦截率 100%（回归 fixture 含 3 条 PostHog/Sentry/Clerk 样本）；漂移周报可机读。

---

## 第 9 章 · Week 1–8 详细研发执行流程与任务卡（可直接拆 Git Issue / Sprint）

> 每张卡 = 目标 / 前置依赖 / 涉及文件·包 / 核心实现动作 / 必须通过的 CI·验证命令 / 本周可演示里程碑。Go/No-Go 门禁含 R3 三个早期熔断探针（W1 即验证）。

### Week 1–2 · 品牌独立 + 插件底座 v0 + CI 一次过基建

| 卡                                                                  | 目标                                                                        | 前置 | 涉及文件/包                                                                               | 核心动作                                                                                                                                                                                           | 必须通过的验证                                                                                                                         | 里程碑                                                                 |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| W1-1 品牌切换                                                       | ByteDock 去 T3 化落盘                                                       | 无   | 全仓文案/图标/AUMID/目录                                                                  | 显示名·图标·`bytedock://`·`~/.bytedock` 隔离·只读导入向导（不改 `~/.t3/userdata`）·更新源切正式组织                                                                                                | `vp run typecheck` + 禁遥测静态检测（posthog/sentry/clerk 0 命中）                                                                     | 应用名/窗口/图标全 ByteDock                                            |
| W1-2 **熔断探针 ①**：`vm.compileFunction` × `Effect.Layer` 构建时序 | 证明方案 α 在真实宿主启动序列可装载                                         | W1-1 | `packages/plugin-kernel/src/hostModules.ts` + `compiler.ts` 骨架                          | 最小插件（`export default { activate(ctx){ return Effect.succeed("ok") } }`）经 esbuild CJS + `vm.compileFunction` + `HostModuleRegistry` 注入，宿主 Layer 构建后装载；boot `Context.Tag` 单例探针 | 探针断言 `pluginRequire("effect").Context.Tag === 宿主 Context.Tag` 通过；四形态（dev / `vp pack` 产物 / Electron / SEA 骨架）各跑一次 | **α 不可行 → 立即 No-Go 回炉**（R3 No-Go 触发器 ①）                    |
| W1-3 接缝 W1 批                                                     | 切开 1/2/3/4/10/15/16                                                       | W1-2 | §4.1 卡 1/2/3/4/10/15/16 + `seam-ledger.json` + `scripts/check-seams.ts` + fixture 三件套 | 12 台账条目 + 双 tag + `check:seams` 并入 `check:changed`                                                                                                                                          | `vp run check:seams` 三 fixture 绿/红/绿；knip 4 workspace + schema 断言绿                                                             | 4 元 RPC 可 `plugins.list` 空列表往返                                  |
| W1-4 **熔断探针 ②**：`Card.kpi` 表达力                              | 证明 12 原语封板无洞                                                        | W1-3 | `apps/web/src/components/plugin/` 12 组件 + `Card.kpi`                                    | 用 `Card(kpi:[4 项])` 复现 `plugin-usage-hub` 4 卡 KPI 场景（v0.2 场景预演）                                                                                                                       | 视觉评审：4 卡布局无需独立 `StatRow` 语义                                                                                              | **不足 → No-Go 触发器 ② 回炉**（v0.2 原语扩容 ADR，v0.1 冻结 12 不动） |
| W1-5 内核契约落盘                                                   | 5 契约编译通过                                                              | W1-3 | §3 全部 5 文件                                                                            | `revision.ts`/`sessionGate.ts`/`hostModules.ts`/`bridge.ts`/`cacheGuard.ts`/`protocol.ts` 建文件                                                                                                   | `vp run typecheck` 全绿；`fuzz` 靶心 1 脚手架（1000 事件交织，断言 I1–I5）可跑                                                         | 契约 + fuzz 骨架进仓                                                   |
| W1-6 四格存储                                                       | `plugin_kv` + CAS + JSONL                                                   | W1-5 | Migration #126 + `plugins.yml` 写 lane + 审计轮转                                         | §7.1 全部 DDL/CAS/hash-chain 落地                                                                                                                                                                  | 单测：64KB 超限报错不截断 / CAS 冲突用户赢 / 轮转三态 / WAL 锁交叉自检                                                                 | 存储层机验全绿                                                         |
| W1-7 **熔断探针 ③**：`check-seams.ts` 柔性守卫零误报                | 接缝 5/6/7/8 锚点无格式化假红灯，且显式 `idea-sync`/`diverged` 演进不被卡死 | W1-3 | `scripts/check-seams.ts` + 4 个 `manual` 接缝 dry-diff + 4 件套 fixture                   | 在 5/6/7/8 四个文件跑 prettier/import-sort dry-diff，并验 `explicit-idea-sync` 放行路径                                                                                                            | 块内缩进 → 绿；无意改未 tag 上游行 → 红；显式登记 `idea-sync`/`diverged` → 绿                                                          | **无法消除的假红灯 → No-Go 触发器 ③ 换行级 diff 方案回炉**             |
| W1-8 Radar Stage 1 启动                                             | 0 号插件只读巡检                                                            | W1-3 | `plugins/plugin-upstream-radar/`                                                          | Stage 1 日报 + D 类门禁 + `upstream-ledger.jsonl`                                                                                                                                                  | 首份日报 + 3 条 D 类 fixture 全拦                                                                                                      | Radar 首次日报可见                                                     |

**W1–2 出口门禁（Go/No-Go）**：三探针全过 + `check:changed` 全量绿 + 接缝 W1 批 7 卡全部入台账 + α 装载器四形态单测通过。任一 No-Go 触发器命中 → 停线回炉，不进 Week 3。

### Week 3–4 · `plugin-egress-guard` 完整首秀 + 无泄漏热重载 MVP

| 卡                     | 目标                            | 前置    | 涉及文件/包                                             | 核心动作                                                                                                                                                                                         | 必须通过的验证                                                                                                                   | 里程碑                                   |
| ---------------------- | ------------------------------- | ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| W3-1 接缝 6/7 切开     | 两阶段 Open + Turn/Compact 贡献 | W1 出口 | §4.1 卡 6/7                                             | `ThreadSessionGate` 临界区 + `frozenAt`/`graceRemainingMs` 落 `plugin_kv`                                                                                                                        | fuzz 靶心 1 全量 1000 次交织（I1–I5 + `WeakRef` GC + 休眠唤醒校准）；`/compact` 判定行 diff = 0                                  | Open 链路 e2e：pin 写盘 + 前缀钉制可观测 |
| W3-2 接缝 8 切开       | Egress Guard L1 挂载            | W3-1    | §4.1 卡 8 + `packages/plugin-kernel/src/egressGuard.ts` | Dispatcher 双闸 + 双层 DNS + UDP 拒 + Chromium `setProxy`（`bypassRules` 置空）                                                                                                                  | §10 矩阵 3 攻防电池（AsyncLocalStorage 防递归 / 活宿主 60s 归因零自断 / 离线全禁探针 / SSRF DNS Rebinding / Windows EBUSY 退避） | 拦截实时可见于宿主日志                   |
| W3-3 热重载 MVP        | 方案 α 全链路                   | W3-1    | §7.3 七步时序                                           | watcher → debounce/hash 幂等 → Sucrase/fork esbuild → 白名单拒载 → `compileFunction` + boot 探针 → install&freeze → refCount→0 + 30s grace 复检 → `Scope.close` + Registry 摘除 + `WeakRef` 断言 | 报错改代码：旧版永驻不白屏 + 错误条精确 `file:line:column`（sourcemap 还原）；GC 断言过                                          | 保存 → 500ms 热重载可见                  |
| W3-4 egress-guard 插件 | 面板 + X-Ray 三态 + 诚实口径    | W3-2    | `plugins/plugin-egress-guard/`                          | §8.1 全部                                                                                                                                                                                        | `EgressProof` 双段全绿 + 三句文案门禁                                                                                            | 审计面板可交互                           |

**W3–4 出口门禁**：矩阵 3 全绿 + 热重载 fuzz（1000 次 reload × 并发 pin/unpin 无泄漏）+ `EgressProof` 双段 `pass`。

### Week 5–6 · 双轨 CacheGuard `plugin-token-optimizer`

| 卡                   | 目标         | 前置    | 涉及文件/包                          | 核心动作                                                                                                    | 必须通过的验证                                                                                                                                          | 里程碑             |
| -------------------- | ------------ | ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| W5-1 接缝 5 切开     | MCP 动态桥   | W3 出口 | §4.1 卡 5                            | per-`providerSessionId` `list_changed` 延迟队列 + deferred `tool_search` 复用                               | 多会话并发 fixture：会话 A 边界 flush 不影响会话 B turn 内冻结（0 跨会话快照失效）                                                                      | 动态工具热增删可测 |
| W5-2 双轨 CacheGuard | 六铁律全实现 | W5-1    | `plugins/plugin-token-optimizer/`    | §8.2：API 轨全量五铁律 / CLI 轨 `open-params` + `payload-wrap` + 原生 `/compact` / `ProfileShiftEvent` 重开 | Replay Fixture 矩阵（§10 矩阵 2）：API `>=90%` + CLI 宿主不变量 + `outboundUserText` 零污染投影 + mid-thread model switch（0 violation + 1 shift 事件） | X-Ray 账单首张可看 |
| W5-3 状态条 + 账单   | UI 落地      | W5-2    | 客户端 + `dockPanel`/`statusBarItem` | TTFT/TPS/Cache 状态条（`StreamLog` 增量）+ X-Ray 三态账单（`Card.kpi`，`opaque` 灰显）                      | CI 断言 `opaque` 轨 0 假指标；`isolated-sqlite` 账单表 DDL                                                                                              | 账单面板可演示     |

**W5–6 出口门禁**：矩阵 2 全绿 + 稳态 90% 门禁在 CI 常绿。

### Week 7–8 · NapCatQQ 本土 Bot 闭环 + 桌面发布

| 卡                      | 目标                                         | 前置                         | 涉及文件/包     | 核心动作                                                                                       | 必须通过的验证                                                                                                          | 里程碑                                                       |
| ----------------------- | -------------------------------------------- | ---------------------------- | --------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| W7-1 接缝 11 切开       | 4 Slot 前端                                  | W5 出口                      | §4.1 卡 11      | 4 Slot + 12 原语渲染器全链路                                                                   | React Compiler 100% / `gt-react` / Tailwind 静态扫描不破                                                                | 插件面板进真实 UI                                            |
| W7-2 bots-core + napcat | 首条本土 Bot 闭环                            | W7-1 + 工作区现成 `NapCatQQ` | §8.3 两插件     | 安全样板 Manifest 全文 + raw-body HMAC + 300s 重放窗 + 50/min 限速 + Cron + Decision Gate 三端 | Webhook 横向攻击电池（§10 矩阵 4：nonce 四条件 / 跨 iframe 重放 / `auth:none` lint 拒 / 429 限速）+ 10 扩展点端到端冒烟 | **30 秒 GIF：QQ @bot → 本地 Agent 干活 → Decision 卡三端弹** |
| W7-3 四形态打包         | dev / `vp pack` / Electron 44 Win / SEA 冒烟 | W7-2                         | 第 2 章 §④ 全部 | `ESBUILD_BINARY_PATH` / `asarUnpack` / `ELECTRON_RUN_AS_NODE=1` / Defender 引导 + 退避重试     | §10 矩阵 5 统一冒烟（`Context.Tag` 单例探针四形态各一次）                                                               | Win `.exe`/`.msi` + macOS `.dmg` 出包                        |
| W7-4 公测上线           | `byte.didyou.eat` + 发布清单                 | W7-3                         | 站点 + 清单     | 头条 = `EgressProof` + X-Ray + QQ GIF；发布清单（§10.3）逐项过                                 | 矩阵 6 总冒烟脚本 + 发布清单全勾                                                                                        | **v0.1-lite 公测**                                           |

**Week 7–8 爆点终裁（ADR-12）执行确认**：1 条 `NapCatQQ` 闭环 = 零新增上游冲突文件（接缝 11 仅 4 Slot）+ 一次端到端实证 10 扩展点 + 首周 30 秒 GIF 传播力。Dockview **不在本周**（v0.2，V1 不变量）。

---

## 第 10 章 · 测试验收矩阵、红队回归脚本清单与上线发布检查表

### 10.1 验证矩阵 1–5（每矩阵 = 脚本名 + 断言清单 + 触发时机）

**矩阵 1 · 修订状态机 1000 次随机事件交织 Fuzz**（`fuzz/revision-fuzz.test.ts`，W1-5 脚手架 → W3-1 全量，CI 每夜 + 手动）

- 随机事件流（1000 轮）：`openSession / runTurn / unpin(idle-detach) / reload / forceReap / 休眠唤醒` 按泊松节奏交织
- 断言 I1–I5 逐事件检查；`frozenAt` 锚点回归（`drainDeadline` 不得早于 `frozenAt`）；`WeakRef(oldEntry).deref() === undefined`（evict 后 GC）；休眠唤醒校准（单调钟跳变 8h 场景 pin 恢复非 stale）；`drainInFlightMs` 超时强切 → `aborted-revision-evicted` + `inFlightAtEvict` 非空

**矩阵 2 · 双轨 CacheGuard Replay Fixture**（`fuzz/cache-guard-replay/`，W5-2 起 CI 常绿）

- **API 轨**：稳态 20 turn fixture，断言 `cachedInput/(cachedInput+input+cacheCreation) >= 0.90`；前缀突变 fixture → 恰好 1 `PrefixImmutabilityViolation`
- **CLI/ACP 轨**：宿主不变量（`prefixHashStable`/`mcpSnapshotStable`/`contributionInBounds` 全 true）+ `outboundUserText` 零污染投影（`ProjectionStore` payload hash 逐 turn = ingestion 原文 hash）+ `/compact` 判定免疫（wrap 串含 `/compact` 关键词不绕过）
- **mid-thread model switch**（3 类 case）：`stateless-api → stateful-cli` 切换 → 断言 0 violation + 1 `ProfileShiftEvent` + 两侧宿主不变量全 true + X-Ray 记 `"profile-shift re-open"`

**矩阵 3 · Egress Guard 攻防回归**（`fuzz/egress-battery/`，W3-2 起 + 每次宿主网络代码触碰即跑）

- `AsyncLocalStorage` 防递归（guard 白名单 lookup 零自锁）
- 活宿主 60s 归因不变量（零自断：归因探针自身 loopback 被证明式排除）
- 独立离线全禁探针（空白名单环境三探针零外部字节）
- SSRF DNS Rebinding fixture（白名单域名解析到 `127.0.0.1` → connect 层 c 步拒）
- Windows `EBUSY`/`EPERM` 退避重试（200/400/800ms 三次 + `stale-write` 不崩）
- 双栈 `{all:true}` 半放行拒绝（任一私网 IP → 全拒 fixture）

**矩阵 4 · `PluginSandboxFrame` & NapCat Webhook 横向攻击电池**（`fuzz/sandbox-webhook-battery/`，W7-2 起）

- nonce 四条件（`origin==="null"` / `source` 同一 / nonce 匹配 / 类型封闭枚举——任一缺失即拒）
- 跨 iframe 源伪造 + nonce 重放（unmount 后 nonce 作废 fixture）
- URL/Referer nonce 泄漏检查（nonce 永不出现在 `location`/`document.referrer`/日志）
- `allow-forms` 回归 lint（`sandbox` 属性扫描，`allow-forms` 出现即红灯）
- `auth:"none"` 非纯健康路由 CI lint 拒 + raw-body HMAC canonicalization 绕过 fixture（body 先 parse 再算签 = 拒）+ 300s 重放窗口拒 + 429 限速（50/min 越限）

**矩阵 5 · 四形态统一冒烟**（`scripts/smoke-four-forms.ts`，W7-3 起，发布前必跑）

- 每形态各一次：dev（`vp run`）/ `vp pack` / Electron 44 Windows 打包 / Node SEA
- 断言：`Context.Tag` 单例探针（`effect` 宿主实例 === 插件 `require("effect")` 实例）/ `ESBUILD_BINARY_PATH` spawn 成功 / `@parcel/watcher` `asarUnpack` 二进制存在且可监听 / 插件 `reload` 一轮无泄漏（`WeakRef` 断言）/ `ELECTRON_RUN_AS_NODE=1` fork 编译子进程正常退出

### 10.2 矩阵 6 · Week 7–8 NapCatQQ Bot 10 扩展点端到端总冒烟脚本（`scripts/smoke-napcat-e2e.ts`）

```text
前置：本机 NapCatQQ OneBot v11 实例（loopback 127.0.0.1，工作区现成）+ 测试 QQ 号
 1. 安装与 Manifest 校验：bytedock plugin install plugins/channel-napcat-qq + plugins/plugin-bots-core
    → bytedock-plugin.json Schema 全绿（auth/hmac/replayDefense/rateLimit 字段齐全）
 2. Bot 创建：QQ 群 @bot 触发 → plugin-bots-core 建 Thread + SOUL.md 前缀注入（X-Ray 记 open 前缀 hash）
 3. 回复链路：bot 回复经 NapCat 回到 QQ 群（截图存证）
 4. MEMORY.md：连续 3 turn 后 MEMORY.md 追加可见（人类可读 diff）
 5. Cron：ctx.schedule 1min 触发 bot 自检任务（接缝 15 消费）
 6. Decision Gate：bot 遇分歧 → outbox 通知三端（Web 可见 / Desktop 托盘可见 / Mobile v0.1 只读 outbox 可见）
 7. 4 元 RPC：plugins.list（含 4 插件）/ plugins.reload（热重载 bot 插件，旧修订冻结回收）/
    plugins.invoke（namespace 白名单 + broker 鉴权，互调尝试必拒）/ plugins.subscribe（since(cursor) 断线补发）
 8. 安全样板：webhook token 缺失 → 401；HMAC 错序（先 parse 后算签）→ 拒；重放 seq → 拒；51/min → 429
 9. Egress：NapCat loopback 出站全量进 L1 审计；egress-audit.jsonl 链条 verified
10. 卸载干净：bytedock plugin uninstall → plugin_kv DELETE / isolated-sqlite orphan 标记 / outbox 退订 / 无残留连接
通过 = 10 步全绿，存证 GIF 30s（公测头条素材）
```

### 10.3 `byte.didyou.eat` 公测上线发布检查表

```text
□ 品牌门禁：全仓 T3 字样/Logo 0 残留；README 独立声明；更新源指向 bytedock 组织
□ 禁遥测门禁：posthog/sentry/clerk 0 命中；~/.claude.json 等外部 CLI 认证文件 0 读取
□ EgressProof 双段 pass（当版本）+ 审计链 verified + 三句诚实口径文案逐字在线
□ 矩阵 1–5 全绿（当 commit）+ 矩阵 6 10/10
□ 四形态打包产物哈希 + Defender 排除引导脚本 + NSIS 文件数回归（对比 β 未复活：effect 内联）
□ 数据目录隔离：~/.bytedock 全新可启（零 ~/.t3 依赖）；导入向导只读
□ 发布物：Win .exe/.msi（关窗托盘）+ macOS .dmg + npm bytedock 占位 + 站点（头条 = EgressProof + X-Ray + 30s GIF）
□ 回滚预案：插件全部可卸载干净（矩阵 6 第 10 步即回归）；接缝双 tag diff 可整块 revert（16 文件 ~585 行）
```

---

_蓝图完。本文档三大硬不变量（V1 时间窗口 / V2 12 接缝 / V3 12 原语 + 方案 α）在全部 10 章交叉引用中保持一致；12/12 ADR 终态与 R3 封板结论逐条落位（§1.3 速查表）；Week 1 三个 No-Go 熔断探针（§9 W1-2/W1-4/W1-7）为动工首日即验项。任何实现层发现需推翻已锁 ADR 的情形，触发 R3 文末 No-Go 条款回炉，不得在实现中私自变通。_

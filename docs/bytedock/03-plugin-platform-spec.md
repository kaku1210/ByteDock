# 03 · ByteDock 融合版插件底座完整技术规格（Orca × Paseo 精华）

> 本规格深度融合了 **Orca (`stablyai/orca`)** 与 **Paseo (`getpaseo/paseo`)** 的一手源码拆解成果，并与 `t3code` 现有 Effect-TS 4 / React Compiler / React Native 技术栈精确对齐。

---

## 一、包拓扑与目录强边界规范

### 1. 新增 3 个内核基础包

```text
packages/
  plugin-sdk/           # @bytedock/plugin-sdk：纯契约、Effect Schema 助手、声明式 TSX UI 原语（浏览器/RN/Node 通用）
  plugin-kernel/        # @bytedock/plugin-kernel：宿主运行时（Manifest 校验、Scope/子进程双轨执行、Hook 管线、热重载编译器、RPC/MCP/HTTP 路由器）
  plugin-ui-renderer/   # @bytedock/plugin-ui-renderer：JSON 组件树宿主渲染器（web/shadcn 实现 + mobile/RN 实现 + iframe 沙箱桥）
plugins/                # 第一方内置旗舰插件源码（编译期可打包，开发态同样支持热重载）
~/.bytedock/plugins/    # 用户安装或 AI Creator Mode 现场生成的外部运行时插件目录
~/.bytedock/plugins.yml # 场景化 Profile 与插件开关/配置覆写
```

### 2. 单个插件的目录边界（吸 Paseo `compiler-build.ts` 编译期强隔离）

```text
my-plugin/
  bytedock-plugin.json  # 清单、执行层级与最小权限声明
  shared/               # 纯 TS + Effect Schema（RPC Contract、共享类型）；server/ 与 client/ 均可 import
  server/index.ts       # 服务端入口；编译 client 时严禁 import server/ 或 node:* 模块
  client/index.tsx      # 前端入口（声明式 TSX 或沙箱挂载）；严禁 import 服务端实现
  sandbox/index.html    # 可选：重交互画布（如 2D 工厂/看板）的隔离 iframe 入口
```

---

## 二、`bytedock-plugin.json` 与 4 级最小权限模型（吸 Orca 零信任分级）

```ts
// packages/plugin-sdk/src/manifest.ts
export type PluginExecutionTier =
  | "data" // 仅静态数据：主题、图标、字体(WOFF/WOFF2 验魔数)、语言包、角色模板、工作区配方
  | "declarative" // 声明式配置：MCP Server 声明、快捷键、Slash 模板、命令别名
  | "sandboxed-ui" // 声明式 TSX（隔离转译输出 JSON 组件树）或断网沙箱 iframe
  | "trusted-worker"; // 完整服务端代码（内置插件走 Effect CloseableScope；第三方走独立子进程）

export type PluginHookName =
  | "agent.open.before" // ★总杠杆（2000ms 预算）：Session 打开前钉制 env / RoleProfile / 稳定前缀块 / deferred MCP 暴露策略
  | "agent.turn.before" // ★回合前（全插件总预算 500ms）：仅许返回追加式 TurnContextContribution，严禁修改缓存前缀
  | "agent.compact.before" // 压缩前（2000ms 预算）：允许重置前缀，注入防失忆保留清单、HANDOFF 与活跃子任务索引
  | "agent.tool.before" // 工具执行前（热路径）：权限护栏、共享工作树写锁检查（支持 per-plugin fail-closed）
  | "agent.tool.after" // ★工具返回后：仅对大输出打 artifactRef 标记并原文落盘；历史替换延迟到 Turn 边界执行
  | "egress.request.before" // ★全局出站 HTTP/Socket 拦截：Egress Guard 白名单与审计日志
  | "worktree.create.before"; // 工作树创建前：审批门禁、共享 node_modules 或切换 jj workspace

export interface TurnContextContribution {
  /** 渲染在 Prompt Cache 边界之后，保证不击穿前缀缓存 */
  readonly appendContext?: string;
  /** 仅允许在显式缓存重置场景（如 compact）声明，UI 可审计 */
  readonly forceCacheReset?: { readonly reason: string };
}

export interface ByteDockPluginManifest {
  readonly id: string; // e.g. "builtin.egress-guard" | "community.napcat-bot"
  readonly name: string;
  readonly version: string;
  readonly apiVersion: "^1.0.0";
  readonly execution: PluginExecutionTier;
  readonly trust: "builtin" | "local-dev" | "community";
  readonly entry?: {
    readonly server?: string; // "server/index.ts"
    readonly client?: string; // "client/index.tsx"
    readonly sandboxHtml?: string; // "sandbox/index.html"
  };
  readonly permissions: {
    // 复用现有 packages/contracts/src/auth.ts 的 AuthEnvironmentScope
    readonly rpcScopes?: ReadonlyArray<AuthEnvironmentScope>;
    // 网络出站白名单（配合 Egress Guard，未声明域名一律拦截）
    readonly networkHosts?: ReadonlyArray<string>;
    // 仅允许读取显式授权的 secret 命名空间，禁止触碰宿主或其他 CLI 凭证文件
    readonly secretNamespaces?: ReadonlyArray<string>;
    // 存储策略：严禁修改主库 statev2.sqlite 核心表
    readonly storage?: "none" | "kv" | "isolated-sqlite";
    // 钩子声明与失败策略（安全类必须声明 onError: "deny" 即 fail-closed）
    readonly hooks?: ReadonlyArray<{
      readonly name: PluginHookName;
      readonly onError: "pass" | "deny";
      readonly timeoutMs?: number; // 默认 2000ms
    }>;
  };
  readonly contributes?: {
    readonly panels?: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly icon: string;
      readonly mode: "declarative" | "sandbox-iframe" | "native";
      readonly defaultArea?: "right" | "bottom" | "tab";
    }>;
    readonly settingsSection?: {
      readonly id: string;
      readonly title: string;
      readonly group: string;
      readonly icon: string;
    };
    readonly sidebarViews?: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly icon: string;
    }>;
    readonly statusBarItems?: ReadonlyArray<{
      readonly id: string;
      readonly align: "left" | "right";
      readonly priority?: number;
    }>;
    readonly composerItems?: ReadonlyArray<{
      readonly id: string;
      readonly placement: "toolbar" | "banner" | "pill";
    }>;
    readonly timelineRenderers?: ReadonlyArray<{ readonly id: string; readonly matchType: string }>;
    readonly commands?: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly shortcut?: string;
      readonly replaces?: string;
    }>;
    readonly mcpServers?: ReadonlyArray<{
      readonly id: string;
      readonly transport: "stdio" | "http";
    }>;
  };
}
```

---

## 三、服务端运行时：同契约双轨 + Revision Pinning（R1 结构修订）

### 1. 同契约、非同构双轨模型（修正 F1）

- **核心边界**：Effect `Effect/Stream/Scope/ReadableSignal` 不可跨进程序列化，因此双轨不是“接口同构”，而是**「同一份可序列化 Effect Schema 契约（`PluginWorkerBridge`）的两种传输实现」**：
  - **同进程轨（v0.1/v0.2 唯一落地的服务端轨，`trust: "builtin" | "local-dev"`）**：每插件分配独立 `Scope.CloseableScope`，通过 `Layer.buildWithScope(...)` 挂载并直调宿主服务，零 IPC 延迟。
  - **子进程隔离轨（v0.3 开放社区 `trusted-worker`）**：运行于独立已编译 CJS 子进程（Electron 打包下 `ELECTRON_RUN_AS_NODE=1`），经显式 `PluginRemoteContext` JSON 帧协议消费同一份 Schema 契约。

### 2. Revision Pinning：热重载与在跑 Agent Turn 的优雅交接（修正 F2）

- 严禁热重载时立刻 `Scope.close(oldScope)` 撕裂在跑 Session 的 MCP 工具、钩子和 Compactor：

```ts
// packages/plugin-kernel/src/revision.ts
export interface PluginRevision {
  readonly rev: number; // 单调递增修订号
  readonly scope: Scope.CloseableScope; // 本修订挂载的全部插件 Scope
  readonly manifests: ReadonlyArray<ByteDockPluginManifest>;
  readonly refCount: () => number; // 钉住本修订的活跃 Provider Session 数量
  readonly frozen: boolean; // 冻结后不再接受新 Session 钉住
}
```

- **交接与防泄漏完整状态机（R2 补全，详见 [09-final-architecture-and-dev-blueprint.md](./09-final-architecture-and-dev-blueprint.md)）**：
  1. **两阶段 Open 与修订钉住**：接缝 6 拆为 `prepareMcpSession` 前/后两阶段；打开 Session 时钉住当前 `active` 修订（写 `plugin_kv ns=pin`，`expires_at = pinnedAt + forceReapMs`，touch 节流续期 `<= 1 次/10min`）。
  2. **单 Lane 串行重载与保存风暴合并**：`reload` 经 `Semaphore(1)` 严格串行 + 500ms `coalesceMs` debounce + 文件 hash 幂等去重；新修订经 `effect` 单例探针校验就绪后才 `freeze` 旧修订，失败则旧修订永不冻结。
  3. **三段防僵尸回收**：① **Grace 复检**：`refCount -> 0` 后 30s 定时器到期复检 `refCount === 0` 才进 `evicted` → `Scope.close`；② **Idle Detach**：空闲超 `idleDetachMs`（默认 30min）自动脱落 pin（会话本体不杀，恢复时重钉 `active` 并复跑 `open.before`）；③ **Force-Reap 上限**：冻结超 `forceReapMs`（默认 24h，上限 72h）强制驱逐并将僵死会话标 `stale-revision`（后续动作返回响亮的类型化错误 `ProviderSessionLost("revision-evicted")`）；启动与每日定时跑 `pin` 对账清理。
  4. **四格存储与事务隔离**：严禁参与 `EventSink` 事务；严格划分 `plugins.yml`（CAS 单写者）/ `plugin_kv`（≤64KB、32MB 配额）/ `isolated-sqlite` / append-only JSONL（hash-chained 轮转三态）；配置经 `PluginConfigService` 三通道热推送。
  5. **鉴权、横向隔离与双轨 CacheGuard**：**v0.1 全面禁止插件互调**（caller 仅 `host-client`）；`plugins.invoke/subscribe` 强制命名空间白名单 + `PluginScopeBroker` 交集鉴权 + 五要素审计 JSONL；动态 HTTP webhook 逐路由声明 `auth: none|token|host-session` + 默认 50/min 限速 + `X-Frame-Options: DENY`；`sandbox-iframe` 强制 `sandbox="allow-scripts"`（无 `allow-same-origin`）+ 三条与 nonce 握手；CacheGuard 按 `AdapterCacheProfile` 区分 **无状态 API 轨**（全量五铁律 + CI `>=90%`）与 **有状态 CLI/ACP 轨**（`open-params` + `payload-wrap` + 仅原生 `/compact` + X-Ray 诚实标 `opaque`，新增 **铁律⑥：永不伪造缓存指标**）。

### 2. `PluginServerContext` 核心接口

```ts
// packages/plugin-sdk/src/server.ts
export interface PluginServerContext<TConfig = Record<string, unknown>> {
  readonly pluginId: string;
  // 配置修改后实时推给所有端与插件，免重载生效（吸 Paseo）
  readonly config: ReadableSignal<TConfig>;

  // 1. 生命周期拦截钩子（支持 priority、timeoutMs、onError: "pass" | "deny"）
  readonly hooks: {
    register<K extends PluginHookName>(
      name: K,
      handler: PluginHookHandler<K>,
      options?: { priority?: number; onError?: "pass" | "deny"; timeoutMs?: number },
    ): Effect.Effect<void, never, Scope.Scope>;
  };

  // 2. 只读领域事件流（直接桥接 MilestoneHub，随插件 Scope 自动退订）
  readonly events: {
    subscribe(
      filter?: MilestoneFilter,
    ): Effect.Effect<Stream.Stream<MilestoneEvent>, never, Scope.Scope>;
  };

  // 3. 基于共享 Effect Schema Contract 的强类型 RPC & 流式订阅（底层走 plugins.invoke / plugins.subscribe）
  readonly rpc: {
    handle<Req, Res, Err>(
      contract: PluginRpcContract<Req, Res, Err>,
      handler: (input: Req, caller: PluginCallerContext) => Effect.Effect<Res, Err>,
    ): Effect.Effect<void, never, Scope.Scope>;
    stream<Req, Chunk, Err>(
      contract: PluginStreamContract<Req, Chunk, Err>,
      handler: (input: Req, caller: PluginCallerContext) => Stream.Stream<Chunk, Err>,
    ): Effect.Effect<void, never, Scope.Scope>;
  };

  // 4. 动态 MCP 工具与过滤（R3 不对称注释：registerToolkit 全局注册，tools/list 可见性与 list_changed 广播按 providerSessionId 独立延迟到各自 Turn 边界）
  readonly mcp: {
    registerToolkit(toolkit: DynamicMcpToolkit): Effect.Effect<void, never, Scope.Scope>;
    registerToolFilter(
      predicate: (ctx: { threadId: ThreadId; role?: string; toolName: string }) => boolean,
    ): Effect.Effect<void, never, Scope.Scope>;
  };

  // 5. 动态 HTTP 子路由（自动挂载到 /api/plugins/:pluginId/*）
  readonly http: {
    route(
      method: "GET" | "POST" | "PUT" | "DELETE",
      subpath: string,
      handler: PluginHttpHandler,
    ): Effect.Effect<void, never, Scope.Scope>;
  };

  // 6. 底层引擎扩展 SPI（吸 Paseo 深度可插拔能力）
  readonly providers: {
    registerDriver(driver: AnyProviderDriver): Effect.Effect<void, never, Scope.Scope>;
  };
  readonly usage: {
    registerSource(source: PluginUsageSource): Effect.Effect<void, never, Scope.Scope>;
  };
  readonly vcs: {
    registerWorktreeManager(
      manager: PluginWorktreeManager,
    ): Effect.Effect<void, never, Scope.Scope>;
  };
  readonly channels: {
    registerBotChannel(channel: BotChannelAdapter): Effect.Effect<void, never, Scope.Scope>;
  };

  // 7. 隔离持久化（严禁触碰 statev2.sqlite 核心表）
  readonly storage: {
    readonly kv: PluginKvStore;
    readonly openIsolatedSqlite: () => Effect.Effect<SqlClient.SqlClient, SqlError, Scope.Scope>;
  };

  // 8. 跨端通知 & 受控线程操作门面
  readonly notifications: { send(input: CrossSurfaceNotification): Effect.Effect<void> };
  readonly orchestration: PluginOrchestrationFacade;
}
```

---

## 四、前端“一次开发，全端同 UI”三轨渲染 + 12 冻结原语 + 流式分频（R1 修订）

### 1. 三轨分级承载策略（兼顾 Web React Compiler + Desktop + Mobile 原生）

| 轨道                                                              | 适用场景与性能红线                                                                                                       | 插件写法                                                                                           | 宿主绘制方式                                                                                                                                                                                                                                                                                                                  |               移动端支持                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------: |
| **轨 1：声明式 TSX（全端主力 · 仅低频 `<100 节点 & <=10-15Hz`）** | 设置页、额度卡、审批决策卡、Bot 管理、Token 账单卡、输入区控件；**高频流走宿主侧 `StreamLog`/`terminalView` 增量 chunk** | 零构建 `.tsx` + `atom()` / `derived()` + **v0.1 冻结 12 个标准原语**（所有列表节点必带稳定 `key`） | 跑在隔离 Worker，低频节点发 JSON 组件树，高频日志/终端只推增量 chunk 由宿主持有 ring buffer + 虚拟滚动原生绘制                                                                                                                                                                                                                | **100% 原生一致（无 `eval` 审核风险）** |
| **轨 2：隔离沙箱 iframe（空间交互与重画布）**                     | Acan 2D 工厂、Vibe Kanban 拖拽看板、Canvas/图表、高频自定义可视化                                                        | 自包含 HTML/JS/Canvas/React/Vue                                                                    | 新建 `PluginSandboxFrame.tsx`（从 [BrowserDocumentFrame.tsx](file:///D:/Project/AgentLearn/t3code/apps/web/src/components/files/BrowserDocumentFrame.tsx) 抽公共基座 `HtmlSandboxFrameBase`）；**强制移除 `allow-forms`**（`sandbox="allow-scripts"`）、回包定向 `"null"` + 四条件 nonce 握手 + 引导脚本 pending 队列零丢首包 |              WebView 降级               |
| **轨 3：编译期第一方内置（非运行时插件 Slot）**                   | Dockview 壳、核心协作总览等强耦合内置模块                                                                                | 标准 React / RN 组件                                                                               | **编译期直连**，不走运行时动态加载，确保 `React Compiler 100%` 与 `gt-react` 静态提取门禁不破                                                                                                                                                                                                                                 |              双端各自实现               |

### 2. v0.1 冻结 12 个声明式原语与增量流式写法（R3 正式封板）

- **布局与展示（6）**：`Stack`、`Row`、`Card`（内置封闭 `kpi` 块替代原 `StatRow`，三方计数严格对齐 12）、`Text`、`Badge`、`Tabs`
- **低频交互（4）**：`Button`、`Toggle`、`Select`、`Progress`
- **宿主原生流式（2）**：`StreamLog`（插件只调 `host.streams.log(id, { append })` 发增量 chunk，宿主持有 ring buffer + 虚拟滚动 + 折叠高亮，绝不走全树 diff）、`TerminalView`（直挂宿主 `PersistentThreadTerminalPanel` 数据面，插件仅控制开窗与订阅）
- **CI 一次过硬规则（R3 实测纠偏封板）**：
  1. **渲染器组件宿主化（否决 Tailwind `@source`）**：`apps/web/vite/tailwind.ts` 在 `bundledDev` 下删除了 `hotUpdate`，故将 12 原语封闭 `switch` 渲染组件与 `StreamLog`/`TerminalView` 物理放于 `apps/web/src/components/plugin/`（天然落入宿主扫描域，Tailwind 配置零改动），`packages/plugin-ui-renderer` 仅保留协议类型、Schema 与 iframe 桥；
  2. **`gt.config.json` 显式忽略**：追加 `"ignore": ["../../packages/plugin-*/src/**/*.{ts,tsx}", "../../plugins/**/*.{ts,tsx}"]`，`<Text>` 仅许 `i18nKey` 禁裸串（随包 `locale/*.json` 运行时合并）；协议禁 `className` 透传；
  3. **`knip.jsonc` 精确配置**：新增 `packages/plugin-sdk` / `packages/plugin-kernel` / `packages/plugin-ui-renderer` / `plugins` 四个 workspace 条目（`plugins` 显式列 `*/bytedock-plugin.json` 并忽略 `dist/**`），同步更新 `knip-schemas.test.ts` 允许集合；
  4. **`StreamLog` 三段背压与 `atom` 节流**：服务端队列 cap 64 `drop-oldest` + 客户端 rAF 16ms 合并 + 4096 ring buffer 哨兵行（钉死 **tail-follow 语义**）；`atom({persist:"storage"})` 宿主去抖 `>=500ms` 且流式关联 atom 强制 `persist:"memory"`。

```tsx
// plugins/plugin-egress-guard/client/index.tsx（R1 修订：低频 KPI 走 JSON 树 + 高频日志走 StreamLog 宿主持有 buffer）
import {
  defineClientPlugin,
  Stack,
  Row,
  Card,
  Badge,
  Toggle,
  Button,
  Text,
  StreamLog,
} from "@bytedock/plugin-sdk/client";
import { EgressContract } from "../shared/contract";

export default defineClientPlugin((host) => {
  const stats = host.useQuery(EgressContract.getSummary, {}); // 低频摘要（<=2Hz）
  const logSink = host.streams.bind("egress-audit-log", EgressContract.streamLogs); // 增量 chunk → 宿主虚拟滚动 buffer

  host.slots.addDockPanel({
    id: "egress-audit",
    title: "出站审计",
    render: () => (
      <Stack gap="md">
        <Row justify="between">
          <Badge tone={stats.value.blocked > 0 ? "warning" : "success"}>
            已拦截 {stats.value.blocked} 次未授权外联
          </Badge>
          <Button size="sm" onPress={() => host.rpc.invoke(EgressContract.clearLogs, {})}>
            清空
          </Button>
        </Row>
        <StreamLog sink={logSink} columns={["time", "host", "verdict", "pluginId"]} />
      </Stack>
    ),
  });

  host.slots.addComposerItem({
    id: "egress-strict-toggle",
    render: () => (
      <Toggle
        label="严格离线"
        value={host.config.strictMode}
        onChange={(enabled) => host.rpc.invoke(EgressContract.setStrict, { enabled })}
      />
    ),
  });

  host.slots.addTimelineRenderer({
    id: "egress-block-card",
    match: (item) => item.kind === "plugin-event" && item.pluginId === "builtin.egress-guard",
    render: (item) => (
      <Card tone="warning">
        <Text>已阻止发往 {item.payload.host} 的请求</Text>
      </Card>
    ),
  });
});
```

### 3. 8 大标准 UI Slot

1. `dockPanel` — 接入 Dockview 自由拖拽分屏与顶栏标签（Phase 0 先接入现有右侧多 Tab 面板）
2. `settingsSection` — 动态路由 `/settings/plugin/$pluginId` + 侧栏导航自动注册 + 纳入设置搜索
3. `sidebarView` / `sidebarFooter` — 左侧新增功能视图（如 Bots / 任务看板）+ 左下角紧凑配额环
4. `statusBarItem` — 底栏紧凑状态条（`TTFT · tok/s · 缓存 % · 省钱统计`）
5. `composerItem` / `composerBanner` — 输入区语义控件 + 复用现成 `ComposerBannerStack`
6. `timelineRenderer` — 对话时间线自定义卡片（Token X-Ray 账单、Bot 审批卡、多模型 Arena Diff 卡）
7. `commandPalette` — `Cmd/Ctrl+K` 动态命令与动作（支持 `replaces` 接管内置动作，2s 超时回退）
8. `theme / customEditor` — 主题预设与自定义文件编辑器

---

## 五、免预编译 + 双态热重载引擎与 7 条防坑铁律（R1 修订）

### 1. 双态运行机制

- **开发态（Dev Folder，监听 `~/.bytedock/plugins-dev/` 或仓库 `plugins/`）**：
  1. `@parcel/watcher` 监听文件保存 → 递增 `revision`；
  2. 独立转译器编译 TS/TSX（单文件轻量 TSX 用 **Sucrase Worker** 零原生二进制依赖，2s 熔断；多文件/依赖打包用 **独立 `fork` 的 esbuild 子进程**）+ 编译期目录导入边界检查；
  3. **编译/首屏报错保护**：保留上一版运行中的旧修订、旧面板与旧服务不白屏、不崩主进程，UI 角落弹精确 `file:line:column` 错误条；
  4. **无泄漏模块重载 + Revision Pinning（R3 方案 α 正式封板）**：**严禁主机侧 ESM `?rev=N`、`worker_thread` 与磁盘 `createRequire("effect")`**；服务端统一采用 **单文件 CJS 转译 + `vm.compileFunction` + 宿主内存 `HostModuleRegistry` 注入虚拟 `require`**（~35 条 `effect/*` 编译期白名单 + 最小 `node:*` 集 + boot `Context.Tag` 同一 Symbol 探针，零 `require.cache` 污染、全免疫 `vp pack`/Electron 侧车/Node SEA 内联 `effect` 差异，evict 后 `WeakRef` 断言 GC 回收），新修订就绪后再冻结旧修订并走完整三段回收；MCP `list_changed` 按 `providerSessionId` 独立延迟至各自 Turn 边界广播；前端原地局部重挂并保留 `persist: "memory"` 状态；
  5. **Creator Mode 自验证闭环（v0.3）**：提供 CLI / MCP 工具 `bytedock plugin dev --check --shot`，供 AI Agent 写完插件后自动做编译校验、无头渲染并截屏 PNG 自我迭代。
- **已安装态（Production）**：
  - 不做磁盘隐式热刷，仅在用户/升级器显式触发 `plugins.reload(id)` 时平滑切换（`community` 信任级须先过 Decision 确认卡），避免半更新文件打断在跑 Agent 任务。

### 2. 必须写死在内核中的 7 条防坑铁律（Orca/Paseo 实测 + R1 Windows 补强）

1. **绝不在 `worker_thread` 里调用 `esbuild`**：必须单独 `child_process.fork` 编译子进程并在空闲 1–5s 后退出，彻底避免 `worker_thread` 销毁后残留 esbuild 僵尸原生进程。
2. **Electron 打包必须重定向 `ESBUILD_BINARY_PATH` 到 `app.asar.unpacked`**：否则打包后的 `.exe`/`.dmg` 调用 `spawn` 会直接报 `ENOTDIR`。
3. **客户端绝不用 `globalThis.eval` 执行第三方插件代码**：坚持“声明式 JSON 组件树 + 隔离 iframe 沙箱”，守住零遥测安全边界与 iOS 商店审核红线。
4. **Phase 0–1 不照抄 Orca 100+ 文件的重型 `<webview>` 协议栈与 Kill-List 商店**：先用仓库现成 `HtmlRenderFrame` 沙箱 + 声明式 TSX 渲染器 + 4 级 Manifest 校验快速跑通闭环。
5. **Windows Defender dev 模式前置排除引导（R1 补）**：Windows 实时扫描会将热重载延迟拖慢至 1–3s，`~/.bytedock` 排除项升级为 dev 模式首次启动的一次性 UAC 前置引导。
6. **`@parcel/watcher` 原生打包与路径边界（R1 补）**：Electron 打包必须 `asarUnpack` 其 win32-x64 二进制；用户目录用 `os.homedir()` 拼接避开 OneDrive/环境变量重定向；**明确不支持 WSL 路径或网络盘作为 dev 热重载目录**。
7. **`child_process.fork` 仅允许执行已编译产物（R1 补）**：绝不对 `.ts/.tsx` 源码直接 `fork`，一律先落盘已编译 CJS 入口再结合 `ELECTRON_RUN_AS_NODE=1` 拉起。

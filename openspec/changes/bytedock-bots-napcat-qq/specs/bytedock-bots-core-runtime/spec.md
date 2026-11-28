# Specification: ByteDock Bots Core Runtime

## Purpose

定义 `builtin.bots-core` 在 ByteDock 宿主机服务端的持久化运行时契约，包括隔离状态存储、确定性 `SOUL.md` 前缀注入、追加式 `MEMORY.md`、线程绑定以及 Bot Decision Gate 生命周期与安全隔离边界。

## ADDED Requirements

### Requirement: Persistent Bot Profiles and Isolated Storage

The `builtin.bots-core` runtime SHALL persist bot profiles, `SOUL.md`, `MEMORY.md`, and Decision Gate records exclusively under `<stateDir>/bots/` (default `~/.bytedock/userdata/bots/` in production and `~/.bytedock/dev/bots/` in dev, inheriting `stateDir` `0o700` isolation) using atomic writes, strict bot identifier validation that prevents path traversal, and an in-memory cache for turn-hook hot paths.

#### Scenario: Default bot bootstraps on first initialization

- **WHEN** `BotsCoreService` initializes on a clean `<stateDir>` with no existing `bots/bots.json`
- **THEN** it creates a default bot profile (id `"default"`) with an initial `SOUL.md` and an append-only `MEMORY.md` header under `<stateDir>/bots/default/`
- **AND** never reads or writes any path outside `<stateDir>/bots/`

#### Scenario: Invalid bot identifier is rejected

- **WHEN** a caller attempts to create or update a bot with an identifier containing `..`, `/`, `\`, or characters outside `^[a-z0-9][a-z0-9._-]{0,47}$`
- **THEN** the service rejects the operation with a validation error without touching the filesystem

### Requirement: Deterministic SOUL.md Prefix Guard and Prompt Cache Preservation

When `builtin.bots-core` is enabled and `soulPrefixGuard` is `true`, the runtime SHALL attach a `PluginKernel` `agent.turn.before` hook that reads from its in-memory bot cache (zero synchronous disk I/O per turn) and injects a deterministic context block derived solely from the bound bot's `SOUL.md` and stable `sha256(soulMarkdown)` fingerprint, without embedding per-turn volatile timestamps or counters in the prefix block.

#### Scenario: Bound thread receives deterministic SOUL prefix across consecutive turns

- **WHEN** a ByteDock thread is bound to an enabled bot profile and `agent.turn.before` executes on two consecutive turns without modifying `SOUL.md`
- **THEN** `builtin.bots-core` returns a `pass` hook verdict with identical `contribution.appendContext` bytes on both turns
- **AND** the reported `soulPrefixHash` matches the SHA-256 digest of the persisted `SOUL.md`

#### Scenario: Unbound thread or disabled plugin produces no injection

- **WHEN** `agent.turn.before` executes for a thread not bound to any bot, or `builtin.bots-core` is disabled in `plugins.yml`
- **THEN** `builtin.bots-core` emits no context contribution for that turn

### Requirement: Append-Only MEMORY.md Persistence and Compaction Handoff

The `builtin.bots-core` runtime SHALL enforce `memoryMode: "append-only"` so callers can only append timestamped entries to `MEMORY.md` rather than silently rewriting prior history. On `agent.compact.before`, it SHALL both return a bounded `handoffSummary` (containing bot id, `soulPrefixHash`, and recent `MEMORY.md` tail) and arm a one-shot per-thread `pendingHandoffSummary` injected once on the immediately following non-compact `agent.turn.before` (so adapters that ignore slash-command `appContext` still receive the compaction handoff, while subsequent steady-state turns return to pure deterministic `SOUL.md`).

#### Scenario: Appending a memory entry preserves existing entries

- **WHEN** a caller invokes `builtin.bots-core.appendMemory` (or a completed QQ turn records a summary)
- **THEN** the new entry is appended after all previously persisted lines in `<stateDir>/bots/<botId>/MEMORY.md`
- **AND** existing lines remain byte-for-byte intact

#### Scenario: Compaction hook carries SOUL anchor and recent memory across reset boundary

- **WHEN** `agent.compact.before` executes for a thread bound to a bot with persisted `MEMORY.md` entries, followed by a regular `agent.turn.before`
- **THEN** `agent.compact.before` returns a concise `handoffSummary`, the immediately following `agent.turn.before` includes that one-shot handoff once, and the turn after that emits only the deterministic `SOUL.md` prefix

### Requirement: Decision Gate Lifecycle and Multi-Surface Synchronization

The `builtin.bots-core` runtime SHALL manage Bot Decision Gates (`pending`, `approved`, `rejected`) persisted under `<stateDir>/bots/decision-gates.json`, support idempotent single-resolution semantics, and publish live `decision-gate-created`, `decision-gate-resolved`, and `bots-updated` events over `builtin.control-plane/events`.

#### Scenario: Resolving a pending Decision Gate transitions state once and emits event

- **WHEN** a pending Decision Gate is resolved with `"approved"` or `"rejected"` from Control Center or an authorized QQ command
- **THEN** the gate status persists as `"approved"` or `"rejected"` with `resolvedBy`, `resolvedVia`, and `resolvedAt`, and a `decision-gate-resolved` event is broadcast over `builtin.control-plane/events`
- **AND** a second resolution attempt on the same gate is rejected as already resolved

### Requirement: Separation Between Bot Decision Gates, MCP Callers, and Privileged Host Approvals

Bot Decision Gates SHALL represent workflow confirmation checkpoints for bot tasks and MUST NOT approve, mutate, or bypass privileged `ControlPlaneApprovalRequest` items. Furthermore, MCP callers (`callerKind === "mcp"`) MUST NOT invoke `builtin.bots-core.resolveGate`, `upsertBot`, `updateSoul`, or `deleteBot`, and disabling `soulPrefixGuard` via `bytedock_plugin_config_patch` SHALL be classified as `high` risk requiring main-session human approval.

#### Scenario: QQ approval command cannot resolve Control Plane privileged approvals

- **WHEN** an inbound QQ message sends `/approve <controlPlaneRequestId>` referencing a privileged `ControlPlaneApprovalRequest`
- **THEN** the bots runtime does not resolve any `ControlPlaneApprovalRequest`
- **AND** responds that privileged host approvals require human review in ByteDock Control Center

#### Scenario: MCP caller cannot self-approve Decision Gates or rewrite SOUL.md

- **WHEN** an AI agent calls `bytedock_plugin_action(action: "invoke", pluginId: "builtin.bots-core", method: "resolveGate" | "updateSoul" | "upsertBot")`
- **THEN** `HostControlService` rejects the call with `capability_denied` (`host_client_required`)

// @effect-diagnostics nodeBuiltinImport:off -- Control plane scans default ~/.bytedock/plugins and watches plugins.yml on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type PluginsStreamEvent,
} from "@t3tools/contracts";
import * as PluginKernel from "@bytedock/plugin-kernel";
import type { ByteDockPluginManifest, PluginRuntimeDescriptor } from "@bytedock/plugin-kernel";

import * as ServerConfig from "../config.ts";
import { BUILTIN_METHODS, BUILTIN_PLUGIN_MANIFESTS } from "./BuiltinPluginManifests.ts";
import {
  makePluginApprovalStore,
  type ApprovalKind,
  type ControlPlaneApprovalRequest,
  type HostApprovalMutation,
  type PluginApprovalStoreService,
} from "./PluginApprovalStore.ts";
import {
  makeTokenOptimizerTelemetry,
  type TokenOptimizerTelemetryService,
} from "./TokenOptimizerTelemetry.ts";

export const CONTROL_PLANE_PLUGIN_ID = "builtin.control-plane";
export const CONTROL_PLANE_EVENTS_TOPIC = "events";

export class ControlPlaneError extends Schema.TaggedError<ControlPlaneError>()(
  "ControlPlaneError",
  {
    code: Schema.Literals([
      "plugin_not_found",
      "invalid_config",
      "stale_config",
      "main_session_required",
      "host_client_required",
      "plugin_disabled",
      "approval_not_found",
      "approval_expired",
      "approval_already_resolved",
      "service_unavailable",
      "action_failed",
      "io_error",
    ]),
    message: Schema.String,
    pluginId: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
  },
) {}

export interface UiControlCommand {
  readonly commandId: string;
  readonly action:
    | "open_control_center"
    | "close_control_center"
    | "open_dock_panel"
    | "close_dock_panel"
    | "navigate"
    | "notify";
  readonly tab?: "plugins" | "xray" | "import" | undefined;
  readonly pluginId?: string | undefined;
  readonly node?: unknown;
  readonly path?: string | undefined;
  readonly message?: string | undefined;
  readonly level?: "info" | "success" | "warning" | "error" | undefined;
  readonly issuedAt: string;
  readonly actor: string;
}

export type HostMutationExecutor = (input: {
  readonly request: ControlPlaneApprovalRequest;
  readonly mutation: HostApprovalMutation;
  readonly actorId: string;
}) => Effect.Effect<unknown, ControlPlaneError>;

export type ControlPlaneActor =
  | { readonly kind: "host-client"; readonly actorId: string }
  | {
      readonly kind: "mcp-main-thread";
      readonly threadId: string;
      readonly providerInstanceId?: string | undefined;
    }
  | {
      readonly kind: "mcp-non-main";
      readonly reason: string;
      readonly actorId: string;
    };

export interface ConfigDiagnostic {
  readonly filePath: string;
  readonly pluginId?: string | undefined;
  readonly message: string;
  readonly observedAt: string;
}

export interface ControlPlanePluginEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly revision: number;
  readonly execution: ByteDockPluginManifest["execution"];
  readonly trust: ByteDockPluginManifest["trust"];
  readonly status: "active" | "degraded" | "disabled";
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly approved: boolean;
  readonly permissionsFingerprint?: string | undefined;
  readonly sourcePath?: string | undefined;
}

export interface ControlPlaneStateSnapshot {
  readonly pluginConfigPath: string;
  readonly pluginsDir: string;
  readonly mtimeMs: number;
  readonly activeRevision: number;
  readonly plugins: ReadonlyArray<ControlPlanePluginEntry>;
  readonly egressPolicy: PluginKernel.EgressPolicy;
  readonly lastConfigDiagnostic?: ConfigDiagnostic | undefined;
  readonly lastReloadDiagnostic?: PluginKernel.HotReloadErrorDiagnostic | undefined;
  readonly approvals: ReadonlyArray<ControlPlaneApprovalRequest>;
}

export type ControlPlaneMutationOutcome =
  | {
      readonly status: "applied";
      readonly pluginId: string;
      readonly enabled: boolean;
      readonly pluginStatus: "active" | "degraded" | "disabled";
      readonly config: Readonly<Record<string, unknown>>;
      readonly activeRevision: number;
      readonly mtimeMs: number;
    }
  | {
      readonly status: "approval_required";
      readonly request: ControlPlaneApprovalRequest;
    };

export interface ControlPlaneReloadOutcome {
  readonly status: "reloaded" | "skipped-unchanged" | "kept-previous-on-error";
  readonly previousRevision: number;
  readonly activeRevision: number;
  readonly mtimeMs: number;
  readonly plugins: ReadonlyArray<ControlPlanePluginEntry>;
  readonly configDiagnostic?: ConfigDiagnostic | undefined;
  readonly reloadDiagnostic?: PluginKernel.HotReloadErrorDiagnostic | undefined;
}

export interface ControlPlaneApprovalResolution {
  readonly request: ControlPlaneApprovalRequest;
  readonly applied?:
    | Extract<ControlPlaneMutationOutcome, { readonly status: "applied" }>
    | undefined;
  readonly hostResult?: unknown;
}

interface DiscoveredLocalPlugin {
  readonly manifest: ByteDockPluginManifest;
  readonly entryPath: string;
  readonly sourcePath: string;
  readonly permissionsFingerprint: string;
}

interface InternalRuntimeState {
  readonly mtimeMs: number;
  readonly enabledByPlugin: Readonly<Record<string, boolean>>;
  readonly configByPlugin: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly localPlugins: ReadonlyArray<DiscoveredLocalPlugin>;
  readonly degradedLocalPluginIds: ReadonlySet<string>;
  readonly lastConfigDiagnostic: ConfigDiagnostic | undefined;
  readonly lastReloadDiagnostic: PluginKernel.HotReloadErrorDiagnostic | undefined;
  readonly cursor: number;
}

export interface PluginControlPlaneService {
  readonly kernel: PluginKernel.PluginKernelService;
  readonly approvals: PluginApprovalStoreService;
  readonly tokenOptimizer: TokenOptimizerTelemetryService;
  readonly stateDir: string;
  readonly pluginConfigPath: string;
  readonly pluginsDir: string;
  readonly getState: () => Effect.Effect<ControlPlaneStateSnapshot>;
  readonly listDescriptors: () => Effect.Effect<ReadonlyArray<PluginRuntimeDescriptor>>;
  readonly isPluginEnabled: (pluginId: string) => Effect.Effect<boolean>;
  readonly getPluginConfig: (pluginId: string) => Effect.Effect<Readonly<Record<string, unknown>>>;
  readonly setPluginEnabled: (input: {
    readonly pluginId: string;
    readonly enabled: boolean;
    readonly expectedMtimeMs?: number | undefined;
    readonly actor: ControlPlaneActor;
  }) => Effect.Effect<ControlPlaneMutationOutcome, ControlPlaneError>;
  readonly patchPluginConfig: (input: {
    readonly pluginId: string;
    readonly patch: Readonly<Record<string, unknown>>;
    readonly expectedMtimeMs?: number | undefined;
    readonly actor: ControlPlaneActor;
  }) => Effect.Effect<ControlPlaneMutationOutcome, ControlPlaneError>;
  readonly setHostMutationExecutor: (executor: HostMutationExecutor) => void;
  readonly createHostApproval: (input: {
    readonly kind: ApprovalKind;
    readonly targetId: string;
    readonly reasons: ReadonlyArray<string>;
    readonly summary: string;
    readonly diffPreview: { readonly before: unknown; readonly after: unknown };
    readonly requestedBy: ControlPlaneApprovalRequest["requestedBy"];
    readonly mutation: HostApprovalMutation;
  }) => Effect.Effect<ControlPlaneApprovalRequest>;
  readonly emitUiCommand: (
    command: Omit<UiControlCommand, "commandId" | "issuedAt">,
  ) => Effect.Effect<UiControlCommand>;
  readonly getLastUiCommand: () => Effect.Effect<UiControlCommand | undefined>;
  readonly resolveApproval: (input: {
    readonly requestId: string;
    readonly decision: "approve" | "reject";
    readonly actor: ControlPlaneActor;
    readonly note?: string | undefined;
  }) => Effect.Effect<ControlPlaneApprovalResolution, ControlPlaneError>;
  readonly reloadFromDisk: (options?: {
    readonly reason?: string | undefined;
  }) => Effect.Effect<ControlPlaneReloadOutcome>;
  readonly subscribeEvents: () => Stream.Stream<PluginsStreamEvent>;
}

export class PluginControlPlane extends Context.Service<
  PluginControlPlane,
  PluginControlPlaneService
>()("t3/plugins/PluginControlPlane") {}

const BUILTIN_BY_ID = new Map<string, ByteDockPluginManifest>(
  BUILTIN_PLUGIN_MANIFESTS.map((m) => [m.id, m]),
);

const CONTROL_PLANE_METHODS: ReadonlyArray<{
  readonly method: string;
  readonly minScopes: ReadonlyArray<string>;
}> = [
  { method: "getState", minScopes: [AuthOrchestrationReadScope] },
  { method: "listApprovals", minScopes: [AuthOrchestrationReadScope] },
  { method: CONTROL_PLANE_EVENTS_TOPIC, minScopes: [AuthOrchestrationReadScope] },
  { method: "setEnabled", minScopes: [AuthOrchestrationOperateScope] },
  { method: "patchConfig", minScopes: [AuthOrchestrationOperateScope] },
  { method: "resolveApproval", minScopes: [AuthOrchestrationOperateScope] },
];

function isoFromMs(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function isJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildDefaultState(): InternalRuntimeState {
  const enabledByPlugin: Record<string, boolean> = {};
  const configByPlugin: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
    enabledByPlugin[manifest.id] = true;
    configByPlugin[manifest.id] = PluginKernel.getDefaultPluginConfig(manifest.id);
  }
  return {
    mtimeMs: 0,
    enabledByPlugin,
    configByPlugin,
    localPlugins: [],
    degradedLocalPluginIds: new Set(),
    lastConfigDiagnostic: undefined,
    lastReloadDiagnostic: undefined,
    cursor: 0,
  };
}

function isValidManifestObject(raw: unknown): raw is ByteDockPluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const m = raw as Partial<ByteDockPluginManifest>;
  return (
    typeof m.id === "string" &&
    m.id.trim().length > 0 &&
    typeof m.name === "string" &&
    m.name.trim().length > 0 &&
    typeof m.version === "string" &&
    m.apiVersion === "0.1" &&
    typeof m.execution === "string" &&
    typeof m.trust === "string" &&
    m.permissions !== undefined &&
    typeof m.permissions === "object"
  );
}

function scanDefaultPluginsDir(pluginsDir: string): {
  readonly discovered: ReadonlyArray<DiscoveredLocalPlugin>;
  readonly errors: ReadonlyArray<PluginKernel.HotReloadErrorDiagnostic>;
} {
  if (!NodeFS.existsSync(pluginsDir)) {
    return { discovered: [], errors: [] };
  }
  const discovered: Array<DiscoveredLocalPlugin> = [];
  const errors: Array<PluginKernel.HotReloadErrorDiagnostic> = [];

  let entries: ReadonlyArray<NodeFS.Dirent> = [];
  try {
    entries = NodeFS.readdirSync(pluginsDir, { withFileTypes: true });
  } catch (cause) {
    return {
      discovered: [],
      errors: [
        {
          pluginId: "local-scan",
          tag: "ScanError",
          file: pluginsDir,
          line: 1,
          column: 1,
          message: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    };
  }

  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    const pluginRoot = NodePath.join(pluginsDir, dir.name);
    const manifestPath = NodePath.join(pluginRoot, "manifest.json");
    if (!NodeFS.existsSync(manifestPath)) continue;

    try {
      const parsed = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as unknown;
      if (!isValidManifestObject(parsed)) {
        errors.push({
          pluginId: dir.name,
          tag: "ManifestValidationError",
          file: manifestPath,
          line: 1,
          column: 1,
          message:
            "Invalid plugin manifest.json schema (requires id, name, version, apiVersion:'0.1', execution, trust, permissions).",
        });
        continue;
      }
      if (BUILTIN_BY_ID.has(parsed.id) || parsed.id === CONTROL_PLANE_PLUGIN_ID) {
        errors.push({
          pluginId: parsed.id,
          tag: "ManifestValidationError",
          file: manifestPath,
          line: 1,
          column: 1,
          message: `Local plugin id "${parsed.id}" collides with a builtin ByteDock plugin.`,
        });
        continue;
      }
      const relativeEntry =
        parsed.entry?.server ??
        (NodeFS.existsSync(NodePath.join(pluginRoot, "index.ts")) ? "./index.ts" : "./index.js");
      const entryPath = NodePath.resolve(pluginRoot, relativeEntry);
      const resolvedRoot = NodePath.resolve(pluginRoot);
      if (entryPath !== resolvedRoot && !entryPath.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
        errors.push({
          pluginId: parsed.id,
          tag: "ManifestValidationError",
          file: manifestPath,
          line: 1,
          column: 1,
          message: `Plugin entry path "${relativeEntry}" escapes its plugin directory.`,
        });
        continue;
      }
      discovered.push({
        manifest: parsed,
        entryPath,
        sourcePath: pluginRoot,
        permissionsFingerprint: PluginKernel.computePluginPermissionsFingerprint(parsed),
      });
    } catch (cause) {
      errors.push({
        pluginId: dir.name,
        tag: "ManifestParseError",
        file: manifestPath,
        line: 1,
        column: 1,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return {
    discovered: discovered.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)),
    errors,
  };
}

/** Singleton control plane coordinating plugins.yml, default ~/.bytedock/plugins watcher, hot reload, MCP mutations, and human approvals. */
export const makePluginControlPlane = Effect.fn("PluginControlPlane.make")(function* (options: {
  readonly kernel: PluginKernel.PluginKernelService;
  readonly stateDir: string;
  readonly logsDir: string;
  readonly pluginConfigPath: string;
  readonly pluginsDir: string;
  readonly watchFiles?: boolean | undefined;
  readonly approvalTtlMs?: number | undefined;
}) {
  const opGate = yield* Semaphore.make(1);
  const configService = yield* PluginKernel.makePluginConfigService(options.pluginConfigPath);
  const approvals = yield* makePluginApprovalStore({
    stateDir: options.stateDir,
    logsDir: options.logsDir,
    defaultTtlMs: options.approvalTtlMs,
  });
  const tokenOptimizer = makeTokenOptimizerTelemetry();
  const stateRef = yield* Ref.make<InternalRuntimeState>(buildDefaultState());
  const lastWrittenMtimeRef = yield* Ref.make<number | undefined>(undefined);
  const lastUiCommandRef = yield* Ref.make<UiControlCommand | undefined>(undefined);
  const eventsPubSub = yield* PubSub.unbounded<PluginsStreamEvent>();
  let hostMutationExecutor: HostMutationExecutor | undefined;

  // Ensure builtin manifests and broker methods are registered once on the shared kernel.
  const registerBuiltinsOnce = Effect.gen(function* () {
    const existing = yield* options.kernel.listDescriptors();
    const active =
      existing.length > 0
        ? yield* options.kernel.revisions.active()
        : yield* options.kernel.revisions.installRevision({
            manifests: BUILTIN_PLUGIN_MANIFESTS,
          });
    for (const spec of BUILTIN_METHODS) {
      yield* options.kernel.broker.registerMethod({
        pluginId: spec.pluginId,
        method: spec.method,
        revision: active.rev,
        methodMinScopes: spec.minScopes,
        manifestScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
    }
    for (const spec of CONTROL_PLANE_METHODS) {
      yield* options.kernel.broker.registerMethod({
        pluginId: CONTROL_PLANE_PLUGIN_ID,
        method: spec.method,
        revision: active.rev,
        methodMinScopes: spec.minScopes,
        manifestScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
    }
    yield* tokenOptimizer.attachKernelHooks(options.kernel, active.rev);
  });

  const syncRuntimeEffects = Effect.fn("PluginControlPlane.syncRuntimeEffects")(function* (
    next: InternalRuntimeState,
  ) {
    for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
      const enabled = next.enabledByPlugin[manifest.id] !== false;
      yield* options.kernel.hooks.setPluginEnabled(manifest.id, enabled);
      options.kernel.mcpBridge.setPluginEnabled(manifest.id, enabled);
    }
    for (const local of next.localPlugins) {
      const approved = yield* approvals.isLocalPluginApproved(
        local.manifest.id,
        local.permissionsFingerprint,
      );
      const enabled = approved && next.enabledByPlugin[local.manifest.id] === true;
      yield* options.kernel.hooks.setPluginEnabled(local.manifest.id, enabled);
      options.kernel.mcpBridge.setPluginEnabled(local.manifest.id, enabled);
    }
    const egressCfg =
      next.configByPlugin["builtin.egress-guard"] ??
      PluginKernel.getDefaultPluginConfig("builtin.egress-guard");
    const effectivePolicy = PluginKernel.buildEffectiveEgressPolicy(egressCfg);
    options.kernel.egress.updatePolicy(effectivePolicy);
  });

  const emitControlEvent = Effect.fn("PluginControlPlane.emitControlEvent")(function* (
    kind: string,
    payload: Readonly<Record<string, unknown>>,
  ) {
    const active = yield* options.kernel.revisions.active();
    const cursor = yield* Ref.modify(stateRef, (s) => {
      const nextCursor = s.cursor + 1;
      return [nextCursor, { ...s, cursor: nextCursor }] as const;
    });
    yield* PubSub.publish(eventsPubSub, {
      cursor: String(cursor),
      revision: active.rev,
      pluginId: CONTROL_PLANE_PLUGIN_ID,
      topic: CONTROL_PLANE_EVENTS_TOPIC,
      qos: "interactive",
      payload: { kind, ...payload },
    });
  });

  const buildPluginEntries = Effect.fn("PluginControlPlane.buildPluginEntries")(function* (
    st: InternalRuntimeState,
    activeRev: number,
  ) {
    const list: Array<ControlPlanePluginEntry> = [];
    for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
      const enabled = st.enabledByPlugin[manifest.id] !== false;
      list.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        revision: activeRev,
        execution: manifest.execution,
        trust: manifest.trust,
        status: enabled ? "active" : "disabled",
        enabled,
        config: st.configByPlugin[manifest.id] ?? PluginKernel.getDefaultPluginConfig(manifest.id),
        approved: true,
      });
    }
    for (const local of st.localPlugins) {
      const approved = yield* approvals.isLocalPluginApproved(
        local.manifest.id,
        local.permissionsFingerprint,
      );
      const rawEnabled = st.enabledByPlugin[local.manifest.id] === true;
      const effectiveEnabled = approved && rawEnabled;
      const isDegraded = st.degradedLocalPluginIds.has(local.manifest.id);
      list.push({
        id: local.manifest.id,
        name: local.manifest.name,
        version: local.manifest.version,
        revision: activeRev,
        execution: local.manifest.execution,
        trust: local.manifest.trust,
        status: isDegraded ? "degraded" : effectiveEnabled ? "active" : "disabled",
        enabled: effectiveEnabled,
        config: st.configByPlugin[local.manifest.id] ?? {},
        approved,
        permissionsFingerprint: local.permissionsFingerprint,
        sourcePath: local.sourcePath,
      });
    }
    return list as ReadonlyArray<ControlPlanePluginEntry>;
  });

  const reloadUnlocked = Effect.fn("PluginControlPlane.reloadUnlocked")(function* (reason: string) {
    const nowMs = yield* Clock.currentTimeMillis;
    const prevRev = (yield* options.kernel.revisions.active()).rev;
    const prevState = yield* Ref.get(stateRef);
    const readRes = yield* configService.readSafe();

    let nextMtimeMs = prevState.mtimeMs;
    let nextEnabled = { ...prevState.enabledByPlugin };
    let nextConfigs = { ...prevState.configByPlugin };
    let nextConfigDiag: ConfigDiagnostic | undefined = undefined;
    let configChanged = false;

    if (!readRes.ok) {
      nextConfigDiag = {
        filePath: readRes.filePath,
        message: readRes.message,
        observedAt: isoFromMs(nowMs),
      };
    } else {
      const candidateEnabled: Record<string, boolean> = {};
      const candidateConfigs: Record<string, Readonly<Record<string, unknown>>> = {};
      for (const manifest of BUILTIN_PLUGIN_MANIFESTS) {
        candidateEnabled[manifest.id] = true;
        candidateConfigs[manifest.id] = PluginKernel.getDefaultPluginConfig(manifest.id);
      }

      let validationError: { readonly pluginId: string; readonly message: string } | undefined;
      for (const [pluginId, rawEntry] of Object.entries(readRes.snapshot.document.plugins)) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
          validationError = {
            pluginId,
            message: `Plugin entry "${pluginId}" in plugins.yml must be an object.`,
          };
          break;
        }
        if (rawEntry.enabled !== undefined && typeof rawEntry.enabled !== "boolean") {
          validationError = {
            pluginId,
            message: `Plugin "${pluginId}" field "enabled" must be a boolean.`,
          };
          break;
        }
        if (rawEntry.enabled !== undefined) {
          candidateEnabled[pluginId] = rawEntry.enabled;
        }
        const validated = PluginKernel.validatePluginConfig(pluginId, rawEntry.config);
        if (!validated.ok) {
          validationError = { pluginId, message: validated.message };
          break;
        }
        candidateConfigs[pluginId] = validated.config;
      }

      if (validationError) {
        // Preserve previous valid in-memory config snapshot on any validation failure.
        nextConfigDiag = {
          filePath: options.pluginConfigPath,
          pluginId: validationError.pluginId,
          message: validationError.message,
          observedAt: isoFromMs(nowMs),
        };
      } else {
        configChanged =
          readRes.snapshot.mtimeMs !== prevState.mtimeMs ||
          !isJsonEqual(candidateEnabled, prevState.enabledByPlugin) ||
          !isJsonEqual(candidateConfigs, prevState.configByPlugin);
        nextMtimeMs = readRes.snapshot.mtimeMs;
        nextEnabled = candidateEnabled;
        nextConfigs = candidateConfigs;
        nextConfigDiag = undefined;
      }
    }

    const scan = scanDefaultPluginsDir(options.pluginsDir);
    const degraded = new Set<string>();
    const approvedEnabledSources: Array<PluginKernel.HotReloadPluginSource> = [];
    for (const local of scan.discovered) {
      const isApproved = yield* approvals.isLocalPluginApproved(
        local.manifest.id,
        local.permissionsFingerprint,
      );
      if (isApproved && nextEnabled[local.manifest.id] === true) {
        approvedEnabledSources.push({
          manifest: local.manifest,
          entryPath: local.entryPath,
        });
      }
    }

    let reloadStatus: ControlPlaneReloadOutcome["status"] = "skipped-unchanged";
    let nextReloadDiag: PluginKernel.HotReloadErrorDiagnostic | undefined = scan.errors[0];

    if (approvedEnabledSources.length > 0) {
      const hr = yield* options.kernel.hotReload.reloadFromSources(approvedEnabledSources, {
        nowMs,
        extraManifests: BUILTIN_PLUGIN_MANIFESTS,
      });
      if (hr.status === "kept-previous-on-error") {
        reloadStatus = "kept-previous-on-error";
        nextReloadDiag = hr.error;
        degraded.add(hr.error.pluginId);
      } else if (hr.status === "reloaded") {
        reloadStatus = "reloaded";
        nextReloadDiag = scan.errors[0];
      }
    } else if (scan.errors.length > 0) {
      reloadStatus = "kept-previous-on-error";
    } else if (configChanged || prevState.localPlugins.length !== scan.discovered.length) {
      reloadStatus = "reloaded";
    }

    if (nextConfigDiag !== undefined && reloadStatus !== "kept-previous-on-error") {
      reloadStatus = "kept-previous-on-error";
    }

    const nextState: InternalRuntimeState = {
      ...prevState,
      mtimeMs: nextMtimeMs,
      enabledByPlugin: nextEnabled,
      configByPlugin: nextConfigs,
      localPlugins: scan.discovered,
      degradedLocalPluginIds: degraded,
      lastConfigDiagnostic: nextConfigDiag,
      lastReloadDiagnostic: nextReloadDiag,
    };
    yield* Ref.set(stateRef, nextState);
    yield* syncRuntimeEffects(nextState);

    const activeRev = (yield* options.kernel.revisions.active()).rev;
    const plugins = yield* buildPluginEntries(nextState, activeRev);

    if (configChanged || reloadStatus !== "skipped-unchanged" || nextConfigDiag !== undefined) {
      yield* approvals.recordAudit({
        event: "reload_from_disk",
        reason,
        status: reloadStatus,
        activeRevision: activeRev,
        ...(nextConfigDiag ? { configDiagnostic: nextConfigDiag.message } : {}),
        ...(nextReloadDiag ? { reloadDiagnostic: nextReloadDiag.message } : {}),
      });
      yield* emitControlEvent("state-updated", {
        reason,
        status: reloadStatus,
        activeRevision: activeRev,
      });
    }

    return {
      status: reloadStatus,
      previousRevision: prevRev,
      activeRevision: activeRev,
      mtimeMs: nextState.mtimeMs,
      plugins,
      ...(nextConfigDiag ? { configDiagnostic: nextConfigDiag } : {}),
      ...(nextReloadDiag ? { reloadDiagnostic: nextReloadDiag } : {}),
    } satisfies ControlPlaneReloadOutcome;
  });

  const findKnownPlugin = (
    st: InternalRuntimeState,
    pluginId: string,
  ):
    | { readonly kind: "builtin"; readonly manifest: ByteDockPluginManifest }
    | { readonly kind: "local"; readonly local: DiscoveredLocalPlugin }
    | undefined => {
    const builtin = BUILTIN_BY_ID.get(pluginId);
    if (builtin) return { kind: "builtin", manifest: builtin };
    const local = st.localPlugins.find((p) => p.manifest.id === pluginId);
    if (local) return { kind: "local", local };
    return undefined;
  };

  const applyPersistedMutationUnlocked = Effect.fn(
    "PluginControlPlane.applyPersistedMutationUnlocked",
  )(function* (args: {
    readonly pluginId: string;
    readonly expectedMtimeMs: number;
    readonly enabled?: boolean | undefined;
    readonly config?: Readonly<Record<string, unknown>> | undefined;
    readonly approvedLocalFingerprint?: string | undefined;
    readonly actorSummary: string;
  }) {
    const updatedSnap = yield* configService
      .updatePluginConfig({
        pluginId: args.pluginId,
        expectedMtimeMs: args.expectedMtimeMs,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.config !== undefined ? { config: args.config } : {}),
      })
      .pipe(
        Effect.mapError((err) =>
          err._tag === "StaleConfigWriteError"
            ? new ControlPlaneError({
                code: "stale_config",
                pluginId: args.pluginId,
                message: `plugins.yml changed on disk (expected mtime ${err.expectedMtimeMs}, actual ${err.actualMtimeMs}). Re-read config and retry.`,
              })
            : new ControlPlaneError({
                code: "io_error",
                pluginId: args.pluginId,
                message: `Failed writing plugins.yml: ${String(err.cause)}`,
              }),
        ),
      );
    yield* Ref.set(lastWrittenMtimeRef, updatedSnap.mtimeMs);

    if (args.approvedLocalFingerprint) {
      yield* approvals.recordLocalPluginApproval({
        pluginId: args.pluginId,
        permissionsFingerprint: args.approvedLocalFingerprint,
        approvedBy: args.actorSummary,
      });
    }

    const outcome = yield* reloadUnlocked(`mutation:${args.pluginId}`);
    const entry = outcome.plugins.find((p) => p.id === args.pluginId);
    yield* approvals.recordAudit({
      event: "config_applied",
      pluginId: args.pluginId,
      actor: args.actorSummary,
      enabled: entry?.enabled ?? args.enabled ?? true,
      mtimeMs: updatedSnap.mtimeMs,
    });

    return {
      status: "applied",
      pluginId: args.pluginId,
      enabled: entry?.enabled ?? args.enabled ?? true,
      pluginStatus: entry?.status ?? "active",
      config: entry?.config ?? args.config ?? {},
      activeRevision: outcome.activeRevision,
      mtimeMs: updatedSnap.mtimeMs,
    } satisfies Extract<ControlPlaneMutationOutcome, { readonly status: "applied" }>;
  });

  const setPluginEnabled: PluginControlPlaneService["setPluginEnabled"] = (input) =>
    opGate.withPermits(1)(
      Effect.gen(function* () {
        // Refresh local plugin scan if pluginId not yet in memory.
        let st = yield* Ref.get(stateRef);
        let found = findKnownPlugin(st, input.pluginId);
        if (!found) {
          yield* reloadUnlocked("discover-before-toggle");
          st = yield* Ref.get(stateRef);
          found = findKnownPlugin(st, input.pluginId);
        }
        if (!found) {
          return yield* new ControlPlaneError({
            code: "plugin_not_found",
            pluginId: input.pluginId,
            message: `Unknown plugin "${input.pluginId}".`,
          });
        }

        const isFirewall = input.pluginId === "builtin.egress-guard";
        if (isFirewall && input.actor.kind === "mcp-non-main") {
          yield* approvals.recordAudit({
            event: "firewall_denied_non_main",
            pluginId: input.pluginId,
            operation: "setEnabled",
            enabled: input.enabled,
            actor: input.actor.actorId,
            reason: input.actor.reason,
          });
          return yield* new ControlPlaneError({
            code: "main_session_required",
            pluginId: input.pluginId,
            message: `Firewall policy for "builtin.egress-guard" can only be modified from a live local main ByteDock session (${input.actor.reason}).`,
          });
        }

        const expectedMtimeMs = input.expectedMtimeMs ?? st.mtimeMs;
        const prevEnabled =
          found.kind === "builtin"
            ? st.enabledByPlugin[input.pluginId] !== false
            : st.enabledByPlugin[input.pluginId] === true;

        // Determine if human approval is required for MCP callers.
        if (input.actor.kind !== "host-client") {
          const reasons: Array<string> = [];
          let approvalKind: "plugin-toggle" | "local-plugin-enable" = "plugin-toggle";
          let localFingerprint: string | undefined;

          if (isFirewall && !input.enabled) {
            reasons.push("disable-egress-guard");
          }
          if (found.kind === "local" && input.enabled) {
            const fp = found.local.permissionsFingerprint;
            localFingerprint = fp;
            const alreadyApproved = yield* approvals.isLocalPluginApproved(input.pluginId, fp);
            if (!alreadyApproved) {
              const prevFp = yield* approvals.getApprovedFingerprint(input.pluginId);
              approvalKind = "local-plugin-enable";
              reasons.push(
                prevFp ? "local-plugin-permission-escalation" : "unapproved-local-plugin",
              );
            }
          }

          if (reasons.length > 0) {
            if (input.actor.kind !== "mcp-main-thread") {
              yield* approvals.recordAudit({
                event: "privileged_denied_non_main",
                pluginId: input.pluginId,
                operation: "setEnabled",
                reasons,
                actor: input.actor.actorId,
              });
              return yield* new ControlPlaneError({
                code: "main_session_required",
                pluginId: input.pluginId,
                message: `Privileged plugin action on "${input.pluginId}" requires a live local main ByteDock session.`,
              });
            }
            const req = yield* approvals.createApproval({
              kind: approvalKind,
              pluginId: input.pluginId,
              reasons,
              summary:
                approvalKind === "local-plugin-enable"
                  ? `Enable local plugin ${input.pluginId} (${found.kind === "local" ? found.local.manifest.trust : "local-dev"})`
                  : `${input.enabled ? "Enable" : "Disable"} ${input.pluginId}`,
              diffPreview: {
                before: { enabled: prevEnabled },
                after: {
                  enabled: input.enabled,
                  ...(found.kind === "local"
                    ? { permissions: found.local.manifest.permissions }
                    : {}),
                },
              },
              requestedBy: {
                kind: "main-thread",
                threadId: input.actor.threadId,
                providerInstanceId: input.actor.providerInstanceId,
              },
              expectedMtimeMs,
              mutation: {
                kind: "set-enabled",
                pluginId: input.pluginId,
                enabled: input.enabled,
                permissionsFingerprint: localFingerprint,
              },
            });
            yield* emitControlEvent("approval-created", { requestId: req.requestId });
            return {
              status: "approval_required",
              request: req,
            } satisfies ControlPlaneMutationOutcome;
          }
        }

        const approvedLocalFingerprint =
          input.actor.kind === "host-client" && found.kind === "local" && input.enabled
            ? found.local.permissionsFingerprint
            : undefined;
        return yield* applyPersistedMutationUnlocked({
          pluginId: input.pluginId,
          expectedMtimeMs,
          enabled: input.enabled,
          approvedLocalFingerprint,
          actorSummary:
            input.actor.kind === "host-client"
              ? `host:${input.actor.actorId}`
              : input.actor.kind === "mcp-main-thread"
                ? `mcp-main:${input.actor.threadId}`
                : `mcp:${input.actor.actorId}`,
        });
      }),
    );

  const patchPluginConfig: PluginControlPlaneService["patchPluginConfig"] = (input) =>
    opGate.withPermits(1)(
      Effect.gen(function* () {
        let st = yield* Ref.get(stateRef);
        let found = findKnownPlugin(st, input.pluginId);
        if (!found) {
          yield* reloadUnlocked("discover-before-patch");
          st = yield* Ref.get(stateRef);
          found = findKnownPlugin(st, input.pluginId);
        }
        if (!found) {
          return yield* new ControlPlaneError({
            code: "plugin_not_found",
            pluginId: input.pluginId,
            message: `Unknown plugin "${input.pluginId}".`,
          });
        }

        const isFirewall = input.pluginId === "builtin.egress-guard";
        if (isFirewall && input.actor.kind === "mcp-non-main") {
          yield* approvals.recordAudit({
            event: "firewall_denied_non_main",
            pluginId: input.pluginId,
            operation: "patchConfig",
            actor: input.actor.actorId,
            reason: input.actor.reason,
          });
          return yield* new ControlPlaneError({
            code: "main_session_required",
            pluginId: input.pluginId,
            message: `Firewall rules for "builtin.egress-guard" can only be changed from a live local main ByteDock session (${input.actor.reason}).`,
          });
        }

        const prevConfig =
          st.configByPlugin[input.pluginId] ?? PluginKernel.getDefaultPluginConfig(input.pluginId);
        const validated = PluginKernel.validatePluginConfig(
          input.pluginId,
          input.patch,
          prevConfig,
        );
        if (!validated.ok) {
          return yield* new ControlPlaneError({
            code: "invalid_config",
            pluginId: input.pluginId,
            message: validated.message,
          });
        }

        const expectedMtimeMs = input.expectedMtimeMs ?? st.mtimeMs;
        const privilege = PluginKernel.assessConfigPatchPrivilege({
          pluginId: input.pluginId,
          prevConfig,
          nextConfig: validated.config,
          rawPatch: input.patch,
        });

        if (input.actor.kind !== "host-client" && privilege.requiresApproval) {
          if (input.actor.kind !== "mcp-main-thread") {
            yield* approvals.recordAudit({
              event: "privileged_denied_non_main",
              pluginId: input.pluginId,
              operation: "patchConfig",
              reasons: privilege.reasons,
              actor: input.actor.actorId,
            });
            return yield* new ControlPlaneError({
              code: "main_session_required",
              pluginId: input.pluginId,
              message: `Privileged config change for "${input.pluginId}" requires a live local main ByteDock session.`,
            });
          }

          const req = yield* approvals.createApproval({
            kind: "plugin-config-patch",
            pluginId: input.pluginId,
            reasons: privilege.reasons,
            summary: `Update privileged config for ${input.pluginId}: ${privilege.reasons.join(", ")}`,
            diffPreview: {
              before: prevConfig,
              after: validated.config,
            },
            requestedBy: {
              kind: "main-thread",
              threadId: input.actor.threadId,
              providerInstanceId: input.actor.providerInstanceId,
            },
            expectedMtimeMs,
            mutation: {
              kind: "patch-config",
              pluginId: input.pluginId,
              nextConfig: validated.config,
            },
          });
          yield* emitControlEvent("approval-created", { requestId: req.requestId });
          return {
            status: "approval_required",
            request: req,
          } satisfies ControlPlaneMutationOutcome;
        }

        return yield* applyPersistedMutationUnlocked({
          pluginId: input.pluginId,
          expectedMtimeMs,
          config: validated.config,
          actorSummary:
            input.actor.kind === "host-client"
              ? `host:${input.actor.actorId}`
              : input.actor.kind === "mcp-main-thread"
                ? `mcp-main:${input.actor.threadId}`
                : `mcp:${input.actor.actorId}`,
        });
      }),
    );

  const resolveApproval: PluginControlPlaneService["resolveApproval"] = (input) =>
    opGate.withPermits(1)(
      Effect.gen(function* () {
        if (input.actor.kind !== "host-client") {
          return yield* new ControlPlaneError({
            code: "host_client_required",
            requestId: input.requestId,
            message:
              "Approval requests can only be approved or rejected by an authenticated human host client.",
          });
        }

        const pending = yield* approvals.assertPendingForResolution(input.requestId).pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: err.code,
                requestId: err.requestId,
                message: err.message,
              }),
          ),
        );

        if (input.decision === "reject") {
          const rejected = yield* approvals
            .finalizeResolution({
              requestId: pending.requestId,
              decision: "rejected",
              resolvedBy: input.actor.actorId,
              note: input.note,
            })
            .pipe(
              Effect.mapError(
                (err) =>
                  new ControlPlaneError({
                    code: err.code,
                    requestId: err.requestId,
                    message: err.message,
                  }),
              ),
            );
          yield* emitControlEvent("approval-resolved", {
            requestId: rejected.requestId,
            decision: "rejected",
          });
          return { request: rejected } satisfies ControlPlaneApprovalResolution;
        }

        let applied:
          | Extract<ControlPlaneMutationOutcome, { readonly status: "applied" }>
          | undefined;
        let hostResult: unknown;

        if (pending.mutation.kind === "set-enabled") {
          applied = yield* applyPersistedMutationUnlocked({
            pluginId: pending.mutation.pluginId,
            expectedMtimeMs: pending.expectedMtimeMs,
            enabled: pending.mutation.enabled,
            approvedLocalFingerprint: pending.mutation.permissionsFingerprint,
            actorSummary: `host-approved:${input.actor.actorId}`,
          });
        } else if (pending.mutation.kind === "patch-config") {
          applied = yield* applyPersistedMutationUnlocked({
            pluginId: pending.mutation.pluginId,
            expectedMtimeMs: pending.expectedMtimeMs,
            config: pending.mutation.nextConfig,
            actorSummary: `host-approved:${input.actor.actorId}`,
          });
        } else {
          const hostActorId = input.actor.actorId;
          const executor = hostMutationExecutor;
          if (!executor) {
            return yield* new ControlPlaneError({
              code: "service_unavailable",
              requestId: pending.requestId,
              message: `Host mutation executor is unavailable for approval "${pending.kind}".`,
            });
          }
          hostResult = yield* executor({
            request: pending,
            mutation: pending.mutation,
            actorId: hostActorId,
          }).pipe(
            Effect.tapError((err) =>
              approvals.recordAudit({
                event: "host_mutation_failed",
                requestId: pending.requestId,
                kind: pending.kind,
                pluginId: pending.pluginId,
                actorId: hostActorId,
                code: err.code,
                message: err.message,
              }),
            ),
          );
        }

        const approved = yield* approvals
          .finalizeResolution({
            requestId: pending.requestId,
            decision: "approved",
            resolvedBy: input.actor.actorId,
            note: input.note,
          })
          .pipe(
            Effect.mapError(
              (err) =>
                new ControlPlaneError({
                  code: err.code,
                  requestId: err.requestId,
                  message: err.message,
                }),
            ),
          );
        yield* emitControlEvent("approval-resolved", {
          requestId: approved.requestId,
          decision: "approved",
          kind: approved.kind,
        });
        return {
          request: approved,
          ...(applied !== undefined ? { applied } : {}),
          ...(hostResult !== undefined ? { hostResult } : {}),
        } satisfies ControlPlaneApprovalResolution;
      }),
    );

  const reloadFromDisk: PluginControlPlaneService["reloadFromDisk"] = (opts) =>
    opGate.withPermits(1)(reloadUnlocked(opts?.reason ?? "manual-reload"));

  const getState: PluginControlPlaneService["getState"] = Effect.fn("PluginControlPlane.getState")(
    function* () {
      const [st, active, approvalList] = yield* Effect.all([
        Ref.get(stateRef),
        options.kernel.revisions.active(),
        approvals.listApprovals(),
      ]);
      const plugins = yield* buildPluginEntries(st, active.rev);
      return {
        pluginConfigPath: options.pluginConfigPath,
        pluginsDir: options.pluginsDir,
        mtimeMs: st.mtimeMs,
        activeRevision: active.rev,
        plugins,
        egressPolicy: options.kernel.egress.getPolicy(),
        ...(st.lastConfigDiagnostic ? { lastConfigDiagnostic: st.lastConfigDiagnostic } : {}),
        ...(st.lastReloadDiagnostic ? { lastReloadDiagnostic: st.lastReloadDiagnostic } : {}),
        approvals: approvalList,
      } satisfies ControlPlaneStateSnapshot;
    },
  );

  const listDescriptors: PluginControlPlaneService["listDescriptors"] = () =>
    getState().pipe(
      Effect.map((state) =>
        state.plugins.map((p): PluginRuntimeDescriptor => ({
          id: p.id,
          name: p.name,
          version: p.version,
          revision: p.revision,
          execution: p.execution,
          trust: p.trust,
          status: p.status,
        })),
      ),
    );

  const isPluginEnabled: PluginControlPlaneService["isPluginEnabled"] = (pluginId) =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((st) => {
        if (BUILTIN_BY_ID.has(pluginId)) {
          return Effect.succeed(st.enabledByPlugin[pluginId] !== false);
        }
        const local = st.localPlugins.find((p) => p.manifest.id === pluginId);
        if (!local) return Effect.succeed(false);
        return approvals
          .isLocalPluginApproved(pluginId, local.permissionsFingerprint)
          .pipe(Effect.map((approved) => approved && st.enabledByPlugin[pluginId] === true));
      }),
    );

  const getPluginConfig: PluginControlPlaneService["getPluginConfig"] = (pluginId) =>
    Ref.get(stateRef).pipe(
      Effect.map(
        (st) => st.configByPlugin[pluginId] ?? PluginKernel.getDefaultPluginConfig(pluginId),
      ),
    );

  const setHostMutationExecutor: PluginControlPlaneService["setHostMutationExecutor"] = (
    executor,
  ) => {
    hostMutationExecutor = executor;
  };

  const createHostApproval: PluginControlPlaneService["createHostApproval"] = Effect.fn(
    "PluginControlPlane.createHostApproval",
  )(function* (input) {
    const st = yield* Ref.get(stateRef);
    const req = yield* approvals.createApproval({
      kind: input.kind,
      pluginId: input.targetId,
      reasons: input.reasons,
      summary: input.summary,
      diffPreview: input.diffPreview,
      requestedBy: input.requestedBy,
      expectedMtimeMs: st.mtimeMs,
      mutation: input.mutation,
    });
    yield* emitControlEvent("approval-created", {
      requestId: req.requestId,
      kind: req.kind,
      targetId: req.pluginId,
    });
    return req;
  });

  const emitUiCommand: PluginControlPlaneService["emitUiCommand"] = Effect.fn(
    "PluginControlPlane.emitUiCommand",
  )(function* (command) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fullCommand: UiControlCommand = {
      ...command,
      commandId: NodeCrypto.randomUUID(),
      issuedAt: isoFromMs(nowMs),
    };
    yield* Ref.set(lastUiCommandRef, fullCommand);
    yield* approvals.recordAudit({
      event: "ui_command_emitted",
      commandId: fullCommand.commandId,
      action: fullCommand.action,
      actor: fullCommand.actor,
      ...(fullCommand.path !== undefined ? { path: fullCommand.path } : {}),
      ...(fullCommand.pluginId !== undefined ? { pluginId: fullCommand.pluginId } : {}),
    });
    yield* emitControlEvent("ui-command", { command: fullCommand });
    return fullCommand;
  });

  const getLastUiCommand: PluginControlPlaneService["getLastUiCommand"] = () =>
    Ref.get(lastUiCommandRef);

  const subscribeEvents: PluginControlPlaneService["subscribeEvents"] = () =>
    Stream.fromPubSub(eventsPubSub);

  // Boot sequence: register builtins, load initial plugins.yml & default pluginsDir.
  yield* registerBuiltinsOnce;
  yield* reloadFromDisk({ reason: "boot" });

  // Optional live fs.watch with 150ms debounce and self-write bounce suppression.
  if (options.watchFiles !== false) {
    const watchTrigger = yield* PubSub.sliding<string>(8);
    const configDir = NodePath.dirname(options.pluginConfigPath);
    const configFileName = NodePath.basename(options.pluginConfigPath);
    NodeFS.mkdirSync(configDir, { recursive: true });
    NodeFS.mkdirSync(options.pluginsDir, { recursive: true });

    const attachWatcher = (
      targetDir: string,
      recursive: boolean,
      onFilename: (filename: string | null) => void,
    ) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          try {
            return NodeFS.watch(targetDir, { recursive }, (_eventType, filename) => {
              onFilename(typeof filename === "string" ? filename : null);
            });
          } catch {
            return undefined;
          }
        }),
        (watcher) =>
          Effect.sync(() => {
            try {
              watcher?.close();
            } catch {
              // Best-effort watcher teardown.
            }
          }),
      );

    yield* attachWatcher(configDir, false, (filename) => {
      if (!filename || filename === configFileName) {
        PubSub.publishUnsafe(watchTrigger, "fs-config");
      }
    });
    yield* attachWatcher(options.pluginsDir, true, () => {
      PubSub.publishUnsafe(watchTrigger, "fs-plugins");
    });

    yield* Stream.fromPubSub(watchTrigger).pipe(
      Stream.debounce(Duration.millis(150)),
      Stream.runForEach((reason) =>
        Effect.gen(function* () {
          if (reason === "fs-config" && NodeFS.existsSync(options.pluginConfigPath)) {
            const diskMtime = Math.trunc(NodeFS.statSync(options.pluginConfigPath).mtimeMs);
            const lastWritten = yield* Ref.get(lastWrittenMtimeRef);
            if (lastWritten !== undefined && diskMtime === lastWritten) {
              return;
            }
          }
          yield* reloadFromDisk({ reason });
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }

  return {
    kernel: options.kernel,
    approvals,
    tokenOptimizer,
    stateDir: options.stateDir,
    pluginConfigPath: options.pluginConfigPath,
    pluginsDir: options.pluginsDir,
    getState,
    listDescriptors,
    isPluginEnabled,
    getPluginConfig,
    setPluginEnabled,
    patchPluginConfig,
    setHostMutationExecutor,
    createHostApproval,
    emitUiCommand,
    getLastUiCommand,
    resolveApproval,
    reloadFromDisk,
    subscribeEvents,
  } satisfies PluginControlPlaneService;
});

export const layer = Layer.effect(
  PluginControlPlane,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const kernel = yield* PluginKernel.PluginKernel;
    return yield* makePluginControlPlane({
      kernel,
      stateDir: config.stateDir,
      logsDir: config.logsDir,
      pluginConfigPath: config.pluginConfigPath,
      pluginsDir: config.pluginsDir,
      watchFiles: true,
    });
  }),
);

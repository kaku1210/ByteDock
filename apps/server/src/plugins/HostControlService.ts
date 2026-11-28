// @effect-diagnostics nodeBuiltinImport:off -- Local plugin scaffolding writes manifest.json and index.ts into default ~/.bytedock/plugins.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ExternalTunnelActionInput,
  LaunchEditorInput,
  ProviderInstanceMutation,
  ServerRemoveKeybindingInput,
  ServerSettings as ServerSettingsContract,
  ServerSettingsPatch,
  ServerUpsertKeybindingInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalWriteInput,
  containsSecretReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PluginKernel from "@bytedock/plugin-kernel";
import * as Keybindings from "../keybindings.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ExternalTunnelService from "../tunnel/ExternalTunnelService.ts";
import { BUILTIN_PLUGIN_MANIFESTS } from "./BuiltinPluginManifests.ts";
import * as BuiltinPluginRuntime from "./BuiltinPluginRuntime.ts";
import {
  discoverLegacySourcesReadOnly,
  runLegacyReadOnlyImport,
  scanLegacySourceReadOnly,
  type LegacyImportCategory,
  type LegacySourceBrand,
} from "./LegacyT3Importer.ts";
import type {
  ControlPlaneApprovalRequest,
  HostApprovalMutation,
  HostSystemActionKind,
} from "./PluginApprovalStore.ts";
import {
  CONTROL_PLANE_PLUGIN_ID,
  ControlPlaneError,
  type ControlPlaneActor,
  type PluginControlPlaneService,
  type UiControlCommand,
} from "./PluginControlPlane.ts";

const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettingsContract);
const decodeProviderInstanceMutation = Schema.decodeUnknownSync(ProviderInstanceMutation);
const decodeUpsertKeybinding = Schema.decodeUnknownSync(ServerUpsertKeybindingInput);
const decodeRemoveKeybinding = Schema.decodeUnknownSync(ServerRemoveKeybindingInput);
const decodeExternalTunnelAction = Schema.decodeUnknownSync(ExternalTunnelActionInput);
const decodeLaunchEditor = Schema.decodeUnknownSync(LaunchEditorInput);
const decodeTerminalOpen = Schema.decodeUnknownSync(TerminalOpenInput);
const decodeTerminalWrite = Schema.decodeUnknownSync(TerminalWriteInput);
const decodeTerminalClose = Schema.decodeUnknownSync(TerminalCloseInput);

const VALID_LEGACY_CATEGORIES = new Set<LegacyImportCategory>([
  "settings",
  "keybindings",
  "themes",
  "stateDb",
  "attachments",
  "usageDb",
  "secrets",
]);

const VALID_UI_PRIMITIVES = new Set<string>([
  "Stack",
  "Row",
  "Text",
  "Badge",
  "Card",
  "Tabs",
  "Button",
  "Toggle",
  "Select",
  "Progress",
  "StreamLog",
  "TerminalView",
]);

const LOCAL_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const BUILTIN_ID_SET = new Set<string>([
  CONTROL_PLANE_PLUGIN_ID,
  ...BUILTIN_PLUGIN_MANIFESTS.map((m) => m.id),
]);

/** Explicit high-risk ServerSettings keys requiring live local main session + human approval. */
const HIGH_RISK_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "providerInstances",
  "providers",
  "secretProviders",
  "cloudSpeechCredentials",
  "sourceControlHosts",
  "offeredSourceControlProviders",
  "usageLimitSources",
  "textGenerators",
  "setProviderModelOrder",
  "providerModelPreferences",
  "enableProviderUpdateChecks",
  "providerHealthRefreshInterval",
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "nextPromptSuggestionModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "speechPostProcessingModelSelection",
  "defaultRuntimeMode",
  "requireConnectDeviceApproval",
  "enableAgentBrowserAccess",
  "projectAgentBrowserAccessOverrides",
  "enablePreviewTunnel",
  "externalTunnel",
  "guestSharingEnabled",
  "linkedEnvironmentsEnabled",
  "enableAgentDeviceAccess",
  "enableDeviceSupport",
  "deviceOnboardingCompleted",
  "deviceHosts",
  "easDeviceHosts",
  "simlockDeviceHosts",
  "simlockDeviceHostsEnabled",
  "observability",
  "defaultProjectScripts",
  "projectScriptOverrides",
  "projectSettingsOverrides",
  "worktreesDirectory",
]);

const LOW_RISK_SETTINGS_SAFE_KEYS: ReadonlySet<string> = new Set([
  "defaultTheme",
  "defaultThemeSetAt",
  "defaultAppearance",
  "defaultAppearanceSetAt",
  "responseStreamingMode",
  "agentFeedback",
  "continueThreadsAfterServerUpdate",
  "keepAwakeWhileAgentsWork",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "sidebarAutoSettleOnMerge",
  "idleCompaction",
  "compactIdleThreads",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "hiddenThreadTags",
  "hideTaggedThreads",
  "workflowsEnabled",
  "workflowSkippedRunsKept",
  "promptSuggestionsEnabled",
  "nextPromptSuggestionsEnabled",
  "backgroundActivity",
  "backgroundActivityProfile",
  "automaticGitFetchInterval",
  "environmentIcon",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "addProjectBaseDirectory",
  "ghqCloneLayout",
  "threadTitleInstructions",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "removeAgentCreditsOnMerge",
  "sourceControlWritingStyle",
  "reviewGuidesEnabled",
  "reviewGuideInstructions",
  "pullRequestMergeMethod",
  "usageHistoryRetentionDays",
  "usagePriceOverrides",
  "usageModelAliases",
  "coordinatorRoleTemplates",
  "defaultCoordinatorRoleTemplateId",
  "speechModelId",
  "speechAcceleration",
  "speechModelUnloadTimeout",
  "speechProjectCustomWords",
  "favorites",
  "setModelFavorites",
  "setModelsHidden",
  "fastWorktreeCheckout",
  "defaultAutoPull",
  "projectAutoPullOverrides",
  "worktreeCleanup",
  "storageCleanup",
]);

const FAIL_SAFE_HIGH_RISK_SUBSTRINGS = [
  "secret",
  "token",
  "provider",
  "host",
  "tunnel",
  "device",
  "runtimemode",
  "policy",
  "otlp",
  "observability",
  "credential",
  "browseraccess",
  "guestsharing",
  "linkedenvironments",
  "modelselection",
  "projectscript",
  "textgenerator",
] as const;

function classifyServerSettingsPatchRisk(patch: Readonly<Record<string, unknown>>): {
  readonly highRiskKeys: ReadonlyArray<string>;
  readonly reasons: ReadonlyArray<string>;
} {
  const highRiskKeys: Array<string> = [];
  const reasons: Array<string> = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (HIGH_RISK_SETTINGS_KEYS.has(key)) {
      highRiskKeys.push(key);
      reasons.push(`high-risk-setting:${key}`);
      continue;
    }
    if (!LOW_RISK_SETTINGS_SAFE_KEYS.has(key)) {
      const lower = key.toLowerCase();
      if (FAIL_SAFE_HIGH_RISK_SUBSTRINGS.some((token) => lower.includes(token))) {
        highRiskKeys.push(key);
        reasons.push(`fail-safe-high-risk-setting:${key}`);
      }
    }
  }

  if (containsSecretReference(patch)) {
    reasons.push("contains-secret-reference");
  }

  return { highRiskKeys, reasons };
}

function isSafeInternalRoutePath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  if (trimmed.includes("://") || trimmed.includes("\\")) return false;
  if (/[\r\n\0]/.test(trimmed)) return false;
  if (/^\s*(javascript|data|vbscript):/i.test(trimmed)) return false;
  return true;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDockPanelNode(node: unknown, depth = 0): string | undefined {
  if (depth > 8) return "UI dock panel node nesting depth exceeds limit (8).";
  if (!isPlainObject(node)) return "UI dock panel node must be a JSON object.";
  if (typeof node.t !== "string" || !VALID_UI_PRIMITIVES.has(node.t)) {
    return `Unsupported plugin UI primitive "${String(node.t)}". Allowed primitives: ${[...VALID_UI_PRIMITIVES].join(", ")}.`;
  }
  if (node.c !== undefined) {
    if (!Array.isArray(node.c)) return 'UI node children "c" must be an array.';
    for (const child of node.c) {
      const err = validateDockPanelNode(child, depth + 1);
      if (err) return err;
    }
  }
  return undefined;
}

function validateLegacyCategories(
  raw: ReadonlyArray<string> | undefined,
): ReadonlyArray<LegacyImportCategory> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: Array<LegacyImportCategory> = [];
  for (const item of raw) {
    if (!VALID_LEGACY_CATEGORIES.has(item as LegacyImportCategory)) {
      return undefined;
    }
    if (!out.includes(item as LegacyImportCategory)) {
      out.push(item as LegacyImportCategory);
    }
  }
  return out;
}

function redactAndEncodeSettings(settings: ServerSettingsContract) {
  const redacted = ServerSettings.redactServerSettingsForClient(settings, {
    secretReferences: true,
    httpUsageLimitSources: true,
  });
  return encodeServerSettings(redacted);
}

function extractPatchPreviewBefore(
  redactedSettings: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    before[key] = redactedSettings[key];
  }
  return before;
}

function actorToLabel(actor: ControlPlaneActor): string {
  if (actor.kind === "host-client") return `host:${actor.actorId}`;
  if (actor.kind === "mcp-main-thread") return `mcp-main:${actor.threadId}`;
  return `mcp:${actor.actorId}`;
}

function formatCauseMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (
    isPlainObject(cause) &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  ) {
    return cause.message;
  }
  if (isPlainObject(cause) && typeof cause.reason === "string" && cause.reason.trim().length > 0) {
    return cause.reason;
  }
  return String(cause);
}

function decodeOrFail<A>(decode: (value: unknown) => A, input: unknown, label: string) {
  return Effect.try({
    try: () => decode(input),
    catch: (cause) =>
      new ControlPlaneError({
        code: "invalid_config",
        message: `Invalid ${label}: ${formatCauseMessage(cause)}`,
      }),
  });
}

function writeScaffoldFiles(input: {
  readonly pluginsDir: string;
  readonly pluginId: string;
  readonly displayName: string;
  readonly description: string;
}) {
  const resolvedRoot = NodePath.resolve(input.pluginsDir);
  const pluginDir = NodePath.resolve(resolvedRoot, input.pluginId);
  if (pluginDir === resolvedRoot || !pluginDir.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
    throw new Error("Resolved scaffold target escapes ByteDock pluginsDir.");
  }
  if (NodeFS.existsSync(pluginDir)) {
    throw new Error(`Plugin directory "${pluginDir}" already exists; refusing to overwrite.`);
  }
  const manifestPath = NodePath.join(pluginDir, "manifest.json");
  const entryPath = NodePath.join(pluginDir, "index.ts");
  const manifest = {
    id: input.pluginId,
    name: input.displayName,
    version: "0.1.0",
    apiVersion: "0.1",
    description: input.description,
    execution: "trusted-worker",
    trust: "local-dev",
    entry: { server: "./index.ts" },
    permissions: {
      storage: "none",
      networkHosts: [],
    },
  };
  const entrySource = [
    `/** Local ByteDock plugin scaffold: ${input.pluginId} */`,
    "export const activate = () => ({",
    `  pluginId: ${JSON.stringify(input.pluginId)},`,
    "  ready: true,",
    "});",
    "",
  ].join("\n");

  NodeFS.mkdirSync(pluginDir, { recursive: true });
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  NodeFS.writeFileSync(entryPath, entrySource, "utf8");
  return { pluginDir, manifestPath, entryPath };
}

export interface HostControlDependencies {
  readonly controlPlane: PluginControlPlaneService;
  readonly serverSettings?:
    | Context.Service.Shape<typeof ServerSettings.ServerSettingsService>
    | undefined;
  readonly keybindings?: Context.Service.Shape<typeof Keybindings.Keybindings> | undefined;
  readonly hostResources?: Context.Service.Shape<typeof HostResources.HostResources> | undefined;
  readonly storageCleanup?: Context.Service.Shape<typeof StorageCleanup.StorageCleanup> | undefined;
  readonly databaseStorage?:
    | Context.Service.Shape<typeof DatabaseStorage.DatabaseStorage>
    | undefined;
  readonly externalTunnel?:
    | Context.Service.Shape<typeof ExternalTunnelService.ExternalTunnelService>
    | undefined;
  readonly externalLauncher?:
    | Context.Service.Shape<typeof ExternalLauncher.ExternalLauncher>
    | undefined;
  readonly terminalManager?:
    | Context.Service.Shape<typeof TerminalManager.TerminalManager>
    | undefined;
}

export interface HostControlOutcome {
  readonly status: "ok" | "applied" | "approval_required";
  readonly applied: boolean;
  readonly data?: unknown;
  readonly approval?: ControlPlaneApprovalRequest | undefined;
  readonly message?: string | undefined;
}

export interface HostControlCapabilitiesCatalog {
  readonly version: "1.0";
  readonly policy: {
    readonly lowRisk: string;
    readonly highRisk: string;
    readonly secrets: string;
  };
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly domain: string;
    readonly riskTier: "read-only" | "low-risk" | "mixed" | "high-risk";
    readonly actions: ReadonlyArray<{
      readonly action: string;
      readonly risk: "read-only" | "low-risk" | "high-risk" | "conditional";
      readonly description: string;
    }>;
  }>;
  readonly services: {
    readonly pluginControlPlane: boolean;
    readonly serverSettings: boolean;
    readonly keybindings: boolean;
    readonly hostResources: boolean;
    readonly storageCleanup: boolean;
    readonly databaseStorage: boolean;
    readonly externalTunnel: boolean;
    readonly externalLauncher: boolean;
    readonly terminalManager: boolean;
  };
  readonly activeRevision: number;
  readonly pendingApprovalsCount: number;
}

export interface HostControlServiceShape {
  readonly getCapabilitiesCatalog: () => Effect.Effect<HostControlCapabilitiesCatalog>;
  readonly readSettingsBundle: () => Effect.Effect<
    {
      readonly settings: unknown;
      readonly settingsAvailable: boolean;
      readonly keybindings: unknown;
      readonly keybindingsAvailable: boolean;
      readonly availableEditors: ReadonlyArray<string>;
      readonly externalLauncherAvailable: boolean;
      readonly highRiskSettingsKeys: ReadonlyArray<string>;
    },
    ControlPlaneError
  >;
  readonly patchServerSettings: (input: {
    readonly patch: Readonly<Record<string, unknown>>;
    readonly actor: ControlPlaneActor;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
  readonly upsertKeybinding: (input: {
    readonly rule: Readonly<Record<string, unknown>>;
    readonly actor: ControlPlaneActor;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
  readonly removeKeybinding: (input: {
    readonly rule: Readonly<Record<string, unknown>>;
    readonly actor: ControlPlaneActor;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
  readonly updateProviderInstance: (input: {
    readonly mutation: Readonly<Record<string, unknown>>;
    readonly patch?: Readonly<Record<string, unknown>> | undefined;
    readonly actor: ControlPlaneActor;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
  readonly runPluginAction: (input: {
    readonly action:
      | "egress_proof"
      | "egress_audit"
      | "legacy_scan"
      | "legacy_import"
      | "invoke"
      | "scaffold_local_plugin";
    readonly actor: ControlPlaneActor;
    readonly pluginId?: string | undefined;
    readonly method?: string | undefined;
    readonly payload?: Readonly<Record<string, unknown>> | undefined;
    readonly customSourceDir?: string | undefined;
    readonly sourceBaseDir?: string | undefined;
    readonly sourceBrand?: LegacySourceBrand | undefined;
    readonly categories?: ReadonlyArray<string> | undefined;
    readonly overwrite?: boolean | undefined;
    readonly deferLockedStateDb?: boolean | undefined;
    readonly displayName?: string | undefined;
    readonly description?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
  readonly runUiControl: (input: {
    readonly action: UiControlCommand["action"];
    readonly actor: ControlPlaneActor;
    readonly tab?: "plugins" | "xray" | "import" | undefined;
    readonly pluginId?: string | undefined;
    readonly node?: unknown;
    readonly path?: string | undefined;
    readonly message?: string | undefined;
    readonly level?: "info" | "success" | "warning" | "error" | undefined;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
  readonly runSystemControl: (input: {
    readonly action: "status" | "open_editor" | HostSystemActionKind;
    readonly actor: ControlPlaneActor;
    readonly payload?: Readonly<Record<string, unknown>> | undefined;
  }) => Effect.Effect<HostControlOutcome, ControlPlaneError>;
}

export class HostControlService extends Context.Service<
  HostControlService,
  HostControlServiceShape
>()("t3/plugins/HostControlService") {}

/** Unified ByteDock host control facade coordinating settings, plugins, UI bus, system actions, and human approvals. */
export const makeHostControlService = (deps: HostControlDependencies): HostControlServiceShape => {
  const { controlPlane } = deps;

  const assertMainSessionForHighRisk = Effect.fn("HostControlService.assertMainSessionForHighRisk")(
    function* (
      actor: ControlPlaneActor,
      targetId: string,
      operation: string,
      reasons: ReadonlyArray<string>,
    ) {
      if (actor.kind === "mcp-main-thread") {
        return {
          kind: "main-thread" as const,
          threadId: actor.threadId,
          providerInstanceId: actor.providerInstanceId,
        };
      }
      if (actor.kind === "host-client") {
        return undefined;
      }
      yield* controlPlane.approvals.recordAudit({
        event: "privileged_denied_non_main",
        pluginId: targetId,
        operation,
        reasons,
        actor: actor.actorId,
        reason: actor.reason,
      });
      return yield* new ControlPlaneError({
        code: "main_session_required",
        pluginId: targetId,
        message: `Privileged ByteDock action "${operation}" requires a live local main ByteDock session (${actor.reason}).`,
      });
    },
  );

  const executeHostMutation = Effect.fn("HostControlService.executeHostMutation")(
    function* (input: {
      readonly request: ControlPlaneApprovalRequest;
      readonly mutation: HostApprovalMutation;
      readonly actorId: string;
    }): Effect.fn.Return<unknown, ControlPlaneError> {
      const { mutation, request, actorId } = input;
      if (mutation.kind === "host-settings-patch") {
        if (!deps.serverSettings) {
          return yield* new ControlPlaneError({
            code: "service_unavailable",
            requestId: request.requestId,
            message: "ServerSettingsService is unavailable on this ByteDock host.",
          });
        }
        const decoded = yield* decodeOrFail(
          decodeServerSettingsPatch,
          mutation.patch,
          "ServerSettingsPatch",
        );
        const updated = yield* deps.serverSettings.updateSettings(decoded).pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                requestId: request.requestId,
                message: `Failed applying approved settings patch: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        yield* controlPlane.approvals.recordAudit({
          event: "host_settings_applied",
          requestId: request.requestId,
          actorId,
          keys: Object.keys(mutation.patch),
        });
        return {
          settings: redactAndEncodeSettings(updated),
        };
      }

      if (mutation.kind === "provider-mutation") {
        if (!deps.serverSettings) {
          return yield* new ControlPlaneError({
            code: "service_unavailable",
            requestId: request.requestId,
            message: "ServerSettingsService is unavailable on this ByteDock host.",
          });
        }
        const decodedMutation = yield* decodeOrFail(
          decodeProviderInstanceMutation,
          mutation.mutation,
          "ProviderInstanceMutation",
        );
        const decodedPatch =
          mutation.patch !== undefined
            ? yield* decodeOrFail(decodeServerSettingsPatch, mutation.patch, "ServerSettingsPatch")
            : undefined;
        const updated = yield* deps.serverSettings
          .updateProviderInstance(decodedMutation, decodedPatch)
          .pipe(
            Effect.mapError(
              (err) =>
                new ControlPlaneError({
                  code: "action_failed",
                  requestId: request.requestId,
                  message: `Failed applying approved provider mutation: ${formatCauseMessage(err)}`,
                }),
            ),
          );
        yield* controlPlane.approvals.recordAudit({
          event: "host_provider_mutation_applied",
          requestId: request.requestId,
          actorId,
          operation: decodedMutation.operation,
          instanceId: decodedMutation.instanceId,
        });
        return {
          providerInstances: redactAndEncodeSettings(updated).providerInstances,
        };
      }

      if (mutation.kind === "legacy-import") {
        const categories = validateLegacyCategories(mutation.categories);
        if (!categories) {
          return yield* new ControlPlaneError({
            code: "invalid_config",
            requestId: request.requestId,
            message: "Invalid legacy import categories in approval payload.",
          });
        }
        const report = yield* Effect.try({
          try: () =>
            runLegacyReadOnlyImport({
              sourceBaseDir: mutation.sourceBaseDir,
              sourceBrand: mutation.sourceBrand,
              targetStateDir: controlPlane.stateDir,
              categories,
              overwrite: mutation.overwrite,
              deferLockedStateDb: mutation.deferLockedStateDb,
            }),
          catch: (cause) =>
            new ControlPlaneError({
              code: "action_failed",
              requestId: request.requestId,
              message: `Legacy T3 read-only import failed: ${formatCauseMessage(cause)}`,
            }),
        });
        yield* controlPlane.approvals.recordAudit({
          event: "host_legacy_import_applied",
          requestId: request.requestId,
          actorId,
          sourceBaseDir: mutation.sourceBaseDir,
          categories,
          restartRequired: report.restartRequired,
        });
        return report;
      }

      // mutation.kind === "system-action"
      const action = mutation.action;
      if (action === "storage_cleanup") {
        if (!deps.storageCleanup) {
          return yield* new ControlPlaneError({
            code: "service_unavailable",
            requestId: request.requestId,
            message: "StorageCleanup service is unavailable.",
          });
        }
        const report = yield* deps.storageCleanup.runNow.pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                requestId: request.requestId,
                message: `Storage cleanup failed: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        yield* controlPlane.approvals.recordAudit({
          event: "host_system_action_applied",
          requestId: request.requestId,
          actorId,
          action,
        });
        return report;
      }

      if (action === "database_reclaim") {
        if (!deps.databaseStorage) {
          return yield* new ControlPlaneError({
            code: "service_unavailable",
            requestId: request.requestId,
            message: "DatabaseStorage service is unavailable.",
          });
        }
        yield* deps.databaseStorage.requestReclaim.pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                requestId: request.requestId,
                message: `Database reclaim failed: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        yield* controlPlane.approvals.recordAudit({
          event: "host_system_action_applied",
          requestId: request.requestId,
          actorId,
          action,
        });
        return { reclaimScheduled: true, restartTriggered: true };
      }

      if (action === "tunnel_action") {
        if (!deps.externalTunnel) {
          return yield* new ControlPlaneError({
            code: "service_unavailable",
            requestId: request.requestId,
            message: "ExternalTunnelService is unavailable.",
          });
        }
        const decoded = yield* decodeOrFail(
          decodeExternalTunnelAction,
          mutation.payload,
          "ExternalTunnelActionInput",
        );
        const status = yield* deps.externalTunnel.action(decoded).pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                requestId: request.requestId,
                message: `External tunnel action failed: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        yield* controlPlane.approvals.recordAudit({
          event: "host_system_action_applied",
          requestId: request.requestId,
          actorId,
          action,
          tunnelAction: decoded.action,
        });
        return status;
      }

      if (!deps.terminalManager) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          requestId: request.requestId,
          message: "TerminalManager service is unavailable.",
        });
      }

      if (action === "terminal_open") {
        const decoded = yield* decodeOrFail(
          decodeTerminalOpen,
          mutation.payload,
          "TerminalOpenInput",
        );
        const snapshot = yield* deps.terminalManager.open(decoded).pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                requestId: request.requestId,
                message: `Terminal open failed: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        yield* controlPlane.approvals.recordAudit({
          event: "host_system_action_applied",
          requestId: request.requestId,
          actorId,
          action,
          threadId: decoded.threadId,
          terminalId: decoded.terminalId,
        });
        return snapshot;
      }

      if (action === "terminal_write") {
        const decoded = yield* decodeOrFail(
          decodeTerminalWrite,
          mutation.payload,
          "TerminalWriteInput",
        );
        yield* deps.terminalManager.write(decoded).pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                requestId: request.requestId,
                message: `Terminal write failed: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        yield* controlPlane.approvals.recordAudit({
          event: "host_system_action_applied",
          requestId: request.requestId,
          actorId,
          action,
          threadId: decoded.threadId,
          terminalId: decoded.terminalId,
        });
        return { written: true, threadId: decoded.threadId, terminalId: decoded.terminalId };
      }

      const decoded = yield* decodeOrFail(
        decodeTerminalClose,
        mutation.payload,
        "TerminalCloseInput",
      );
      yield* deps.terminalManager.close(decoded).pipe(
        Effect.mapError(
          (err) =>
            new ControlPlaneError({
              code: "action_failed",
              requestId: request.requestId,
              message: `Terminal close failed: ${formatCauseMessage(err)}`,
            }),
        ),
      );
      yield* controlPlane.approvals.recordAudit({
        event: "host_system_action_applied",
        requestId: request.requestId,
        actorId,
        action,
        threadId: decoded.threadId,
        ...(decoded.terminalId !== undefined ? { terminalId: decoded.terminalId } : {}),
      });
      return { closed: true, threadId: decoded.threadId };
    },
  );

  // Register unified host mutation executor on the shared PluginControlPlane singleton.
  controlPlane.setHostMutationExecutor(executeHostMutation);

  const getCapabilitiesCatalog: HostControlServiceShape["getCapabilitiesCatalog"] = Effect.fn(
    "HostControlService.getCapabilitiesCatalog",
  )(function* () {
    const state = yield* controlPlane.getState();
    return {
      version: "1.0" as const,
      policy: {
        lowRisk:
          "Read operations, normal plugin toggles/configs, non-privileged server settings, keybindings, UI control, open_editor, and safe local plugin scaffolding apply directly.",
        highRisk:
          "Firewall relaxations, unapproved local plugins, high-risk settings, provider instance mutations, legacy T3 import, storage cleanup, database reclaim, external tunnel actions, and terminal control require a live local main ByteDock session and human approval in ByteDock Control Center.",
        secrets:
          "Plaintext secrets are never read, echoed, or accepted in configs/settings; always use secretRef / request_secret.",
      },
      tools: [
        {
          name: "bytedock_capabilities_catalog",
          domain: "discovery",
          riskTier: "read-only",
          actions: [
            {
              action: "catalog",
              risk: "read-only",
              description:
                "Return full ByteDock AI control capabilities, risk tiers, and live host service availability.",
            },
          ],
        },
        {
          name: "bytedock_config_read",
          domain: "plugins",
          riskTier: "read-only",
          actions: [
            {
              action: "read",
              risk: "read-only",
              description:
                "Read plugins.yml path, ~/.bytedock/plugins path, active revision, plugin states, egress policy, diagnostics, and approvals.",
            },
          ],
        },
        {
          name: "bytedock_plugin_set_enabled",
          domain: "plugins",
          riskTier: "mixed",
          actions: [
            {
              action: "set_enabled",
              risk: "conditional",
              description:
                "Enable/disable normal plugins directly; disabling egress-guard or enabling unapproved local plugins requires main-session approval.",
            },
          ],
        },
        {
          name: "bytedock_plugin_config_patch",
          domain: "plugins",
          riskTier: "mixed",
          actions: [
            {
              action: "patch_config",
              risk: "conditional",
              description:
                "Schema-validated hot-reload patch for plugin config; firewall/permission expansions require main-session approval.",
            },
          ],
        },
        {
          name: "bytedock_plugins_reload",
          domain: "plugins",
          riskTier: "low-risk",
          actions: [
            {
              action: "reload",
              risk: "low-risk",
              description:
                "Re-read plugins.yml and scan ~/.bytedock/plugins with hot reload and diagnostics.",
            },
          ],
        },
        {
          name: "bytedock_settings_control",
          domain: "settings",
          riskTier: "mixed",
          actions: [
            {
              action: "read",
              risk: "read-only",
              description:
                "Read redacted ServerSettings, resolved keybindings, and available editors.",
            },
            {
              action: "patch_settings",
              risk: "conditional",
              description:
                "Patch ServerSettings (low-risk keys apply directly; high-risk keys require main-session approval; plaintext secrets rejected).",
            },
            {
              action: "upsert_keybinding",
              risk: "low-risk",
              description: "Upsert a ByteDock keybinding rule immediately.",
            },
            {
              action: "remove_keybinding",
              risk: "low-risk",
              description: "Remove a ByteDock keybinding rule immediately.",
            },
            {
              action: "update_provider",
              risk: "high-risk",
              description:
                "Create, upsert, or remove a provider instance (main-session + human approval required).",
            },
          ],
        },
        {
          name: "bytedock_plugin_action",
          domain: "plugins-actions",
          riskTier: "mixed",
          actions: [
            {
              action: "egress_proof",
              risk: "low-risk",
              description: "Run live + detached dual-segment EgressProof firewall verification.",
            },
            {
              action: "egress_audit",
              risk: "read-only",
              description: "Read current Egress Guard policy, audit counters, and recent events.",
            },
            {
              action: "legacy_scan",
              risk: "read-only",
              description: "Scan local T3 Code / T3 Code Plus directories read-only.",
            },
            {
              action: "legacy_import",
              risk: "high-risk",
              description:
                "Request read-only import from T3 Code / T3 Code Plus into ByteDock (main-session + human approval required).",
            },
            {
              action: "invoke",
              risk: "low-risk",
              description: "Invoke an enabled non-privileged plugin RPC method.",
            },
            {
              action: "scaffold_local_plugin",
              risk: "low-risk",
              description:
                "Create a safe disabled/unapproved local plugin skeleton in ~/.bytedock/plugins.",
            },
          ],
        },
        {
          name: "bytedock_ui_control",
          domain: "ui",
          riskTier: "low-risk",
          actions: [
            {
              action: "open_control_center",
              risk: "low-risk",
              description:
                "Open ByteDock Control Center modal on 'plugins', 'xray', or 'import' tab.",
            },
            {
              action: "close_control_center",
              risk: "low-risk",
              description: "Close ByteDock Control Center modal.",
            },
            {
              action: "open_dock_panel",
              risk: "low-risk",
              description:
                "Render a validated 12-primitive JsonNode in the right plugin dock panel.",
            },
            {
              action: "close_dock_panel",
              risk: "low-risk",
              description: "Close the active right plugin dock panel.",
            },
            {
              action: "navigate",
              risk: "low-risk",
              description: "Navigate to a safe internal ByteDock route starting with '/'.",
            },
            {
              action: "notify",
              risk: "low-risk",
              description: "Display a non-blocking status notification banner in the ByteDock UI.",
            },
          ],
        },
        {
          name: "bytedock_system_control",
          domain: "system",
          riskTier: "mixed",
          actions: [
            {
              action: "status",
              risk: "read-only",
              description:
                "Read CPU/RAM telemetry, storage cleanup report, database storage status, external tunnel status, and available editors.",
            },
            {
              action: "open_editor",
              risk: "low-risk",
              description: "Open a local path in an installed desktop editor or file manager.",
            },
            {
              action: "storage_cleanup",
              risk: "high-risk",
              description:
                "Run StorageCleanup immediately (main-session + human approval required).",
            },
            {
              action: "database_reclaim",
              risk: "high-risk",
              description:
                "Request offline SQLite reclaim (restarts ByteDock server; main-session + human approval required).",
            },
            {
              action: "tunnel_action",
              risk: "high-risk",
              description:
                "Execute external tunnel action start/stop/restart/check/acknowledgeAlert (main-session + human approval required).",
            },
            {
              action: "terminal_open",
              risk: "high-risk",
              description:
                "Open a host PTY terminal session (main-session + human approval required).",
            },
            {
              action: "terminal_write",
              risk: "high-risk",
              description:
                "Write input to a host PTY terminal session (main-session + human approval required).",
            },
            {
              action: "terminal_close",
              risk: "high-risk",
              description:
                "Close host PTY terminal session(s) (main-session + human approval required).",
            },
          ],
        },
      ],
      services: {
        pluginControlPlane: true,
        serverSettings: deps.serverSettings !== undefined,
        keybindings: deps.keybindings !== undefined,
        hostResources: deps.hostResources !== undefined,
        storageCleanup: deps.storageCleanup !== undefined,
        databaseStorage: deps.databaseStorage !== undefined,
        externalTunnel: deps.externalTunnel !== undefined,
        externalLauncher: deps.externalLauncher !== undefined,
        terminalManager: deps.terminalManager !== undefined,
      },
      activeRevision: state.activeRevision,
      pendingApprovalsCount: state.approvals.filter((a) => a.status === "pending").length,
    };
  });

  const readSettingsBundle: HostControlServiceShape["readSettingsBundle"] = Effect.fn(
    "HostControlService.readSettingsBundle",
  )(function* () {
    const settings = deps.serverSettings
      ? yield* deps.serverSettings.getSettings.pipe(
          Effect.map(redactAndEncodeSettings),
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                message: `Failed reading ServerSettings: ${formatCauseMessage(err)}`,
              }),
          ),
        )
      : null;

    const keybindings = deps.keybindings
      ? yield* deps.keybindings.getSnapshot.pipe(
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                message: `Failed reading Keybindings: ${formatCauseMessage(err)}`,
              }),
          ),
        )
      : null;

    const availableEditors = deps.externalLauncher
      ? yield* deps.externalLauncher.resolveAvailableEditors()
      : [];

    return {
      settings,
      settingsAvailable: deps.serverSettings !== undefined,
      keybindings,
      keybindingsAvailable: deps.keybindings !== undefined,
      availableEditors,
      externalLauncherAvailable: deps.externalLauncher !== undefined,
      highRiskSettingsKeys: [...HIGH_RISK_SETTINGS_KEYS].sort(),
    };
  });

  const patchServerSettings: HostControlServiceShape["patchServerSettings"] = Effect.fn(
    "HostControlService.patchServerSettings",
  )(function* (input) {
    if (!deps.serverSettings) {
      return yield* new ControlPlaneError({
        code: "service_unavailable",
        message: "ServerSettingsService is unavailable on this ByteDock host.",
      });
    }
    const secretHit = PluginKernel.findPlaintextSecretViolation(input.patch, "settings");
    if (secretHit) {
      return yield* new ControlPlaneError({
        code: "invalid_config",
        message: secretHit,
      });
    }
    const decodedPatch = yield* decodeOrFail(
      decodeServerSettingsPatch,
      input.patch,
      "ServerSettingsPatch",
    );
    const { highRiskKeys, reasons } = classifyServerSettingsPatchRisk(input.patch);

    if (input.actor.kind !== "host-client" && reasons.length > 0) {
      const requestedBy = yield* assertMainSessionForHighRisk(
        input.actor,
        "host.settings",
        "patch_settings",
        reasons,
      );
      if (requestedBy) {
        const currentRedacted = yield* deps.serverSettings.getSettings.pipe(
          Effect.map(redactAndEncodeSettings),
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                message: `Failed reading current settings for diff preview: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        const req = yield* controlPlane.createHostApproval({
          kind: "host-settings-patch",
          targetId: "host.settings",
          reasons,
          summary: `Update high-risk ByteDock host settings: ${(highRiskKeys.length > 0 ? highRiskKeys : reasons).join(", ")}`,
          diffPreview: {
            before: extractPatchPreviewBefore(
              currentRedacted as unknown as Readonly<Record<string, unknown>>,
              input.patch,
            ),
            after: input.patch,
          },
          requestedBy,
          mutation: {
            kind: "host-settings-patch",
            patch: input.patch,
          },
        });
        return {
          status: "approval_required",
          applied: false,
          approval: req,
          message: `High-risk ByteDock settings change requires human approval in Control Center (requestId: ${req.requestId}).`,
        } satisfies HostControlOutcome;
      }
    }

    const updated = yield* deps.serverSettings.updateSettings(decodedPatch).pipe(
      Effect.mapError(
        (err) =>
          new ControlPlaneError({
            code: "action_failed",
            message: `Failed updating ServerSettings: ${formatCauseMessage(err)}`,
          }),
      ),
    );
    yield* controlPlane.approvals.recordAudit({
      event: "host_settings_applied",
      actor: actorToLabel(input.actor),
      keys: Object.keys(input.patch),
    });
    return {
      status: "applied",
      applied: true,
      data: {
        settings: redactAndEncodeSettings(updated),
      },
    } satisfies HostControlOutcome;
  });

  const upsertKeybinding: HostControlServiceShape["upsertKeybinding"] = Effect.fn(
    "HostControlService.upsertKeybinding",
  )(function* (input) {
    if (!deps.keybindings) {
      return yield* new ControlPlaneError({
        code: "service_unavailable",
        message: "Keybindings service is unavailable on this ByteDock host.",
      });
    }
    const decoded = yield* decodeOrFail(
      decodeUpsertKeybinding,
      input.rule,
      "ServerUpsertKeybindingInput",
    );
    const snapshot = yield* deps.keybindings.upsertKeybindingRule(decoded).pipe(
      Effect.mapError(
        (err) =>
          new ControlPlaneError({
            code: "action_failed",
            message: `Failed upserting keybinding: ${formatCauseMessage(err)}`,
          }),
      ),
    );
    yield* controlPlane.approvals.recordAudit({
      event: "host_keybinding_upserted",
      actor: actorToLabel(input.actor),
      key: decoded.key,
      command: decoded.command,
    });
    return { status: "applied", applied: true, data: snapshot } satisfies HostControlOutcome;
  });

  const removeKeybinding: HostControlServiceShape["removeKeybinding"] = Effect.fn(
    "HostControlService.removeKeybinding",
  )(function* (input) {
    if (!deps.keybindings) {
      return yield* new ControlPlaneError({
        code: "service_unavailable",
        message: "Keybindings service is unavailable on this ByteDock host.",
      });
    }
    const decoded = yield* decodeOrFail(
      decodeRemoveKeybinding,
      input.rule,
      "ServerRemoveKeybindingInput",
    );
    const snapshot = yield* deps.keybindings.removeKeybindingRule(decoded).pipe(
      Effect.mapError(
        (err) =>
          new ControlPlaneError({
            code: "action_failed",
            message: `Failed removing keybinding: ${formatCauseMessage(err)}`,
          }),
      ),
    );
    yield* controlPlane.approvals.recordAudit({
      event: "host_keybinding_removed",
      actor: actorToLabel(input.actor),
      key: decoded.key,
      command: decoded.command,
    });
    return { status: "applied", applied: true, data: snapshot } satisfies HostControlOutcome;
  });

  const updateProviderInstance: HostControlServiceShape["updateProviderInstance"] = Effect.fn(
    "HostControlService.updateProviderInstance",
  )(function* (input) {
    if (!deps.serverSettings) {
      return yield* new ControlPlaneError({
        code: "service_unavailable",
        message: "ServerSettingsService is unavailable on this ByteDock host.",
      });
    }
    const secretHit =
      PluginKernel.findPlaintextSecretViolation(input.mutation, "providerMutation") ??
      (input.patch !== undefined
        ? PluginKernel.findPlaintextSecretViolation(input.patch, "settings")
        : undefined);
    if (secretHit) {
      return yield* new ControlPlaneError({
        code: "invalid_config",
        message: secretHit,
      });
    }
    const decodedMutation = yield* decodeOrFail(
      decodeProviderInstanceMutation,
      input.mutation,
      "ProviderInstanceMutation",
    );
    const decodedPatch =
      input.patch !== undefined
        ? yield* decodeOrFail(decodeServerSettingsPatch, input.patch, "ServerSettingsPatch")
        : undefined;

    const reasons = [
      `provider-instance-${decodedMutation.operation}:${decodedMutation.instanceId}`,
    ];
    if (input.actor.kind !== "host-client") {
      const requestedBy = yield* assertMainSessionForHighRisk(
        input.actor,
        `host.provider:${decodedMutation.instanceId}`,
        "update_provider",
        reasons,
      );
      if (requestedBy) {
        const currentRedacted = yield* deps.serverSettings.getSettings.pipe(
          Effect.map(redactAndEncodeSettings),
          Effect.mapError(
            (err) =>
              new ControlPlaneError({
                code: "action_failed",
                message: `Failed reading provider settings: ${formatCauseMessage(err)}`,
              }),
          ),
        );
        const req = yield* controlPlane.createHostApproval({
          kind: "provider-mutation",
          targetId: `host.provider:${decodedMutation.instanceId}`,
          reasons,
          summary: `${decodedMutation.operation} provider instance "${decodedMutation.instanceId}"`,
          diffPreview: {
            before: currentRedacted.providerInstances?.[decodedMutation.instanceId] ?? null,
            after: decodedMutation,
          },
          requestedBy,
          mutation: {
            kind: "provider-mutation",
            mutation: input.mutation,
            ...(input.patch !== undefined ? { patch: input.patch } : {}),
          },
        });
        return {
          status: "approval_required",
          applied: false,
          approval: req,
          message: `Provider instance change requires human approval in Control Center (requestId: ${req.requestId}).`,
        } satisfies HostControlOutcome;
      }
    }

    const updated = yield* deps.serverSettings
      .updateProviderInstance(decodedMutation, decodedPatch)
      .pipe(
        Effect.mapError(
          (err) =>
            new ControlPlaneError({
              code: "action_failed",
              message: `Failed updating provider instance: ${formatCauseMessage(err)}`,
            }),
        ),
      );
    return {
      status: "applied",
      applied: true,
      data: {
        providerInstances: redactAndEncodeSettings(updated).providerInstances,
      },
    } satisfies HostControlOutcome;
  });

  const runPluginAction: HostControlServiceShape["runPluginAction"] = Effect.fn(
    "HostControlService.runPluginAction",
  )(function* (input) {
    if (input.action === "egress_audit") {
      const events = controlPlane.kernel.egress.getEvents();
      const maxItems = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
      return {
        status: "ok",
        applied: false,
        data: {
          policy: controlPlane.kernel.egress.getPolicy(),
          blockedCount: events.filter((e) => e.verdict === "egress-denied").length,
          allowedCount: events.filter(
            (e) => e.verdict === "whitelist" || e.verdict === "loopback-allowed",
          ).length,
          totalEvents: events.length,
          recentEvents: events.slice(-maxItems),
          disclosures: PluginKernel.EGRESS_HONEST_DISCLOSURES,
        },
      } satisfies HostControlOutcome;
    }

    if (input.action === "egress_proof") {
      const proof = yield* Effect.sync(() =>
        controlPlane.kernel.egress.generateEgressProof({ runDetachedProbes: true }),
      );
      return { status: "ok", applied: true, data: proof } satisfies HostControlOutcome;
    }

    if (input.action === "legacy_scan") {
      const result = yield* Effect.sync(() => {
        const discovered = discoverLegacySourcesReadOnly();
        const custom =
          input.customSourceDir && input.customSourceDir.trim().length > 0
            ? [
                scanLegacySourceReadOnly({
                  baseDir: input.customSourceDir.trim(),
                  brand: "custom",
                }),
              ]
            : [];
        return {
          targetStateDir: controlPlane.stateDir,
          sources: [...discovered, ...custom],
        };
      });
      return { status: "ok", applied: false, data: result } satisfies HostControlOutcome;
    }

    if (input.action === "legacy_import") {
      const sourceBaseDir = input.sourceBaseDir?.trim();
      const categories = validateLegacyCategories(input.categories);
      if (!sourceBaseDir || !categories) {
        return yield* new ControlPlaneError({
          code: "invalid_config",
          pluginId: "builtin.legacy-importer",
          message:
            'legacy_import requires non-empty sourceBaseDir and valid categories (subset of "settings" | "keybindings" | "themes" | "stateDb" | "attachments" | "usageDb" | "secrets").',
        });
      }
      const overwrite = input.overwrite ?? true;
      const importerCfg = yield* controlPlane.getPluginConfig("builtin.legacy-importer");
      const deferLockedStateDb =
        input.deferLockedStateDb ?? Boolean(importerCfg.deferLockedStateDb ?? true);
      const reasons = [`legacy-import-categories:${categories.join(",")}`];

      if (input.actor.kind !== "host-client") {
        const requestedBy = yield* assertMainSessionForHighRisk(
          input.actor,
          "builtin.legacy-importer",
          "legacy_import",
          reasons,
        );
        if (requestedBy) {
          const req = yield* controlPlane.createHostApproval({
            kind: "legacy-import",
            targetId: "builtin.legacy-importer",
            reasons,
            summary: `Import T3 data (${categories.join(", ")}) read-only from ${sourceBaseDir}`,
            diffPreview: {
              before: { targetStateDir: controlPlane.stateDir },
              after: {
                sourceBaseDir,
                sourceBrand: input.sourceBrand ?? "custom",
                categories,
                overwrite,
                deferLockedStateDb,
              },
            },
            requestedBy,
            mutation: {
              kind: "legacy-import",
              sourceBaseDir,
              ...(input.sourceBrand !== undefined ? { sourceBrand: input.sourceBrand } : {}),
              categories,
              overwrite,
              deferLockedStateDb,
            },
          });
          return {
            status: "approval_required",
            applied: false,
            approval: req,
            message: `Legacy T3 read-only import requires human approval in Control Center (requestId: ${req.requestId}).`,
          } satisfies HostControlOutcome;
        }
      }

      const report = yield* Effect.try({
        try: () =>
          runLegacyReadOnlyImport({
            sourceBaseDir,
            sourceBrand: input.sourceBrand,
            targetStateDir: controlPlane.stateDir,
            categories,
            overwrite,
            deferLockedStateDb,
          }),
        catch: (cause) =>
          new ControlPlaneError({
            code: "action_failed",
            pluginId: "builtin.legacy-importer",
            message: `Legacy import failed: ${formatCauseMessage(cause)}`,
          }),
      });
      return { status: "applied", applied: true, data: report } satisfies HostControlOutcome;
    }

    if (input.action === "scaffold_local_plugin") {
      const pluginId = input.pluginId?.trim() ?? "";
      if (
        !LOCAL_PLUGIN_ID_RE.test(pluginId) ||
        pluginId.includes("..") ||
        pluginId.includes("/") ||
        pluginId.includes("\\")
      ) {
        return yield* new ControlPlaneError({
          code: "invalid_config",
          message: `Invalid local pluginId "${pluginId}". Must match ^[a-z0-9][a-z0-9._-]{1,63}$ without ".." or path separators.`,
        });
      }
      if (BUILTIN_ID_SET.has(pluginId)) {
        return yield* new ControlPlaneError({
          code: "invalid_config",
          pluginId,
          message: `Local plugin id "${pluginId}" collides with a builtin ByteDock plugin.`,
        });
      }
      const displayName = input.displayName?.trim() || pluginId;
      const description =
        input.description?.trim() || `Local ByteDock plugin scaffold for ${pluginId}.`;
      const created = yield* Effect.try({
        try: () =>
          writeScaffoldFiles({
            pluginsDir: controlPlane.pluginsDir,
            pluginId,
            displayName,
            description,
          }),
        catch: (cause) =>
          new ControlPlaneError({
            code: "invalid_config",
            pluginId,
            message: formatCauseMessage(cause),
          }),
      });
      const reload = yield* controlPlane.reloadFromDisk({ reason: `scaffold:${pluginId}` });
      yield* controlPlane.approvals.recordAudit({
        event: "local_plugin_scaffolded",
        pluginId,
        actor: actorToLabel(input.actor),
        pluginDir: created.pluginDir,
      });
      return {
        status: "applied",
        applied: true,
        data: {
          pluginId,
          ...created,
          approved: false,
          status: "disabled",
          activeRevision: reload.activeRevision,
        },
        message: `Created local plugin scaffold "${pluginId}" in disabled/unapproved state. Use bytedock_plugin_set_enabled to request human approval when ready.`,
      } satisfies HostControlOutcome;
    }

    // input.action === "invoke"
    const pluginId = input.pluginId?.trim() ?? "";
    const method = input.method?.trim() ?? "";
    if (!pluginId || !method) {
      return yield* new ControlPlaneError({
        code: "invalid_config",
        message: 'Plugin invoke requires non-empty "pluginId" and "method".',
      });
    }
    if (pluginId === CONTROL_PLANE_PLUGIN_ID) {
      return yield* new ControlPlaneError({
        code: "host_client_required",
        pluginId,
        message:
          'Direct MCP invocation of "builtin.control-plane" is forbidden; use dedicated bytedock_* tools and human approval.',
      });
    }
    if (pluginId === "builtin.legacy-importer" && method === "import") {
      return yield* new ControlPlaneError({
        code: "main_session_required",
        pluginId,
        message:
          'Use action="legacy_import" so legacy T3 import passes through ByteDock human approval.',
      });
    }
    const enabled = yield* controlPlane.isPluginEnabled(pluginId);
    if (!enabled) {
      return yield* new ControlPlaneError({
        code: "plugin_disabled",
        pluginId,
        message: `Plugin "${pluginId}" is currently disabled or unknown.`,
      });
    }
    const result = yield* BuiltinPluginRuntime.invokeBuiltinPluginMethod({
      kernel: controlPlane.kernel,
      controlPlane,
      targetStateDir: controlPlane.stateDir,
      pluginId,
      method,
      payload: input.payload ?? {},
      hostActorId: actorToLabel(input.actor),
    }).pipe(
      Effect.mapError(
        (err) =>
          new ControlPlaneError({
            code: "action_failed",
            pluginId,
            message: err.message,
          }),
      ),
    );
    return { status: "ok", applied: true, data: result } satisfies HostControlOutcome;
  });

  const runUiControl: HostControlServiceShape["runUiControl"] = Effect.fn(
    "HostControlService.runUiControl",
  )(function* (input) {
    if (input.action === "open_control_center") {
      const tab = input.tab ?? "plugins";
      const command = yield* controlPlane.emitUiCommand({
        action: "open_control_center",
        tab,
        actor: actorToLabel(input.actor),
      });
      return { status: "applied", applied: true, data: command } satisfies HostControlOutcome;
    }

    if (input.action === "close_control_center") {
      const command = yield* controlPlane.emitUiCommand({
        action: "close_control_center",
        actor: actorToLabel(input.actor),
      });
      return { status: "applied", applied: true, data: command } satisfies HostControlOutcome;
    }

    if (input.action === "open_dock_panel") {
      const pluginId = input.pluginId?.trim() ?? "";
      if (!pluginId) {
        return yield* new ControlPlaneError({
          code: "invalid_config",
          message: 'open_dock_panel requires a non-empty "pluginId".',
        });
      }
      const nodeErr = validateDockPanelNode(input.node);
      if (nodeErr) {
        return yield* new ControlPlaneError({
          code: "invalid_config",
          pluginId,
          message: nodeErr,
        });
      }
      const command = yield* controlPlane.emitUiCommand({
        action: "open_dock_panel",
        pluginId,
        node: input.node,
        actor: actorToLabel(input.actor),
      });
      return { status: "applied", applied: true, data: command } satisfies HostControlOutcome;
    }

    if (input.action === "close_dock_panel") {
      const command = yield* controlPlane.emitUiCommand({
        action: "close_dock_panel",
        actor: actorToLabel(input.actor),
      });
      return { status: "applied", applied: true, data: command } satisfies HostControlOutcome;
    }

    if (input.action === "navigate") {
      const targetPath = input.path ?? "";
      if (!isSafeInternalRoutePath(targetPath)) {
        return yield* new ControlPlaneError({
          code: "invalid_config",
          message: `Unsafe navigation path "${targetPath}". Only relative internal paths starting with "/" (no "//", protocol, or script schemes) are allowed.`,
        });
      }
      const command = yield* controlPlane.emitUiCommand({
        action: "navigate",
        path: targetPath.trim(),
        actor: actorToLabel(input.actor),
      });
      return { status: "applied", applied: true, data: command } satisfies HostControlOutcome;
    }

    // notify
    const message = input.message?.trim() ?? "";
    if (!message || message.length > 500) {
      return yield* new ControlPlaneError({
        code: "invalid_config",
        message: "UI notify message must be 1 to 500 characters.",
      });
    }
    const command = yield* controlPlane.emitUiCommand({
      action: "notify",
      message,
      level: input.level ?? "info",
      actor: actorToLabel(input.actor),
    });
    return { status: "applied", applied: true, data: command } satisfies HostControlOutcome;
  });

  const runSystemControl: HostControlServiceShape["runSystemControl"] = Effect.fn(
    "HostControlService.runSystemControl",
  )(function* (input) {
    if (input.action === "status") {
      const hostResources = deps.hostResources
        ? yield* deps.hostResources.read.pipe(
            Effect.map((snapshot) => ({ available: true as const, snapshot })),
          )
        : { available: false as const };

      const storageCleanup = deps.storageCleanup
        ? yield* deps.storageCleanup.latestReport.pipe(
            Effect.map((latestReport) => ({ available: true as const, latestReport })),
          )
        : { available: false as const };

      const databaseStorage = deps.databaseStorage
        ? yield* Stream.runHead(deps.databaseStorage.status).pipe(
            Effect.map((head) => ({
              available: true as const,
              status: Option.getOrElse(head, () => null),
            })),
          )
        : { available: false as const };

      const externalTunnel = deps.externalTunnel
        ? yield* deps.externalTunnel.getStatus.pipe(
            Effect.map((status) => ({ available: true as const, status })),
            Effect.catch((err) =>
              Effect.succeed({ available: true as const, error: formatCauseMessage(err) }),
            ),
          )
        : { available: false as const };

      const externalLauncher = deps.externalLauncher
        ? yield* deps.externalLauncher.resolveAvailableEditors().pipe(
            Effect.map((availableEditors) => ({
              available: true as const,
              availableEditors,
            })),
          )
        : { available: false as const };

      return {
        status: "ok",
        applied: false,
        data: {
          hostResources,
          storageCleanup,
          databaseStorage,
          externalTunnel,
          externalLauncher,
          terminalManager: { available: deps.terminalManager !== undefined },
        },
      } satisfies HostControlOutcome;
    }

    if (input.action === "open_editor") {
      if (!deps.externalLauncher) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "ExternalLauncher service is unavailable on this ByteDock host.",
        });
      }
      const decoded = yield* decodeOrFail(
        decodeLaunchEditor,
        input.payload ?? {},
        "LaunchEditorInput",
      );
      yield* deps.externalLauncher.launchEditor(decoded).pipe(
        Effect.mapError(
          (err) =>
            new ControlPlaneError({
              code: "action_failed",
              message: `Failed launching editor: ${formatCauseMessage(err)}`,
            }),
        ),
      );
      yield* controlPlane.approvals.recordAudit({
        event: "host_editor_launched",
        actor: actorToLabel(input.actor),
        editor: decoded.editor,
        cwd: decoded.cwd,
      });
      return {
        status: "applied",
        applied: true,
        data: { launched: true, editor: decoded.editor, cwd: decoded.cwd },
      } satisfies HostControlOutcome;
    }

    // High-risk system actions -> validate availability & payload, enforce main session + human approval.
    const payload = input.payload ?? {};
    const action: HostSystemActionKind = input.action;
    const reasons: Array<string> = [`system-action:${action}`];
    let summary = `Execute ByteDock system action: ${action}`;

    if (action === "storage_cleanup") {
      if (!deps.storageCleanup) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "StorageCleanup service is unavailable on this ByteDock host.",
        });
      }
      summary =
        "Run ByteDock StorageCleanup immediately (deletes expired worktrees/logs/artifacts)";
    } else if (action === "database_reclaim") {
      if (!deps.databaseStorage) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "DatabaseStorage service is unavailable on this ByteDock host.",
        });
      }
      reasons.push("restarts-bytedock-server");
      summary =
        "Reclaim SQLite database free space (approving will restart the ByteDock server for offline VACUUM)";
    } else if (action === "tunnel_action") {
      if (!deps.externalTunnel) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "ExternalTunnelService is unavailable on this ByteDock host.",
        });
      }
      const decoded = yield* decodeOrFail(
        decodeExternalTunnelAction,
        payload,
        "ExternalTunnelActionInput",
      );
      reasons.push(`tunnel-op:${decoded.action}`);
      summary = `Execute external tunnel action "${decoded.action}"`;
    } else if (action === "terminal_open") {
      if (!deps.terminalManager) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "TerminalManager service is unavailable on this ByteDock host.",
        });
      }
      const decoded = yield* decodeOrFail(decodeTerminalOpen, payload, "TerminalOpenInput");
      summary = `Open host terminal "${decoded.terminalId}" in ${decoded.cwd}`;
    } else if (action === "terminal_write") {
      if (!deps.terminalManager) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "TerminalManager service is unavailable on this ByteDock host.",
        });
      }
      const decoded = yield* decodeOrFail(decodeTerminalWrite, payload, "TerminalWriteInput");
      summary = `Write command input to host terminal "${decoded.terminalId}"`;
    } else if (action === "terminal_close") {
      if (!deps.terminalManager) {
        return yield* new ControlPlaneError({
          code: "service_unavailable",
          message: "TerminalManager service is unavailable on this ByteDock host.",
        });
      }
      const decoded = yield* decodeOrFail(decodeTerminalClose, payload, "TerminalCloseInput");
      summary = `Close host terminal${decoded.terminalId ? ` "${decoded.terminalId}"` : "s"} for thread ${decoded.threadId}`;
    }

    const targetId = `host.system:${action}`;
    if (input.actor.kind !== "host-client") {
      const requestedBy = yield* assertMainSessionForHighRisk(
        input.actor,
        targetId,
        action,
        reasons,
      );
      if (requestedBy) {
        const req = yield* controlPlane.createHostApproval({
          kind: "system-action",
          targetId,
          reasons,
          summary,
          diffPreview: {
            before: { action, status: "pending" },
            after: { action, payload },
          },
          requestedBy,
          mutation: {
            kind: "system-action",
            action,
            payload,
          },
        });
        return {
          status: "approval_required",
          applied: false,
          approval: req,
          message: `System action "${action}" requires human approval in ByteDock Control Center (requestId: ${req.requestId}).`,
        } satisfies HostControlOutcome;
      }
    }

    // Direct host-client invocation path.
    const hostResult = yield* executeHostMutation({
      request: {
        requestId: "host-direct",
        kind: "system-action",
        pluginId: targetId,
        riskLevel: "high",
        reasons,
        summary,
        diffPreview: { before: null, after: payload },
        requestedBy: { kind: "main-thread", threadId: "host-client" },
        expectedMtimeMs: 0,
        mutation: { kind: "system-action", action, payload },
        status: "approved",
        createdAt: "",
        createdAtMs: 0,
        expiresAt: "",
        expiresAtMs: 0,
      },
      mutation: { kind: "system-action", action, payload },
      actorId: actorToLabel(input.actor),
    });
    return { status: "applied", applied: true, data: hostResult } satisfies HostControlOutcome;
  });

  return {
    getCapabilitiesCatalog,
    readSettingsBundle,
    patchServerSettings,
    upsertKeybinding,
    removeKeybinding,
    updateProviderInstance,
    runPluginAction,
    runUiControl,
    runSystemControl,
  };
};

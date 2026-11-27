import { isTaskChildLineage, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HostControlService from "../../../plugins/HostControlService.ts";
import * as PluginControlPlane from "../../../plugins/PluginControlPlane.ts";
import type { ControlPlaneApprovalRequest } from "../../../plugins/PluginApprovalStore.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller, type Caller } from "../../threadAccess.ts";
import { ByteDockControlToolkit } from "./tools.ts";

function toConfigDiagnostic(d: PluginControlPlane.ConfigDiagnostic) {
  return {
    filePath: d.filePath,
    message: d.message,
    observedAt: d.observedAt,
    ...(d.pluginId !== undefined ? { pluginId: d.pluginId } : {}),
  };
}

function toApprovalSummary(req: ControlPlaneApprovalRequest) {
  return {
    requestId: req.requestId,
    kind: req.kind,
    pluginId: req.pluginId,
    riskLevel: req.riskLevel,
    reasons: [...req.reasons],
    summary: req.summary,
    diffPreview: req.diffPreview,
    status: req.status,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
    ...(req.resolvedAt !== undefined ? { resolvedAt: req.resolvedAt } : {}),
    ...(req.resolutionNote !== undefined ? { resolutionNote: req.resolutionNote } : {}),
  };
}

function classifyMcpActor(caller: Caller): PluginControlPlane.ControlPlaneActor {
  const { scope } = caller;
  if (scope.client?.linked === true) {
    return {
      kind: "mcp-non-main",
      reason: "linked-environment-caller",
      actorId: `linked:${scope.client.sessionId}`,
    };
  }
  if (scope.thread === undefined || caller.caller === undefined) {
    return {
      kind: "mcp-non-main",
      reason: "external-non-thread-client",
      actorId: `client:${scope.client?.sessionId ?? "unknown"}`,
    };
  }
  if (scope.thread.subagent === true || isTaskChildLineage(caller.caller.lineage)) {
    return {
      kind: "mcp-non-main",
      reason: "delegated-subagent-thread",
      actorId: `subagent:${scope.thread.threadId}`,
    };
  }
  return {
    kind: "mcp-main-thread",
    threadId: scope.thread.threadId,
    providerInstanceId: scope.thread.providerInstanceId,
  };
}

function mapControlPlaneError(error: PluginControlPlane.ControlPlaneError): OrchestratorMcpFailure {
  if (error.code === "main_session_required" || error.code === "host_client_required") {
    return new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `[${error.code}] ${error.message}`,
    });
  }
  if (
    error.code === "invalid_config" ||
    error.code === "plugin_not_found" ||
    error.code === "stale_config" ||
    error.code === "plugin_disabled"
  ) {
    return new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `[${error.code}] ${error.message}`,
    });
  }
  return new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `[${error.code}] ${error.message}`,
  });
}

function formatMutationOutcome(outcome: PluginControlPlane.ControlPlaneMutationOutcome) {
  if (outcome.status === "approval_required") {
    return {
      status: "approval_required" as const,
      pluginId: outcome.request.pluginId,
      applied: false,
      approval: toApprovalSummary(outcome.request),
      message: `Human review required in ByteDock Control Center before applying this privileged change (requestId: ${outcome.request.requestId}, expiresAt: ${outcome.request.expiresAt}).`,
    };
  }
  return {
    status: "applied" as const,
    pluginId: outcome.pluginId,
    applied: true,
    enabled: outcome.enabled,
    pluginStatus: outcome.pluginStatus,
    config: { ...outcome.config },
    activeRevision: outcome.activeRevision,
    mtimeMs: outcome.mtimeMs,
  };
}

function formatHostOutcome(outcome: HostControlService.HostControlOutcome) {
  return {
    status: outcome.status,
    applied: outcome.applied,
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    ...(outcome.approval !== undefined ? { approval: toApprovalSummary(outcome.approval) } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
  };
}

const runAuthorizedMutation = Effect.fn("bytedockControl.runAuthorizedMutation")(function* <
  A,
  E,
  R,
>(work: (actor: PluginControlPlane.ControlPlaneActor) => Effect.Effect<A, E, R>) {
  const caller = yield* readCaller();
  yield* assertLiveCaller(caller);
  if (caller.scope.client?.linked === true || caller.caller?.linkOrigin !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Linked remote environments cannot modify local ByteDock host or plugin configuration.",
    });
  }
  return yield* work(classifyMcpActor(caller));
});

const READ_ONLY_ACTOR: PluginControlPlane.ControlPlaneActor = {
  kind: "mcp-non-main",
  reason: "read-only-query",
  actorId: "mcp:read-only",
};

export const layer = McpToolAccess.toLayer(ByteDockControlToolkit, {
  bytedock_config_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const controlPlane = yield* PluginControlPlane.PluginControlPlane;
      const state = yield* controlPlane.getState();
      return {
        pluginConfigPath: state.pluginConfigPath,
        pluginsDir: state.pluginsDir,
        mtimeMs: state.mtimeMs,
        activeRevision: state.activeRevision,
        plugins: state.plugins.map((p) => ({
          id: p.id,
          name: p.name,
          version: p.version,
          revision: p.revision,
          execution: p.execution,
          trust: p.trust,
          status: p.status,
          enabled: p.enabled,
          approved: p.approved,
          config: { ...p.config },
          ...(p.sourcePath !== undefined ? { sourcePath: p.sourcePath } : {}),
        })),
        egressPolicy: {
          mode: state.egressPolicy.mode,
          allowedHosts: [...state.egressPolicy.allowedHosts],
          allowLoopbackHosts: [...state.egressPolicy.allowLoopbackHosts],
          deniedDomains: [...state.egressPolicy.deniedDomains],
          allowUdp: state.egressPolicy.allowUdp,
        },
        ...(state.lastConfigDiagnostic !== undefined
          ? { lastConfigDiagnostic: toConfigDiagnostic(state.lastConfigDiagnostic) }
          : {}),
        ...(state.lastReloadDiagnostic !== undefined
          ? { lastReloadDiagnostic: state.lastReloadDiagnostic }
          : {}),
        approvals: state.approvals.map(toApprovalSummary),
      };
    }),
  ),
  bytedock_plugin_set_enabled: McpToolAccess.writes(({ pluginId, enabled, expectedMtimeMs }) =>
    runAuthorizedMutation((actor) =>
      Effect.gen(function* () {
        const controlPlane = yield* PluginControlPlane.PluginControlPlane;
        const outcome = yield* controlPlane
          .setPluginEnabled({ pluginId, enabled, expectedMtimeMs, actor })
          .pipe(Effect.mapError(mapControlPlaneError));
        return formatMutationOutcome(outcome);
      }),
    ),
  ),
  bytedock_plugin_config_patch: McpToolAccess.writes(({ pluginId, patch, expectedMtimeMs }) =>
    runAuthorizedMutation((actor) =>
      Effect.gen(function* () {
        const controlPlane = yield* PluginControlPlane.PluginControlPlane;
        const outcome = yield* controlPlane
          .patchPluginConfig({ pluginId, patch, expectedMtimeMs, actor })
          .pipe(Effect.mapError(mapControlPlaneError));
        return formatMutationOutcome(outcome);
      }),
    ),
  ),
  bytedock_plugins_reload: McpToolAccess.writes(() =>
    runAuthorizedMutation(() =>
      Effect.gen(function* () {
        const controlPlane = yield* PluginControlPlane.PluginControlPlane;
        const outcome = yield* controlPlane.reloadFromDisk({ reason: "mcp-reload" });
        return {
          status: outcome.status,
          previousRevision: outcome.previousRevision,
          activeRevision: outcome.activeRevision,
          mtimeMs: outcome.mtimeMs,
          pluginCount: outcome.plugins.length,
          ...(outcome.configDiagnostic !== undefined
            ? { configDiagnostic: toConfigDiagnostic(outcome.configDiagnostic) }
            : {}),
          ...(outcome.reloadDiagnostic !== undefined
            ? { reloadDiagnostic: outcome.reloadDiagnostic }
            : {}),
        };
      }),
    ),
  ),
  bytedock_capabilities_catalog: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const hostControl = yield* HostControlService.HostControlService;
      const catalog = yield* hostControl.getCapabilitiesCatalog();
      return {
        ...catalog,
        tools: catalog.tools.map((tool) => ({
          ...tool,
          actions: [...tool.actions],
        })),
      };
    }),
  ),
  bytedock_settings_control: McpToolAccess.either(
    (params) => params.action === "read",
    McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const hostControl = yield* HostControlService.HostControlService;
        const bundle = yield* hostControl
          .readSettingsBundle()
          .pipe(Effect.mapError(mapControlPlaneError));
        return {
          status: "ok" as const,
          applied: false,
          data: bundle,
        };
      }),
    ),
    McpToolAccess.writes((params) =>
      runAuthorizedMutation((actor) =>
        Effect.gen(function* () {
          const hostControl = yield* HostControlService.HostControlService;
          if (params.action === "patch_settings") {
            if (!params.patch) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  'bytedock_settings_control action "patch_settings" requires "patch" object.',
              });
            }
            const outcome = yield* hostControl
              .patchServerSettings({ patch: params.patch, actor })
              .pipe(Effect.mapError(mapControlPlaneError));
            return formatHostOutcome(outcome);
          }
          if (params.action === "upsert_keybinding") {
            if (!params.rule) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  'bytedock_settings_control action "upsert_keybinding" requires "rule" object.',
              });
            }
            const outcome = yield* hostControl
              .upsertKeybinding({ rule: params.rule, actor })
              .pipe(Effect.mapError(mapControlPlaneError));
            return formatHostOutcome(outcome);
          }
          if (params.action === "remove_keybinding") {
            if (!params.rule) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  'bytedock_settings_control action "remove_keybinding" requires "rule" object.',
              });
            }
            const outcome = yield* hostControl
              .removeKeybinding({ rule: params.rule, actor })
              .pipe(Effect.mapError(mapControlPlaneError));
            return formatHostOutcome(outcome);
          }
          if (params.action === "update_provider") {
            if (!params.mutation) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  'bytedock_settings_control action "update_provider" requires "mutation" object.',
              });
            }
            const outcome = yield* hostControl
              .updateProviderInstance({
                mutation: params.mutation,
                ...(params.patch !== undefined ? { patch: params.patch } : {}),
                actor,
              })
              .pipe(Effect.mapError(mapControlPlaneError));
            return formatHostOutcome(outcome);
          }
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Unsupported settings control action "${params.action}".`,
          });
        }),
      ),
    ),
  ),
  bytedock_plugin_action: McpToolAccess.either(
    (params) => params.action === "egress_audit" || params.action === "legacy_scan",
    McpToolAccess.reads((params) =>
      Effect.gen(function* () {
        const hostControl = yield* HostControlService.HostControlService;
        const outcome = yield* hostControl
          .runPluginAction({
            action: params.action,
            actor: READ_ONLY_ACTOR,
            customSourceDir: params.customSourceDir,
            limit: params.limit,
          })
          .pipe(Effect.mapError(mapControlPlaneError));
        return formatHostOutcome(outcome);
      }),
    ),
    McpToolAccess.writes((params) =>
      runAuthorizedMutation((actor) =>
        Effect.gen(function* () {
          const hostControl = yield* HostControlService.HostControlService;
          const outcome = yield* hostControl
            .runPluginAction({
              action: params.action,
              actor,
              pluginId: params.pluginId,
              method: params.method,
              payload: params.payload,
              customSourceDir: params.customSourceDir,
              sourceBaseDir: params.sourceBaseDir,
              sourceBrand: params.sourceBrand,
              categories: params.categories,
              overwrite: params.overwrite,
              deferLockedStateDb: params.deferLockedStateDb,
              displayName: params.displayName,
              description: params.description,
              limit: params.limit,
            })
            .pipe(Effect.mapError(mapControlPlaneError));
          return formatHostOutcome(outcome);
        }),
      ),
    ),
  ),
  bytedock_ui_control: McpToolAccess.writes((params) =>
    runAuthorizedMutation((actor) =>
      Effect.gen(function* () {
        const hostControl = yield* HostControlService.HostControlService;
        const outcome = yield* hostControl
          .runUiControl({
            action: params.action,
            actor,
            tab: params.tab,
            pluginId: params.pluginId,
            node: params.node,
            path: params.path,
            message: params.message,
            level: params.level,
          })
          .pipe(Effect.mapError(mapControlPlaneError));
        return formatHostOutcome(outcome);
      }),
    ),
  ),
  bytedock_system_control: McpToolAccess.either(
    (params) => params.action === "status",
    McpToolAccess.reads(() =>
      Effect.gen(function* () {
        const hostControl = yield* HostControlService.HostControlService;
        const outcome = yield* hostControl
          .runSystemControl({ action: "status", actor: READ_ONLY_ACTOR })
          .pipe(Effect.mapError(mapControlPlaneError));
        return formatHostOutcome(outcome);
      }),
    ),
    McpToolAccess.writes((params) =>
      runAuthorizedMutation((actor) =>
        Effect.gen(function* () {
          const hostControl = yield* HostControlService.HostControlService;
          const outcome = yield* hostControl
            .runSystemControl({
              action: params.action,
              actor,
              payload: params.payload,
            })
            .pipe(Effect.mapError(mapControlPlaneError));
          return formatHostOutcome(outcome);
        }),
      ),
    ),
  ),
});

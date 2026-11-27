import * as Effect from "effect/Effect";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PluginRpcError,
} from "@t3tools/contracts";
import * as PluginKernel from "@bytedock/plugin-kernel";

import { BUILTIN_METHODS, BUILTIN_PLUGIN_MANIFESTS } from "./BuiltinPluginManifests.ts";
import {
  discoverLegacySourcesReadOnly,
  runLegacyReadOnlyImport,
  scanLegacySourceReadOnly,
  type LegacyImportCategory,
  type LegacySourceBrand,
} from "./LegacyT3Importer.ts";
import {
  CONTROL_PLANE_PLUGIN_ID,
  type ControlPlaneActor,
  type PluginControlPlaneService,
} from "./PluginControlPlane.ts";

/** Registers built-in first-party ByteDock plugins and RPC methods into PluginKernel once. */
export const ensureBuiltinPluginsRegistered = Effect.fn(
  "BuiltinPluginRuntime.ensureBuiltinPluginsRegistered",
)(function* (kernel: PluginKernel.PluginKernelService) {
  const existing = yield* kernel.listDescriptors();
  if (existing.length > 0) return;

  const installed = yield* kernel.revisions.installRevision({
    manifests: BUILTIN_PLUGIN_MANIFESTS,
  });
  for (const spec of BUILTIN_METHODS) {
    yield* kernel.broker.registerMethod({
      pluginId: spec.pluginId,
      method: spec.method,
      revision: installed.rev,
      methodMinScopes: spec.minScopes,
      manifestScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    });
  }
});

/** Dispatches authorized builtin plugin & control-plane RPC calls with live enabled/config checks. */
export const invokeBuiltinPluginMethod = Effect.fn(
  "BuiltinPluginRuntime.invokeBuiltinPluginMethod",
)(function* (input: {
  readonly kernel: PluginKernel.PluginKernelService;
  readonly controlPlane?: PluginControlPlaneService | undefined;
  readonly targetStateDir: string;
  readonly pluginId: string;
  readonly method: string;
  readonly payload: unknown;
  readonly hostActorId?: string | undefined;
}): Effect.fn.Return<unknown, PluginRpcError> {
  if (input.pluginId === CONTROL_PLANE_PLUGIN_ID) {
    if (!input.controlPlane) {
      return yield* new PluginRpcError({
        code: "invoke_failed",
        pluginId: input.pluginId,
        message: "ByteDock PluginControlPlane is unavailable.",
      });
    }
    const actor: ControlPlaneActor = {
      kind: "host-client",
      actorId: input.hostActorId ?? "host-session",
    };
    const body = (input.payload ?? {}) as Record<string, unknown>;

    if (input.method === "getState") {
      return yield* input.controlPlane.getState();
    }
    if (input.method === "listApprovals") {
      return yield* input.controlPlane.approvals.listApprovals();
    }
    if (input.method === "setEnabled") {
      if (typeof body.pluginId !== "string" || typeof body.enabled !== "boolean") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "setEnabled requires string pluginId and boolean enabled.",
        });
      }
      return yield* input.controlPlane
        .setPluginEnabled({
          pluginId: body.pluginId,
          enabled: body.enabled,
          expectedMtimeMs:
            typeof body.expectedMtimeMs === "number" ? body.expectedMtimeMs : undefined,
          actor,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: err.code === "plugin_not_found" ? "plugin_not_found" : "invoke_failed",
                pluginId: err.pluginId ?? input.pluginId,
                message: err.message,
              }),
          ),
        );
    }
    if (input.method === "patchConfig") {
      if (
        typeof body.pluginId !== "string" ||
        !body.patch ||
        typeof body.patch !== "object" ||
        Array.isArray(body.patch)
      ) {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "patchConfig requires string pluginId and object patch.",
        });
      }
      return yield* input.controlPlane
        .patchPluginConfig({
          pluginId: body.pluginId,
          patch: body.patch as Readonly<Record<string, unknown>>,
          expectedMtimeMs:
            typeof body.expectedMtimeMs === "number" ? body.expectedMtimeMs : undefined,
          actor,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: err.code === "plugin_not_found" ? "plugin_not_found" : "invoke_failed",
                pluginId: err.pluginId ?? input.pluginId,
                message: err.message,
              }),
          ),
        );
    }
    if (input.method === "resolveApproval") {
      if (
        typeof body.requestId !== "string" ||
        (body.decision !== "approve" && body.decision !== "reject")
      ) {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: 'resolveApproval requires string requestId and decision "approve" | "reject".',
        });
      }
      return yield* input.controlPlane
        .resolveApproval({
          requestId: body.requestId,
          decision: body.decision,
          actor,
          note: typeof body.note === "string" ? body.note : undefined,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: err.pluginId ?? input.pluginId,
                message: err.message,
              }),
          ),
        );
    }
    return null;
  }

  // Enforce runtime enabled state for business plugins.
  if (input.controlPlane) {
    const enabled = yield* input.controlPlane.isPluginEnabled(input.pluginId);
    if (!enabled) {
      return yield* new PluginRpcError({
        code: "invoke_failed",
        pluginId: input.pluginId,
        message: `Plugin "${input.pluginId}" is currently disabled.`,
      });
    }
  }

  const pluginConfig = input.controlPlane
    ? yield* input.controlPlane.getPluginConfig(input.pluginId)
    : PluginKernel.getDefaultPluginConfig(input.pluginId);

  if (input.pluginId === "builtin.egress-guard") {
    if (input.method === "status") {
      const events = input.kernel.egress.getEvents();
      return {
        policy: input.kernel.egress.getPolicy(),
        blockedCount: events.filter((e) => e.verdict === "egress-denied").length,
        allowedCount: events.filter(
          (e) => e.verdict === "whitelist" || e.verdict === "loopback-allowed",
        ).length,
        disclosures: PluginKernel.EGRESS_HONEST_DISCLOSURES,
      };
    }
    if (input.method === "runProof") {
      return input.kernel.egress.generateEgressProof({ runDetachedProbes: true });
    }
  }

  if (input.pluginId === "builtin.token-optimizer" && input.method === "status") {
    return {
      tracks: ["stateless-api", "stateful-cli", "stateful-acp"],
      cacheGuardActive: Boolean(pluginConfig.cacheGuardActive ?? true),
      steadyStateTargetPct: Number(pluginConfig.steadyStateTargetPct ?? 90),
      xrayHonestyMode: String(pluginConfig.xrayHonestyMode ?? "strict-no-fabrication"),
    };
  }

  if (input.pluginId === "builtin.bots-core" && input.method === "status") {
    return {
      channels: ["community.napcat-qq"],
      soulPrefixGuard: Boolean(pluginConfig.soulPrefixGuard ?? true),
      memoryMode: String(pluginConfig.memoryMode ?? "append-only"),
      decisionGateSurfaces: ["web", "desktop-tray", "mobile-readonly"],
    };
  }

  if (input.pluginId === "community.napcat-qq" && input.method === "status") {
    return {
      endpointMode: String(pluginConfig.endpointMode ?? "loopback-only"),
      allowedHosts: Array.isArray(pluginConfig.allowedHosts)
        ? pluginConfig.allowedHosts
        : ["127.0.0.1", "localhost"],
      webhookRoute: String(
        pluginConfig.webhookRoute ?? "/api/plugins/community.napcat-qq/onebot/event",
      ),
      rateLimitPerMin: Number(pluginConfig.rateLimitPerMin ?? 50),
    };
  }

  if (input.pluginId === "builtin.legacy-importer") {
    const body = (input.payload ?? {}) as {
      readonly customSourceDir?: string | undefined;
      readonly sourceBaseDir?: string | undefined;
      readonly sourceBrand?: LegacySourceBrand | undefined;
      readonly categories?: ReadonlyArray<LegacyImportCategory> | undefined;
      readonly overwrite?: boolean | undefined;
      readonly deferLockedStateDb?: boolean | undefined;
    };
    if (input.method === "scan") {
      const discovered = discoverLegacySourcesReadOnly();
      const custom = body.customSourceDir
        ? [scanLegacySourceReadOnly({ baseDir: body.customSourceDir, brand: "custom" })]
        : [];
      return {
        targetStateDir: input.targetStateDir,
        sources: [...discovered, ...custom],
      };
    }
    if (input.method === "import") {
      if (!body.sourceBaseDir || !Array.isArray(body.categories) || body.categories.length === 0) {
        return { error: "sourceBaseDir and non-empty categories are required." };
      }
      return runLegacyReadOnlyImport({
        sourceBaseDir: body.sourceBaseDir,
        sourceBrand: body.sourceBrand,
        targetStateDir: input.targetStateDir,
        categories: body.categories,
        overwrite: body.overwrite ?? true,
        deferLockedStateDb:
          body.deferLockedStateDb ?? Boolean(pluginConfig.deferLockedStateDb ?? true),
      });
    }
  }

  return null;
});

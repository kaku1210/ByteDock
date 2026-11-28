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
  readonly callerKind?: "host-client" | "mcp" | undefined;
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

  if (input.pluginId === "builtin.token-optimizer") {
    const configSummary = {
      cacheGuardActive: Boolean(pluginConfig.cacheGuardActive ?? true),
      steadyStateTargetPct: Number(pluginConfig.steadyStateTargetPct ?? 90),
      xrayHonestyMode: String(pluginConfig.xrayHonestyMode ?? "strict-no-fabrication"),
      showStatusBarMetrics: Boolean(pluginConfig.showStatusBarMetrics ?? true),
      watchdogEnabled: Boolean(pluginConfig.watchdogEnabled ?? true),
      watchdogWarnAfterSec: Number(pluginConfig.watchdogWarnAfterSec ?? 45),
      watchdogCriticalAfterSec: Number(pluginConfig.watchdogCriticalAfterSec ?? 120),
    };
    if (input.method === "status") {
      return {
        tracks: ["stateless-api", "stateful-cli", "stateful-acp"],
        ...configSummary,
        hostOverview: input.controlPlane?.tokenOptimizer.getOverview() ?? {
          trackedThreads: 0,
          totalObservedTurns: 0,
          totalCompactBoundaries: 0,
          totalModelSwitches: 0,
          prefixViolations: 0,
        },
      };
    }
    if (input.method === "threadSummary") {
      const body = (input.payload ?? {}) as { readonly threadId?: unknown };
      const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
      if (!threadId) {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "threadSummary requires a non-empty string threadId.",
        });
      }
      return {
        threadId,
        config: configSummary,
        summary: input.controlPlane?.tokenOptimizer.getThreadSummary(threadId) ?? {
          threadId,
          tracked: false,
          pinnedRevision: null,
          lastModelId: null,
          openSessionCount: 0,
          observedTurns: 0,
          compactCount: 0,
          modelSwitches: 0,
          prefixHashStable: true,
          mcpSnapshotStable: true,
          lastHookAt: null,
          lastCompactAt: null,
          recentEvents: [],
        },
      };
    }
  }

  if (input.pluginId === "builtin.bots-core") {
    const callerKind = input.callerKind ?? "host-client";
    const body = (input.payload ?? {}) as Record<string, unknown>;
    const botsCore = input.controlPlane?.botsCore;

    if (input.method === "status") {
      const summary = botsCore?.getSummary() ?? {
        botCount: 0,
        activeBotCount: 0,
        boundThreadCount: 0,
        pendingDecisionGates: 0,
        botsDir: "",
      };
      return {
        channels: ["community.napcat-qq"],
        soulPrefixGuard: Boolean(pluginConfig.soulPrefixGuard ?? true),
        memoryMode: String(pluginConfig.memoryMode ?? "append-only"),
        autoReplyEnabled: Boolean(pluginConfig.autoReplyEnabled ?? true),
        replyMaxChars: Number(pluginConfig.replyMaxChars ?? 1500),
        turnWaitTimeoutSec: Number(pluginConfig.turnWaitTimeoutSec ?? 120),
        decisionGateSurfaces: ["web", "desktop-tray", "mobile-readonly"],
        ...summary,
      };
    }

    if (!botsCore) {
      return yield* new PluginRpcError({
        code: "invoke_failed",
        pluginId: input.pluginId,
        message: "ByteDock BotsCoreService is unavailable.",
      });
    }

    if (input.method === "getState") {
      return {
        ...botsCore.getState(),
        config: {
          soulPrefixGuard: Boolean(pluginConfig.soulPrefixGuard ?? true),
          memoryMode: String(pluginConfig.memoryMode ?? "append-only"),
          autoReplyEnabled: Boolean(pluginConfig.autoReplyEnabled ?? true),
          replyMaxChars: Number(pluginConfig.replyMaxChars ?? 1500),
          turnWaitTimeoutSec: Number(pluginConfig.turnWaitTimeoutSec ?? 120),
        },
      };
    }

    if (input.method === "listThreads") {
      const bridge = input.controlPlane?.napcat.getThreadBridge();
      const threads = bridge ? yield* bridge.listThreads() : [];
      return {
        bridgeReady: bridge !== undefined,
        threads,
      };
    }

    if (input.method === "appendMemory") {
      if (typeof body.botId !== "string" || typeof body.entry !== "string") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "appendMemory requires string botId and string entry.",
        });
      }
      return yield* botsCore
        .appendMemory({
          botId: body.botId,
          entry: body.entry,
          source: typeof body.source === "string" ? body.source : input.hostActorId,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: input.pluginId,
                message: err.message,
              }),
          ),
        );
    }

    if (input.method === "openGate") {
      if (typeof body.title !== "string" || typeof body.summary !== "string") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "openGate requires string title and string summary.",
        });
      }
      return yield* botsCore
        .openGate({
          botId: typeof body.botId === "string" ? body.botId : undefined,
          threadId: typeof body.threadId === "string" ? body.threadId : undefined,
          title: body.title,
          summary: body.summary,
          createdBy: input.hostActorId ?? "host-session",
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: input.pluginId,
                message: err.message,
              }),
          ),
        );
    }

    if (callerKind !== "host-client") {
      return yield* new PluginRpcError({
        code: "unauthorized",
        pluginId: input.pluginId,
        message: `Method "${input.pluginId}.${input.method}" requires a local ByteDock host UI client.`,
      });
    }

    if (input.method === "upsertBot") {
      if (typeof body.id !== "string" || typeof body.name !== "string") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "upsertBot requires string id and string name.",
        });
      }
      return yield* botsCore
        .upsertBot({
          id: body.id,
          name: body.name,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          boundProjectId:
            body.boundProjectId === null
              ? null
              : typeof body.boundProjectId === "string"
                ? body.boundProjectId
                : undefined,
          boundThreadId:
            body.boundThreadId === null
              ? null
              : typeof body.boundThreadId === "string"
                ? body.boundThreadId
                : undefined,
          soulMarkdown: typeof body.soulMarkdown === "string" ? body.soulMarkdown : undefined,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: input.pluginId,
                message: err.message,
              }),
          ),
        );
    }

    if (input.method === "deleteBot") {
      if (typeof body.botId !== "string") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "deleteBot requires string botId.",
        });
      }
      return yield* botsCore.deleteBot(body.botId).pipe(
        Effect.mapError(
          (err) =>
            new PluginRpcError({
              code: "invoke_failed",
              pluginId: input.pluginId,
              message: err.message,
            }),
        ),
      );
    }

    if (input.method === "updateSoul") {
      if (typeof body.botId !== "string" || typeof body.soulMarkdown !== "string") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "updateSoul requires string botId and string soulMarkdown.",
        });
      }
      return yield* botsCore
        .updateSoul({
          botId: body.botId,
          soulMarkdown: body.soulMarkdown,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: input.pluginId,
                message: err.message,
              }),
          ),
        );
    }

    if (input.method === "resolveGate") {
      if (
        typeof body.gateId !== "string" ||
        (body.decision !== "approved" && body.decision !== "rejected")
      ) {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: 'resolveGate requires string gateId and decision "approved" | "rejected".',
        });
      }
      return yield* botsCore
        .resolveGate({
          gateId: body.gateId,
          decision: body.decision,
          resolvedBy: input.hostActorId ?? "host-session",
          resolvedVia: "control-center",
          note: typeof body.note === "string" ? body.note : undefined,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: input.pluginId,
                message: err.message,
              }),
          ),
        );
    }
  }

  if (input.pluginId === "community.napcat-qq") {
    const callerKind = input.callerKind ?? "host-client";
    const body = (input.payload ?? {}) as Record<string, unknown>;
    const napcat = input.controlPlane?.napcat;

    if (input.method === "status") {
      if (napcat) {
        return yield* napcat.getStatus();
      }
      return {
        endpointMode: String(pluginConfig.endpointMode ?? "loopback-only"),
        oneBotBaseUrl: String(pluginConfig.oneBotBaseUrl ?? "http://127.0.0.1:3000"),
        allowedHosts: Array.isArray(pluginConfig.allowedHosts)
          ? pluginConfig.allowedHosts
          : ["127.0.0.1", "localhost", "::1"],
        webhookRoute: String(
          pluginConfig.webhookRoute ?? "/api/plugins/community.napcat-qq/onebot/event",
        ),
        webhookAuthMode: String(pluginConfig.webhookAuthMode ?? "onebot-hmac"),
        rateLimitPerMin: Number(pluginConfig.rateLimitPerMin ?? 50),
        tokenSecretRef: String(pluginConfig.tokenSecretRef ?? "bytedock.napcat.webhook_token"),
        secretConfigured: false,
        secretStoreAvailable: false,
        allowedUserIds: Array.isArray(pluginConfig.allowedUserIds)
          ? pluginConfig.allowedUserIds
          : [],
        allowedGroupIds: Array.isArray(pluginConfig.allowedGroupIds)
          ? pluginConfig.allowedGroupIds
          : [],
        requireAtInGroup: Boolean(pluginConfig.requireAtInGroup ?? true),
        allowlistConfigured: false,
        threadBridgeReady: false,
        recentActivity: [],
      };
    }

    if (!napcat) {
      return yield* new PluginRpcError({
        code: "invoke_failed",
        pluginId: input.pluginId,
        message: "ByteDock NapCatChannelService is unavailable.",
      });
    }

    if (input.method === "testConnection") {
      return yield* napcat.testConnection();
    }

    if (callerKind !== "host-client") {
      return yield* new PluginRpcError({
        code: "unauthorized",
        pluginId: input.pluginId,
        message: `Method "${input.pluginId}.${input.method}" requires a local ByteDock host UI client.`,
      });
    }

    if (input.method === "setTokenSecret") {
      if (typeof body.token !== "string") {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message: "setTokenSecret requires a non-empty string token.",
        });
      }
      return yield* napcat.setTokenSecret(body.token).pipe(
        Effect.mapError(
          (err) =>
            new PluginRpcError({
              code: "invoke_failed",
              pluginId: input.pluginId,
              message: err.message,
            }),
        ),
      );
    }

    if (input.method === "clearTokenSecret") {
      return yield* napcat.clearTokenSecret().pipe(
        Effect.mapError(
          (err) =>
            new PluginRpcError({
              code: "invoke_failed",
              pluginId: input.pluginId,
              message: err.message,
            }),
        ),
      );
    }

    if (input.method === "simulateInbound") {
      if (
        (body.chatType !== "private" && body.chatType !== "group") ||
        typeof body.userId !== "string" ||
        typeof body.text !== "string"
      ) {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message:
            'simulateInbound requires chatType ("private" | "group"), string userId, and string text.',
        });
      }
      return yield* napcat
        .simulateInbound({
          chatType: body.chatType,
          userId: body.userId,
          groupId: typeof body.groupId === "string" ? body.groupId : undefined,
          text: body.text,
          mentionedBot: typeof body.mentionedBot === "boolean" ? body.mentionedBot : undefined,
          botId: typeof body.botId === "string" ? body.botId : undefined,
          waitForDispatch:
            typeof body.waitForDispatch === "boolean" ? body.waitForDispatch : undefined,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new PluginRpcError({
                code: "invoke_failed",
                pluginId: input.pluginId,
                message: err.message,
              }),
          ),
        );
    }

    if (input.method === "sendReply") {
      if (
        (body.chatType !== "private" && body.chatType !== "group") ||
        typeof body.targetId !== "string" ||
        typeof body.text !== "string"
      ) {
        return yield* new PluginRpcError({
          code: "invoke_failed",
          pluginId: input.pluginId,
          message:
            'sendReply requires chatType ("private" | "group"), string targetId, and string text.',
        });
      }
      return yield* napcat.sendReply({
        chatType: body.chatType,
        targetId: body.targetId,
        text: body.text,
      });
    }
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

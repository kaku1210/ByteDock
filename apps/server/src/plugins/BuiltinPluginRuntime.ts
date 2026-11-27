import * as Effect from "effect/Effect";
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as PluginKernel from "@bytedock/plugin-kernel";
import type { ByteDockPluginManifest } from "@bytedock/plugin-kernel";

import {
  discoverLegacySourcesReadOnly,
  runLegacyReadOnlyImport,
  scanLegacySourceReadOnly,
  type LegacyImportCategory,
  type LegacySourceBrand,
} from "./LegacyT3Importer.ts";

const BUILTIN_PLUGIN_MANIFESTS: ReadonlyArray<ByteDockPluginManifest> = [
  {
    id: "builtin.egress-guard",
    name: "ByteDock Egress Guard",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      networkHosts: ["**"],
      secretNamespaces: ["bytedock.egress"],
      storage: "kv",
      hooks: [{ name: "egress.request.before", onError: "deny", timeoutMs: 2_000 }],
    },
    contributes: {
      panels: [
        {
          id: "egress-guard",
          titleI18n: "Egress Guard",
          icon: "shield",
          mode: "declarative",
          defaultArea: "right",
        },
      ],
      statusBarItems: [{ id: "egress-shield", align: "right", priority: 10 }],
    },
  },
  {
    id: "builtin.token-optimizer",
    name: "ByteDock Token Optimizer & X-Ray",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      storage: "isolated-sqlite",
      hooks: [
        { name: "agent.open.before", onError: "pass", timeoutMs: 2_000 },
        { name: "agent.turn.before", onError: "pass", timeoutMs: 500 },
        { name: "agent.compact.before", onError: "pass", timeoutMs: 2_000 },
        { name: "agent.tool.after", onError: "pass", timeoutMs: 500 },
      ],
    },
    contributes: {
      statusBarItems: [{ id: "ttft-tps-cache", align: "right", priority: 20 }],
      timelineRenderers: [{ id: "xray-bill", matchType: "plugin-card" }],
    },
  },
  {
    id: "builtin.bots-core",
    name: "ByteDock Bots Core",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      storage: "isolated-sqlite",
      hooks: [
        { name: "agent.open.before", onError: "pass", timeoutMs: 2_000 },
        { name: "agent.turn.before", onError: "pass", timeoutMs: 300 },
        { name: "agent.compact.before", onError: "pass", timeoutMs: 2_000 },
      ],
    },
    contributes: {
      panels: [
        {
          id: "bots-manager",
          titleI18n: "Bots Manager",
          icon: "bot",
          mode: "declarative",
          defaultArea: "right",
        },
      ],
      timelineRenderers: [{ id: "decision-gate-card", matchType: "plugin-card" }],
    },
  },
  {
    id: "community.napcat-qq",
    name: "NapCatQQ OneBot v11 Channel",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "local-dev",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      secretNamespaces: ["bytedock.napcat"],
      networkHosts: ["127.0.0.1", "localhost"],
      storage: "kv",
      hooks: [{ name: "egress.request.before", onError: "deny", timeoutMs: 2_000 }],
    },
    contributes: {
      settingsSection: {
        id: "napcat-qq",
        titleI18n: "NapCatQQ Channel",
        group: "plugins",
        icon: "message-square",
      },
      statusBarItems: [{ id: "napcat-status", align: "right", priority: 40 }],
    },
  },
  {
    id: "builtin.legacy-importer",
    name: "T3 Code / T3 Code Plus Read-Only Importer",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      storage: "none",
    },
    contributes: {
      settingsSection: {
        id: "legacy-import",
        titleI18n: "Import from T3 Code / Plus",
        group: "plugins",
        icon: "download",
      },
    },
  },
];

const BUILTIN_METHODS: ReadonlyArray<{
  readonly pluginId: string;
  readonly method: string;
  readonly minScopes: ReadonlyArray<string>;
}> = [
  { pluginId: "builtin.egress-guard", method: "status", minScopes: [AuthOrchestrationReadScope] },
  {
    pluginId: "builtin.egress-guard",
    method: "runProof",
    minScopes: [AuthOrchestrationOperateScope],
  },
  {
    pluginId: "builtin.token-optimizer",
    method: "status",
    minScopes: [AuthOrchestrationReadScope],
  },
  { pluginId: "builtin.bots-core", method: "status", minScopes: [AuthOrchestrationReadScope] },
  { pluginId: "community.napcat-qq", method: "status", minScopes: [AuthOrchestrationReadScope] },
  { pluginId: "builtin.legacy-importer", method: "scan", minScopes: [AuthOrchestrationReadScope] },
  {
    pluginId: "builtin.legacy-importer",
    method: "import",
    minScopes: [AuthOrchestrationOperateScope],
  },
];

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

/** Dispatches authorized builtin plugin RPC calls (Egress Guard, Token Optimizer, Bots, Legacy Importer). */
export function invokeBuiltinPluginMethod(input: {
  readonly kernel: PluginKernel.PluginKernelService;
  readonly targetStateDir: string;
  readonly pluginId: string;
  readonly method: string;
  readonly payload: unknown;
}): Effect.Effect<unknown> {
  return Effect.sync(() => {
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
        cacheGuardActive: true,
        steadyStateTargetPct: 90,
        xrayHonestyMode: "strict-no-fabrication",
      };
    }

    if (input.pluginId === "builtin.bots-core" && input.method === "status") {
      return {
        channels: ["community.napcat-qq"],
        soulPrefixGuard: true,
        memoryMode: "append-only",
        decisionGateSurfaces: ["web", "desktop-tray", "mobile-readonly"],
      };
    }

    if (input.pluginId === "community.napcat-qq" && input.method === "status") {
      return {
        endpointMode: "loopback-only",
        allowedHosts: ["127.0.0.1", "localhost"],
        webhookRoute: "/api/plugins/community.napcat-qq/onebot/event",
        rateLimitPerMin: 50,
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
        if (
          !body.sourceBaseDir ||
          !Array.isArray(body.categories) ||
          body.categories.length === 0
        ) {
          return { error: "sourceBaseDir and non-empty categories are required." };
        }
        return runLegacyReadOnlyImport({
          sourceBaseDir: body.sourceBaseDir,
          sourceBrand: body.sourceBrand,
          targetStateDir: input.targetStateDir,
          categories: body.categories,
          overwrite: body.overwrite ?? true,
          // Live server owns statev2.sqlite on Windows; stage snapshot for safe restart promotion.
          deferLockedStateDb: body.deferLockedStateDb ?? true,
        });
      }
    }

    return null;
  });
}

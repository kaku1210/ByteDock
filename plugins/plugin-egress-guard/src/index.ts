import * as Effect from "effect/Effect";
import {
  createEgressGuard,
  DEFAULT_DENIED_DOMAINS,
  EGRESS_HONEST_DISCLOSURES,
  evaluateHostPolicy,
  type EgressGuardController,
  type EgressPolicy,
  type EgressProofReport,
} from "@bytedock/plugin-kernel/egressGuard";
import type { HookDecision, HookInvocation } from "@bytedock/plugin-sdk/bridge";
import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import { defineServerPlugin, type PluginServerContext } from "@bytedock/plugin-sdk/server";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

export { EGRESS_HONEST_DISCLOSURES };

export const EGRESS_GUARD_MANIFEST: ByteDockPluginManifest = {
  id: "builtin.egress-guard",
  name: "Egress Guard",
  version: "0.1.0",
  apiVersion: "0.1.0",
  execution: "trusted-worker",
  trust: "builtin",
  entry: { server: "src/index.ts" },
  permissions: {
    rpcScopes: ["orchestration:read", "diagnostics:read"],
    networkHosts: ["**"],
    secretNamespaces: ["bytedock.egress"],
    storage: "kv",
    hooks: [
      { name: "egress.request.before", onError: "deny", timeoutMs: 2000 },
      { name: "worktree.create.before", onError: "deny" },
    ],
  },
  contributes: {
    panels: [
      {
        id: "egress-guard",
        titleI18n: "egress.panel.title",
        icon: "shield",
        mode: "declarative",
        defaultArea: "right",
      },
    ],
    statusBarItems: [{ id: "egress-shield", align: "right", priority: 100 }],
    timelineRenderers: [{ id: "egress-block-card", matchType: "plugin-card" }],
  },
};

export interface EgressGuardPanelState {
  readonly blockedCount: number;
  readonly allowedCount: number;
  readonly uncoveredNativeCount: number;
  readonly namedPipeCount: number;
  readonly proofVerdict: "pass" | "fail" | "pending";
  readonly auditChainState: "verified" | "rotated-unverified" | "broken";
}

/** Builds the declarative 12-primitive Egress Guard panel tree with honest KPI separation. */
export function buildEgressGuardPanelTree(state: EgressGuardPanelState): JsonNode {
  const shieldTone =
    state.auditChainState === "broken"
      ? "error"
      : state.auditChainState === "rotated-unverified"
        ? "warning"
        : "success";

  return {
    t: "Stack",
    p: { gap: "md" },
    c: [
      {
        t: "Row",
        p: { justify: "between", gap: "sm" },
        c: [
          { t: "Badge", p: { i18n: `egress.chain.${state.auditChainState}`, tone: shieldTone } },
          {
            t: "Button",
            p: {
              labelI18n: "egress.action.runProof",
              on: { action: "runProof", ns: "builtin.egress-guard" },
            },
          },
        ],
      },
      {
        t: "Card",
        p: {
          titleI18n: "egress.panel.kpiTitle",
          kpiColumns: 4,
          kpi: [
            { labelI18n: "egress.kpi.blocked", value: state.blockedCount, tone: "warning" },
            { labelI18n: "egress.kpi.allowed", value: state.allowedCount, tone: "info" },
            {
              labelI18n: "egress.kpi.uncoveredNative",
              value: state.uncoveredNativeCount,
              detailI18n: "egress.kpi.uncoveredNativeNote",
              tone: "neutral",
            },
            {
              labelI18n: "egress.kpi.proofVerdict",
              value: state.proofVerdict.toUpperCase(),
              tone: state.proofVerdict === "pass" ? "success" : "error",
            },
          ],
        },
        c: [
          {
            t: "Text",
            p: { i18n: EGRESS_HONEST_DISCLOSURES.coverageScope, size: "sm", tone: "neutral" },
          },
          {
            t: "Text",
            p: { i18n: EGRESS_HONEST_DISCLOSURES.verifiablePromise, size: "sm", tone: "neutral" },
          },
          {
            t: "Text",
            p: { i18n: EGRESS_HONEST_DISCLOSURES.tierMatrix, size: "sm", tone: "neutral" },
          },
        ],
      },
      {
        t: "StreamLog",
        p: {
          sinkId: "egress-audit-log",
          columns: ["time", "host", "verdict", "pluginId", "origin"],
        },
      },
    ],
  };
}

export interface EgressGuardPluginRuntime {
  readonly controller: EgressGuardController;
  readonly evaluateHook: (invocation: HookInvocation) => Effect.Effect<HookDecision>;
  readonly runProof: (options?: {
    readonly runDetachedProbes?: boolean | undefined;
  }) => EgressProofReport;
  readonly getPanelState: (
    auditChainState: "verified" | "rotated-unverified" | "broken",
  ) => EgressGuardPanelState;
}

export function createEgressGuardPluginRuntime(options?: {
  readonly policy?: Partial<EgressPolicy> | undefined;
  readonly auditFilePath?: string | undefined;
}): EgressGuardPluginRuntime {
  const controller = createEgressGuard({
    policy: {
      mode: options?.policy?.mode ?? "strict",
      deniedDomains: options?.policy?.deniedDomains ?? DEFAULT_DENIED_DOMAINS,
      allowedHosts: options?.policy?.allowedHosts ?? [],
      allowLoopbackHosts: options?.policy?.allowLoopbackHosts ?? ["127.0.0.1", "localhost", "::1"],
      allowUdp: options?.policy?.allowUdp ?? false,
    },
    auditFilePath: options?.auditFilePath,
  });

  let latestProof: EgressProofReport | undefined;

  const evaluateHook = (invocation: HookInvocation): Effect.Effect<HookDecision> =>
    Effect.sync(() => {
      const payload = invocation.input as {
        readonly host?: string;
        readonly port?: number;
      } | null;
      const host = payload?.host ?? "";
      const decision = evaluateHostPolicy(host, controller.getPolicy());
      controller.recordAudit({
        layer: "dispatcher",
        host,
        port: payload?.port,
        verdict: decision.verdict,
        reason: decision.reason,
        pluginId: EGRESS_GUARD_MANIFEST.id,
        origin: "host-js",
      });
      if (!decision.allowed) {
        return { verdict: "deny", reason: decision.reason } satisfies HookDecision;
      }
      return { verdict: "pass" } satisfies HookDecision;
    });

  return {
    controller,
    evaluateHook,
    runProof: (opts) => {
      latestProof = controller.generateEgressProof({
        windowMs: 60_000,
        runDetachedProbes: opts?.runDetachedProbes,
      });
      return latestProof;
    },
    getPanelState: (auditChainState) => {
      const events = controller.getEvents();
      const proof = latestProof;
      const proofVerdict = !proof
        ? "pending"
        : proof.liveAttribution.verdict === "pass" && proof.detachedAllBlock.verdict === "pass"
          ? "pass"
          : "fail";
      return {
        blockedCount: events.filter((e) => e.verdict === "egress-denied").length,
        allowedCount: events.filter(
          (e) => e.verdict === "whitelist" || e.verdict === "loopback-allowed",
        ).length,
        uncoveredNativeCount: proof?.liveAttribution.uncoveredNative.length ?? 0,
        namedPipeCount: proof?.liveAttribution.counts.namedPipes ?? 0,
        proofVerdict,
        auditChainState,
      };
    },
  };
}

export const egressGuardServerPlugin = defineServerPlugin({
  manifest: EGRESS_GUARD_MANIFEST,
  activate: Effect.fn("pluginEgressGuard.activate")(function* (ctx: PluginServerContext) {
    const runtime = createEgressGuardPluginRuntime();
    yield* ctx.hooks.register("egress.request.before", runtime.evaluateHook, {
      priority: 1,
      onError: "deny",
      timeoutMs: 2_000,
    });
  }),
});

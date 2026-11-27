// @effect-diagnostics nodeBuiltinImport:off -- Token optimizer hashes prefixes, spills large tool artifacts, and persists X-Ray bills in isolated-sqlite.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { openIsolatedPluginSqlite } from "@bytedock/plugin-kernel/storage";
import {
  computeProfileKey,
  type AdapterCacheProfile,
  type CacheGuardError,
  type CacheImpactReport,
  type OutboundTurnPayload,
  type ProfileShiftEvent,
  type ToolCompactionStrategy,
} from "@bytedock/plugin-sdk/cacheGuard";
import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import { defineServerPlugin, type PluginServerContext } from "@bytedock/plugin-sdk/server";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

export const TOKEN_OPTIMIZER_MANIFEST: ByteDockPluginManifest = {
  id: "builtin.token-optimizer",
  name: "Token Optimizer & CacheGuard",
  version: "0.1.0",
  apiVersion: "0.1.0",
  execution: "trusted-worker",
  trust: "builtin",
  entry: { server: "src/index.ts" },
  permissions: {
    rpcScopes: ["orchestration:read", "diagnostics:read"],
    storage: "isolated-sqlite",
    hooks: [
      { name: "agent.open.before", onError: "pass", timeoutMs: 2000 },
      { name: "agent.turn.before", onError: "pass" },
      { name: "agent.compact.before", onError: "pass", timeoutMs: 2000 },
      { name: "agent.tool.after", onError: "pass" },
    ],
  },
  contributes: {
    statusBarItems: [{ id: "ttft-tps-cache", align: "right", priority: 90 }],
    timelineRenderers: [{ id: "xray-bill", matchType: "plugin-card" }],
  },
};

export interface PrefixBlock {
  readonly id: string;
  readonly body: string;
}

export interface TurnUsageSample {
  readonly cachedInput?: number | undefined;
  readonly input?: number | undefined;
  readonly cacheCreation?: number | undefined;
}

export interface TurnEvaluationInput {
  readonly threadId: string;
  readonly turnOrdinal: number;
  readonly revision: number;
  readonly profile: AdapterCacheProfile;
  readonly prefixBlocks: ReadonlyArray<PrefixBlock>;
  readonly mcpToolNames: ReadonlyArray<string>;
  readonly projectedMessage: string;
  readonly appendContext?: string | undefined;
  readonly isCompactBoundary?: boolean | undefined;
  readonly usage?: TurnUsageSample | undefined;
  readonly shiftTrigger?: "model-switch" | "provider-switch" | undefined;
}

export interface TurnEvaluationResult {
  readonly payload: OutboundTurnPayload;
  readonly report: CacheImpactReport;
  readonly violation?: CacheGuardError | undefined;
  readonly profileShift?: ProfileShiftEvent | undefined;
  readonly xrayNote?: string | undefined;
  readonly isCompactCommand: boolean;
}

interface ThreadCacheState {
  profileKey: string;
  pinnedPrefixHash: string;
  pinnedMcpHash: string;
}

function hashCanonical(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join("\n|\n")).digest("hex");
}

export function canonicalPrefixHash(blocks: ReadonlyArray<PrefixBlock>): string {
  const sorted = [...blocks].sort((a, b) => a.id.localeCompare(b.id));
  return hashCanonical(sorted.map((b) => `${b.id}=${b.body}`));
}

export function canonicalMcpSnapshotHash(toolNames: ReadonlyArray<string>): string {
  return hashCanonical([...toolNames].sort());
}

/**
 * Dual-track CacheGuard engine implementing ADR-06 Laws #1-#6:
 * - Deterministic prefix pin & MCP snapshot stability
 * - Expected mid-thread ProfileShiftEvent re-open (zero false violations)
 * - Projection-safe outboundUserText wrapping (immune to /compact false triggers)
 */
export class CacheGuardEngine {
  private readonly threads = new Map<string, ThreadCacheState>();
  private readonly bills: Array<CacheImpactReport> = [];
  private readonly shifts: Array<ProfileShiftEvent> = [];
  private readonly violations: Array<CacheGuardError> = [];

  evaluateTurn(input: TurnEvaluationInput): TurnEvaluationResult {
    const nextProfileKey = computeProfileKey(input.profile);
    const nextPrefixHash = canonicalPrefixHash(input.prefixBlocks);
    const nextMcpHash = canonicalMcpSnapshotHash(input.mcpToolNames);

    // /compact detection strictly inspects projectedMessage, NEVER outboundUserText (ADR-06).
    const isCompactCommand = input.projectedMessage.trim().toLowerCase() === "/compact";
    const outboundUserText =
      input.appendContext && input.profile.turnAppend !== "unsupported"
        ? `${input.projectedMessage}\n\n${input.appendContext}`
        : input.projectedMessage;

    const payload: OutboundTurnPayload = {
      projectedMessage: input.projectedMessage,
      outboundUserText,
    };

    const prev = this.threads.get(input.threadId);
    let profileShift: ProfileShiftEvent | undefined;
    let violation: CacheGuardError | undefined;
    let xrayNote: string | undefined;
    let prefixHashStable = true;
    let mcpSnapshotStable = true;

    if (!prev) {
      this.threads.set(input.threadId, {
        profileKey: nextProfileKey,
        pinnedPrefixHash: nextPrefixHash,
        pinnedMcpHash: nextMcpHash,
      });
    } else if (prev.profileKey !== nextProfileKey) {
      // Mid-thread model/provider shift: expected session re-open, excluded from violations.
      profileShift = {
        fromProfileKey: prev.profileKey,
        toProfileKey: nextProfileKey,
        turnOrdinal: input.turnOrdinal,
        trigger: input.shiftTrigger ?? "model-switch",
      };
      this.shifts.push(profileShift);
      xrayNote = "profile-shift re-open";
      this.threads.set(input.threadId, {
        profileKey: nextProfileKey,
        pinnedPrefixHash: nextPrefixHash,
        pinnedMcpHash: nextMcpHash,
      });
    } else if (input.isCompactBoundary || isCompactCommand) {
      // Compact boundary is the sole legal prefix reset point.
      this.threads.set(input.threadId, {
        profileKey: nextProfileKey,
        pinnedPrefixHash: nextPrefixHash,
        pinnedMcpHash: nextMcpHash,
      });
    } else {
      prefixHashStable = prev.pinnedPrefixHash === nextPrefixHash;
      mcpSnapshotStable = prev.pinnedMcpHash === nextMcpHash;
      if (!prefixHashStable) {
        violation = {
          _tag: "PrefixImmutabilityViolation",
          offender: "prefix-blocks",
          revision: input.revision,
        };
        this.violations.push(violation);
      }
    }

    // Law #6: never fabricate cache metrics on opaque CLI/ACP tracks.
    const isOpaque = input.profile.usageVisibility === "opaque";
    const report: CacheImpactReport = {
      threadId: input.threadId,
      turnOrdinal: input.turnOrdinal,
      status: isOpaque ? "opaque" : input.profile.track === "stateless-api" ? "measured" : "native",
      ...(!isOpaque && input.usage?.cachedInput !== undefined
        ? { cachedInput: input.usage.cachedInput }
        : {}),
      ...(!isOpaque && input.usage?.input !== undefined ? { input: input.usage.input } : {}),
      ...(!isOpaque && input.usage?.cacheCreation !== undefined
        ? { cacheCreation: input.usage.cacheCreation }
        : {}),
      hostInvariants: {
        prefixHashStable,
        mcpSnapshotStable,
        contributionInBounds: (input.appendContext?.length ?? 0) <= 16_384,
      },
      ...(violation?._tag === "PrefixImmutabilityViolation"
        ? { invalidatedBy: [violation.offender] }
        : {}),
    };

    this.bills.push(report);
    return {
      payload,
      report,
      ...(violation ? { violation } : {}),
      ...(profileShift ? { profileShift } : {}),
      ...(xrayNote ? { xrayNote } : {}),
      isCompactCommand,
    };
  }

  computeSteadyStateCacheRatio(threadId: string): number | undefined {
    const measured = this.bills.filter(
      (b) => b.threadId === threadId && b.status === "measured" && b.cachedInput !== undefined,
    );
    if (measured.length === 0) return undefined;
    let cachedSum = 0;
    let totalSum = 0;
    for (const b of measured) {
      const c = b.cachedInput ?? 0;
      const i = b.input ?? 0;
      const cr = b.cacheCreation ?? 0;
      cachedSum += c;
      totalSum += c + i + cr;
    }
    return totalSum === 0 ? 0 : cachedSum / totalSum;
  }

  getProfileShifts(): ReadonlyArray<ProfileShiftEvent> {
    return this.shifts.slice();
  }

  getViolations(): ReadonlyArray<CacheGuardError> {
    return this.violations.slice();
  }
}

/**
 * Law #5 spill helper: writes oversized tool output to ~/.bytedock/artifacts/<threadId>/
 * and returns a compact reference marker for turn-boundary replacement.
 */
export function spillOversizedToolOutput(input: {
  readonly strategy: ToolCompactionStrategy;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly outputText: string;
}): { readonly spilled: boolean; readonly artifactRef?: string; readonly bytes: number } {
  const bytes = Buffer.byteLength(input.outputText, "utf8");
  const approxTokens = Math.ceil(bytes / 4);
  if (approxTokens <= input.strategy.thresholdTokens) {
    return { spilled: false, bytes };
  }
  const safeThread = input.threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeCall = input.toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = NodePath.join(input.strategy.artifactDir, safeThread);
  NodeFS.mkdirSync(dir, { recursive: true });
  const filePath = NodePath.join(dir, `${safeCall}.txt`);
  NodeFS.writeFileSync(filePath, input.outputText, "utf8");
  return { spilled: true, artifactRef: filePath, bytes };
}

/** Opens the isolated Tier-3 SQLite store for Context X-Ray bill history. */
export function openXRayBillStore(pluginsDataDir: string) {
  const { dbPath, db } = openIsolatedPluginSqlite(pluginsDataDir, TOKEN_OPTIMIZER_MANIFEST.id);
  db.exec(`
    CREATE TABLE IF NOT EXISTS xray_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      cached_input INTEGER,
      input_tokens INTEGER,
      cache_creation INTEGER,
      invariants_json TEXT NOT NULL
    )
  `);
  return {
    dbPath,
    record: (report: CacheImpactReport) => {
      db.prepare(
        `INSERT INTO xray_bills (thread_id, turn_ordinal, status, cached_input, input_tokens, cache_creation, invariants_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        report.threadId,
        report.turnOrdinal,
        report.status,
        report.cachedInput ?? null,
        report.input ?? null,
        report.cacheCreation ?? null,
        JSON.stringify(report.hostInvariants),
      );
    },
    countForThread: (threadId: string): number => {
      const row = db
        .prepare("SELECT COUNT(*) AS cnt FROM xray_bills WHERE thread_id = ?")
        .get(threadId) as { readonly cnt?: number } | undefined;
      return Number(row?.cnt ?? 0);
    },
    close: () => db.close(),
  };
}

/** Builds a declarative 12-primitive Context X-Ray bill card (gray/honest in opaque mode). */
export function buildTokenOptimizerXRayCard(report: CacheImpactReport): JsonNode {
  const isOpaque = report.status === "opaque";
  const ratioPct =
    !isOpaque && report.cachedInput !== undefined
      ? Math.round(
          (report.cachedInput /
            Math.max(1, report.cachedInput + (report.input ?? 0) + (report.cacheCreation ?? 0))) *
            100,
        )
      : undefined;

  return {
    t: "Card",
    p: {
      titleI18n: "xray.card.title",
      kpiColumns: 4,
      kpi: [
        {
          labelI18n: "xray.kpi.cacheHit",
          value: isOpaque ? "N/A (opaque)" : `${ratioPct ?? 0}%`,
          ...(ratioPct !== undefined ? { progressPct: ratioPct } : {}),
          tone: isOpaque ? "neutral" : (ratioPct ?? 0) >= 90 ? "success" : "warning",
        },
        {
          labelI18n: "xray.kpi.status",
          value: report.status,
          tone: isOpaque ? "neutral" : "info",
        },
        {
          labelI18n: "xray.kpi.prefixStable",
          value: report.hostInvariants.prefixHashStable ? "OK" : "MUTATED",
          tone: report.hostInvariants.prefixHashStable ? "success" : "error",
        },
        {
          labelI18n: "xray.kpi.mcpStable",
          value: report.hostInvariants.mcpSnapshotStable ? "OK" : "DRIFT",
          tone: report.hostInvariants.mcpSnapshotStable ? "success" : "warning",
        },
      ],
    },
  };
}

export const tokenOptimizerServerPlugin = defineServerPlugin({
  manifest: TOKEN_OPTIMIZER_MANIFEST,
  activate: Effect.fn("pluginTokenOptimizer.activate")(function* (ctx: PluginServerContext) {
    yield* ctx.hooks.register("agent.turn.before", () => Effect.succeed({ verdict: "pass" }), {
      priority: 10,
      onError: "pass",
      timeoutMs: 200,
    });
  }),
});

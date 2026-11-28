import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import type * as PluginKernel from "@bytedock/plugin-kernel";

const TOKEN_OPTIMIZER_PLUGIN_ID = "builtin.token-optimizer";

export interface TokenOptimizerHostEvent {
  readonly kind: "open-prepare" | "open-session" | "turn-before" | "compact-before";
  readonly at: string;
  readonly revision: number;
  readonly modelId?: string | undefined;
  readonly note?: string | undefined;
}

export interface TokenOptimizerThreadHostSummary {
  readonly threadId: string;
  readonly tracked: boolean;
  readonly pinnedRevision: number | null;
  readonly lastModelId: string | null;
  readonly openSessionCount: number;
  readonly observedTurns: number;
  readonly compactCount: number;
  readonly modelSwitches: number;
  readonly prefixHashStable: boolean;
  readonly mcpSnapshotStable: boolean;
  readonly lastHookAt: string | null;
  readonly lastCompactAt: string | null;
  readonly recentEvents: ReadonlyArray<TokenOptimizerHostEvent>;
}

export interface TokenOptimizerHostOverview {
  readonly trackedThreads: number;
  readonly totalObservedTurns: number;
  readonly totalCompactBoundaries: number;
  readonly totalModelSwitches: number;
  readonly prefixViolations: number;
}

interface MutableThreadRecord {
  pinnedRevision: number | null;
  lastModelId: string | null;
  openSessionCount: number;
  observedTurns: number;
  compactCount: number;
  modelSwitches: number;
  prefixHashStable: boolean;
  mcpSnapshotStable: boolean;
  lastHookAt: string | null;
  lastCompactAt: string | null;
  recentEvents: Array<TokenOptimizerHostEvent>;
}

const MAX_TRACKED_THREADS = 200;
const MAX_EVENTS_PER_THREAD = 24;

export interface TokenOptimizerTelemetryService {
  readonly attachKernelHooks: (
    kernel: PluginKernel.PluginKernelService,
    revision: number,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly getOverview: () => TokenOptimizerHostOverview;
  readonly getThreadSummary: (threadId: string) => TokenOptimizerThreadHostSummary;
}

/**
 * In-memory host observer for builtin.token-optimizer CacheGuard invariants.
 * Hooks into PluginKernel lifecycle points without modifying upstream orchestration seams.
 */
export function makeTokenOptimizerTelemetry(): TokenOptimizerTelemetryService {
  const threads = new Map<string, MutableThreadRecord>();
  let totalObservedTurns = 0;
  let totalCompactBoundaries = 0;
  let totalModelSwitches = 0;
  let prefixViolations = 0;

  const touchThread = (threadId: string): MutableThreadRecord => {
    const existing = threads.get(threadId);
    if (existing) {
      // Refresh LRU insertion order.
      threads.delete(threadId);
      threads.set(threadId, existing);
      return existing;
    }
    if (threads.size >= MAX_TRACKED_THREADS) {
      const oldestKey = threads.keys().next().value;
      if (oldestKey !== undefined) {
        threads.delete(oldestKey);
      }
    }
    const created: MutableThreadRecord = {
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
    };
    threads.set(threadId, created);
    return created;
  };

  const pushEvent = (record: MutableThreadRecord, event: TokenOptimizerHostEvent) => {
    record.lastHookAt = event.at;
    record.recentEvents.push(event);
    if (record.recentEvents.length > MAX_EVENTS_PER_THREAD) {
      record.recentEvents.splice(0, record.recentEvents.length - MAX_EVENTS_PER_THREAD);
    }
  };

  const recordOpenHook = (input: unknown, revision: number, nowIso: string) => {
    if (!input || typeof input !== "object") return;
    const payload = input as {
      readonly stage?: unknown;
      readonly threadId?: unknown;
      readonly modelId?: unknown;
      readonly revision?: unknown;
    };
    if (typeof payload.threadId !== "string" || payload.threadId.length === 0) return;
    const record = touchThread(payload.threadId);
    const effectiveRev = typeof payload.revision === "number" ? payload.revision : revision;

    if (payload.stage === "prepare") {
      const modelId = typeof payload.modelId === "string" ? payload.modelId : undefined;
      let note: string | undefined;
      if (modelId && record.lastModelId && record.lastModelId !== modelId) {
        record.modelSwitches += 1;
        totalModelSwitches += 1;
        note = `model-switch:${record.lastModelId}->${modelId}`;
      }
      if (modelId) {
        record.lastModelId = modelId;
      }
      record.pinnedRevision = effectiveRev;
      pushEvent(record, {
        kind: "open-prepare",
        at: nowIso,
        revision: effectiveRev,
        ...(modelId ? { modelId } : {}),
        ...(note ? { note } : {}),
      });
      return;
    }

    if (payload.stage === "after-prepare") {
      record.openSessionCount += 1;
      record.pinnedRevision = effectiveRev;
      pushEvent(record, {
        kind: "open-session",
        at: nowIso,
        revision: effectiveRev,
      });
    }
  };

  const recordTurnHook = (input: unknown, revision: number, nowIso: string) => {
    if (!input || typeof input !== "object") return;
    const payload = input as {
      readonly threadId?: unknown;
      readonly revision?: unknown;
    };
    if (typeof payload.threadId !== "string" || payload.threadId.length === 0) return;
    const record = touchThread(payload.threadId);
    const effectiveRev = typeof payload.revision === "number" ? payload.revision : revision;
    if (record.pinnedRevision !== null && record.pinnedRevision !== effectiveRev) {
      // Revision rotated without a session re-open; flag honestly rather than hiding drift.
      record.prefixHashStable = false;
      prefixViolations += 1;
    } else if (record.pinnedRevision === null) {
      record.pinnedRevision = effectiveRev;
    }
    record.observedTurns += 1;
    totalObservedTurns += 1;
    pushEvent(record, {
      kind: "turn-before",
      at: nowIso,
      revision: effectiveRev,
    });
  };

  const recordCompactHook = (input: unknown, revision: number, nowIso: string) => {
    if (!input || typeof input !== "object") return;
    const payload = input as {
      readonly threadId?: unknown;
      readonly revision?: unknown;
    };
    if (typeof payload.threadId !== "string" || payload.threadId.length === 0) return;
    const record = touchThread(payload.threadId);
    const effectiveRev = typeof payload.revision === "number" ? payload.revision : revision;
    // Compaction is the sole legal prefix reset boundary (ADR-06).
    record.pinnedRevision = effectiveRev;
    record.prefixHashStable = true;
    record.mcpSnapshotStable = true;
    record.compactCount += 1;
    record.lastCompactAt = nowIso;
    totalCompactBoundaries += 1;
    pushEvent(record, {
      kind: "compact-before",
      at: nowIso,
      revision: effectiveRev,
      note: "compact-reset-boundary",
    });
  };

  const attachKernelHooks: TokenOptimizerTelemetryService["attachKernelHooks"] = Effect.fn(
    "TokenOptimizerTelemetry.attachKernelHooks",
  )(function* (kernel, revision) {
    yield* kernel.hooks.register({
      pluginId: TOKEN_OPTIMIZER_PLUGIN_ID,
      revision,
      name: "agent.open.before",
      priority: 10,
      onError: "pass",
      timeoutMs: 200,
      handler: (invocation) =>
        DateTime.now.pipe(
          Effect.map((now) => {
            recordOpenHook(invocation.input, invocation.revision, DateTime.formatIso(now));
            return { verdict: "pass" } as const;
          }),
        ),
    });
    yield* kernel.hooks.register({
      pluginId: TOKEN_OPTIMIZER_PLUGIN_ID,
      revision,
      name: "agent.turn.before",
      priority: 10,
      onError: "pass",
      timeoutMs: 150,
      handler: (invocation) =>
        DateTime.now.pipe(
          Effect.map((now) => {
            recordTurnHook(invocation.input, invocation.revision, DateTime.formatIso(now));
            return { verdict: "pass" } as const;
          }),
        ),
    });
    yield* kernel.hooks.register({
      pluginId: TOKEN_OPTIMIZER_PLUGIN_ID,
      revision,
      name: "agent.compact.before",
      priority: 10,
      onError: "pass",
      timeoutMs: 150,
      handler: (invocation) =>
        DateTime.now.pipe(
          Effect.map((now) => {
            recordCompactHook(invocation.input, invocation.revision, DateTime.formatIso(now));
            return { verdict: "pass" } as const;
          }),
        ),
    });
  });

  const getOverview = (): TokenOptimizerHostOverview => ({
    trackedThreads: threads.size,
    totalObservedTurns,
    totalCompactBoundaries,
    totalModelSwitches,
    prefixViolations,
  });

  const getThreadSummary = (threadId: string): TokenOptimizerThreadHostSummary => {
    const record = threads.get(threadId);
    if (!record) {
      return {
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
      };
    }
    return {
      threadId,
      tracked: true,
      pinnedRevision: record.pinnedRevision,
      lastModelId: record.lastModelId,
      openSessionCount: record.openSessionCount,
      observedTurns: record.observedTurns,
      compactCount: record.compactCount,
      modelSwitches: record.modelSwitches,
      prefixHashStable: record.prefixHashStable,
      mcpSnapshotStable: record.mcpSnapshotStable,
      lastHookAt: record.lastHookAt,
      lastCompactAt: record.lastCompactAt,
      recentEvents: record.recentEvents.slice(),
    };
  };

  return {
    attachKernelHooks,
    getOverview,
    getThreadSummary,
  };
}

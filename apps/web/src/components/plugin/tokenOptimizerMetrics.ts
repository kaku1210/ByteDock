import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { TokenOptimizerRuntimeConfig } from "./PluginSlotStore";

export type XRayCacheStatus = "measured" | "native" | "opaque";
export type XRayTpsStatus = "measured" | "streaming" | "unavailable";
export type WatchdogLevel = "idle" | "healthy" | "warn" | "critical";
export type WatchdogPhase =
  | "idle"
  | "awaiting-first-token"
  | "streaming-stalled"
  | "tool-execution"
  | "waiting-user";

export interface TurnXRayRow {
  readonly turnId: string;
  readonly ordinal: number;
  readonly runId: RunId | null;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly model: string | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly firstOutputAtMs: number | null;
  readonly ttftMs: number | null;
  readonly ttftPending: boolean;
  readonly totalDurationMs: number | null;
  readonly streamDurationMs: number | null;
  readonly effectiveTps: number | null;
  readonly tpsStatus: XRayTpsStatus;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly toolCallCount: number;
  readonly cacheStatus: XRayCacheStatus;
  readonly cacheHitPct: number | null;
  readonly targetMet: boolean | null;
}

export interface WatchdogAssessment {
  readonly level: WatchdogLevel;
  readonly phase: WatchdogPhase;
  readonly silenceMs: number;
  readonly activeRunId: RunId | null;
  readonly activeToolLabel: string | null;
  readonly stallKey: string | null;
  readonly warnAfterSec: number;
  readonly criticalAfterSec: number;
}

export interface ThreadObservabilitySummary {
  readonly hasTurns: boolean;
  readonly isLiveRunning: boolean;
  readonly activeRunId: RunId | null;
  readonly activeModel: string | null;
  readonly headlineTurn: TurnXRayRow | null;
  readonly turns: ReadonlyArray<TurnXRayRow>;
  readonly steadyStateCacheStatus: XRayCacheStatus;
  readonly steadyStateCacheHitPct: number | null;
  readonly steadyStateTargetPct: number;
  readonly measuredTurnCount: number;
  readonly totalInputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningTokens: number;
  readonly contextUsedTokens: number | null;
  readonly contextMaxTokens: number | null;
  readonly contextUsedPct: number | null;
  readonly watchdog: WatchdogAssessment;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);
const ACTIVE_TURN_STATUSES = new Set(["pending", "running"]);
const SETTLED_ITEM_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const OUTPUT_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "assistant_message",
  "reasoning",
]);
const NON_TOOL_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "user_message",
  "assistant_message",
  "reasoning",
  "notification",
  "proposed_plan",
  "compaction",
]);
const MIN_EFFECTIVE_STREAM_WINDOW_MS = 200;

function toEpochMs(value: DateTime.Utc | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return DateTime.toEpochMillis(value);
}

function itemStartMs(item: OrchestrationV2TurnItem): number | null {
  const maybeRecord = item as {
    readonly startedAt?: DateTime.Utc | null;
    readonly createdAt?: DateTime.Utc | null;
    readonly updatedAt?: DateTime.Utc | null;
  };
  return (
    toEpochMs(maybeRecord.startedAt) ??
    toEpochMs(maybeRecord.createdAt) ??
    toEpochMs(maybeRecord.updatedAt)
  );
}

function itemLatestMs(item: OrchestrationV2TurnItem): number | null {
  const maybeRecord = item as {
    readonly updatedAt?: DateTime.Utc | null;
    readonly completedAt?: DateTime.Utc | null;
    readonly startedAt?: DateTime.Utc | null;
    readonly createdAt?: DateTime.Utc | null;
  };
  const candidates = [
    toEpochMs(maybeRecord.updatedAt),
    toEpochMs(maybeRecord.completedAt),
    toEpochMs(maybeRecord.startedAt),
    toEpochMs(maybeRecord.createdAt),
  ].filter((ms): ms is number => ms !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function isToolLikeItem(item: OrchestrationV2TurnItem): boolean {
  return !NON_TOOL_ITEM_TYPES.has(item.type);
}

function resolveTurnUsage(turn: OrchestrationV2ProviderTurn): {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cacheStatus: XRayCacheStatus;
  readonly cacheHitPct: number | null;
} {
  const normalized = turn.turnTokenUsage;
  const live = turn.tokenUsage;

  const inputTokens =
    normalized && normalized.usageStatus !== "unavailable" && normalized.inputTokens !== undefined
      ? normalized.inputTokens
      : live?.inputTokens !== undefined
        ? live.inputTokens
        : null;

  const cachedInputTokens =
    normalized &&
    normalized.usageStatus !== "unavailable" &&
    normalized.cachedInputTokens !== undefined
      ? normalized.cachedInputTokens
      : live?.cachedInputTokens !== undefined
        ? live.cachedInputTokens
        : null;

  const cacheCreationTokens =
    normalized &&
    normalized.usageStatus !== "unavailable" &&
    normalized.cacheCreationTokens !== undefined
      ? normalized.cacheCreationTokens
      : null;

  const outputTokens =
    normalized && normalized.usageStatus !== "unavailable" && normalized.outputTokens !== undefined
      ? normalized.outputTokens
      : live?.outputTokens !== undefined
        ? live.outputTokens
        : null;

  const reasoningTokens =
    normalized &&
    normalized.usageStatus !== "unavailable" &&
    normalized.reasoningTokens !== undefined
      ? normalized.reasoningTokens
      : live?.reasoningOutputTokens !== undefined
        ? live.reasoningOutputTokens
        : null;

  // Law #6 (strict-no-fabrication): distinguish measured cache reads, native totals without cache breakdown, and opaque tracks.
  if (inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null) {
    // Provider contracts include cache reads & writes inside inputTokens.
    const clampedCached = Math.min(inputTokens, Math.max(0, cachedInputTokens));
    const clampedCreation = Math.min(
      Math.max(0, inputTokens - clampedCached),
      Math.max(0, cacheCreationTokens ?? 0),
    );
    const uncachedInputTokens = Math.max(0, inputTokens - clampedCached - clampedCreation);
    const cacheHitPct = Math.round((clampedCached / inputTokens) * 100);
    return {
      inputTokens,
      cachedInputTokens: clampedCached,
      cacheCreationTokens,
      uncachedInputTokens,
      outputTokens,
      reasoningTokens,
      cacheStatus: "measured",
      cacheHitPct,
    };
  }

  if (inputTokens !== null || outputTokens !== null) {
    return {
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      uncachedInputTokens: inputTokens,
      outputTokens,
      reasoningTokens,
      cacheStatus: "native",
      cacheHitPct: null,
    };
  }

  return {
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheStatus: "opaque",
    cacheHitPct: null,
  };
}

/** Returns true when a thread projection has an active running run or turn. */
export function hasActiveThreadRun(projection: OrchestrationV2ThreadProjection | null): boolean {
  if (!projection) return false;
  return (
    projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ||
    projection.providerTurns.some(
      (turn) => ACTIVE_TURN_STATUSES.has(turn.status) && turn.completedAt === null,
    )
  );
}

/** Formats milliseconds into compact human-readable durations (e.g. `420ms`, `1.4s`, `2m 08s`). */
export function formatCompactDurationMs(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSec = durationMs / 1_000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const remSec = Math.floor(totalSec % 60);
  return `${mins}m ${String(remSec).padStart(2, "0")}s`;
}

/** Formats integer token counts compactly (`842`, `12.4k`, `1.2M`). */
export function formatCompactTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return "-";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/**
 * Pure, deterministic observability & Watchdog evaluator over live thread projections.
 * Never fabricates cache hit rates or token throughput when provider counters are absent.
 */
export function computeThreadObservability(input: {
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly nowMs: number;
  readonly config: TokenOptimizerRuntimeConfig;
}): ThreadObservabilitySummary {
  const { projection, nowMs, config } = input;
  const emptyWatchdog: WatchdogAssessment = {
    level: "idle",
    phase: "idle",
    silenceMs: 0,
    activeRunId: null,
    activeToolLabel: null,
    stallKey: null,
    warnAfterSec: config.watchdogWarnAfterSec,
    criticalAfterSec: config.watchdogCriticalAfterSec,
  };

  if (!projection) {
    return {
      hasTurns: false,
      isLiveRunning: false,
      activeRunId: null,
      activeModel: null,
      headlineTurn: null,
      turns: [],
      steadyStateCacheStatus: "opaque",
      steadyStateCacheHitPct: null,
      steadyStateTargetPct: config.steadyStateTargetPct,
      measuredTurnCount: 0,
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalCacheCreationTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      contextUsedTokens: null,
      contextMaxTokens: null,
      contextUsedPct: null,
      watchdog: emptyWatchdog,
    };
  }

  const attemptToRunId = new Map<string, RunId>();
  for (const attempt of projection.attempts) {
    attemptToRunId.set(attempt.id, attempt.runId);
  }
  const runById = new Map(projection.runs.map((run) => [run.id, run]));

  const itemsByTurnId = new Map<string, Array<OrchestrationV2TurnItem>>();
  const itemsByRunId = new Map<string, Array<OrchestrationV2TurnItem>>();
  for (const item of projection.turnItems) {
    if (item.providerTurnId) {
      const bucket = itemsByTurnId.get(item.providerTurnId);
      if (bucket) bucket.push(item);
      else itemsByTurnId.set(item.providerTurnId, [item]);
    }
    if (item.runId) {
      const bucket = itemsByRunId.get(item.runId);
      if (bucket) bucket.push(item);
      else itemsByRunId.set(item.runId, [item]);
    }
  }

  const activeProviderThreadId = projection.thread.activeProviderThreadId;
  const candidateTurns =
    activeProviderThreadId !== null
      ? projection.providerTurns.filter((turn) => turn.providerThreadId === activeProviderThreadId)
      : projection.providerTurns;
  const effectiveTurns = candidateTurns.length > 0 ? candidateTurns : projection.providerTurns;

  const rows: Array<TurnXRayRow> = [];
  let totalInputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let measuredInputSum = 0;
  let measuredCachedSum = 0;
  let measuredTurnCount = 0;
  let sawNativeTokens = false;

  for (const turn of effectiveTurns) {
    if (turn.promptDropped === true) continue;
    const runId = turn.runAttemptId ? (attemptToRunId.get(turn.runAttemptId) ?? null) : null;
    const parentRun = runId ? (runById.get(runId) ?? null) : null;
    const turnItems = itemsByTurnId.get(turn.id) ?? (runId ? (itemsByRunId.get(runId) ?? []) : []);

    const startedAtMs =
      toEpochMs(turn.startedAt) ??
      toEpochMs(parentRun?.workStartedAt) ??
      toEpochMs(parentRun?.startedAt) ??
      toEpochMs(parentRun?.requestedAt);
    const completedAtMs = toEpochMs(turn.completedAt);
    const isTurnActive = ACTIVE_TURN_STATUSES.has(turn.status) && completedAtMs === null;

    let firstOutputAtMs: number | null = null;
    let lastOutputAtMs: number | null = null;
    let hasStreamingOutput = false;
    let toolCallCount = 0;

    for (const item of turnItems) {
      if (isToolLikeItem(item)) {
        toolCallCount += 1;
      }
      if (OUTPUT_ITEM_TYPES.has(item.type)) {
        const startMs = itemStartMs(item);
        const latestMs = itemLatestMs(item);
        if (startMs !== null && (firstOutputAtMs === null || startMs < firstOutputAtMs)) {
          firstOutputAtMs = startMs;
        }
        if (latestMs !== null && (lastOutputAtMs === null || latestMs > lastOutputAtMs)) {
          lastOutputAtMs = latestMs;
        }
        if (
          (item.type === "assistant_message" || item.type === "reasoning") &&
          item.streaming === true
        ) {
          hasStreamingOutput = true;
        }
      }
    }

    const ttftPending = isTurnActive && startedAtMs !== null && firstOutputAtMs === null;
    const ttftMs =
      startedAtMs === null
        ? null
        : firstOutputAtMs !== null
          ? Math.max(0, firstOutputAtMs - startedAtMs)
          : isTurnActive
            ? Math.max(0, nowMs - startedAtMs)
            : null;

    const endMs = completedAtMs ?? (isTurnActive ? nowMs : lastOutputAtMs);
    const totalDurationMs =
      startedAtMs !== null && endMs !== null ? Math.max(0, endMs - startedAtMs) : null;

    const streamEndMs =
      completedAtMs ??
      (isTurnActive && hasStreamingOutput ? nowMs : (lastOutputAtMs ?? completedAtMs));
    const streamDurationMs =
      firstOutputAtMs !== null && streamEndMs !== null
        ? Math.max(0, streamEndMs - firstOutputAtMs)
        : null;

    const usage = resolveTurnUsage(turn);
    if (usage.inputTokens !== null) totalInputTokens += usage.inputTokens;
    if (usage.cachedInputTokens !== null) totalCachedInputTokens += usage.cachedInputTokens;
    if (usage.cacheCreationTokens !== null) totalCacheCreationTokens += usage.cacheCreationTokens;
    if (usage.outputTokens !== null) totalOutputTokens += usage.outputTokens;
    if (usage.reasoningTokens !== null) totalReasoningTokens += usage.reasoningTokens;

    if (
      usage.cacheStatus === "measured" &&
      usage.inputTokens !== null &&
      usage.cachedInputTokens !== null
    ) {
      measuredTurnCount += 1;
      measuredInputSum += usage.inputTokens;
      measuredCachedSum += usage.cachedInputTokens;
    } else if (usage.cacheStatus === "native") {
      sawNativeTokens = true;
    }

    let effectiveTps: number | null = null;
    let tpsStatus: XRayTpsStatus = "unavailable";
    if (usage.outputTokens !== null && usage.outputTokens > 0) {
      const denominatorMs =
        streamDurationMs !== null && streamDurationMs >= MIN_EFFECTIVE_STREAM_WINDOW_MS
          ? streamDurationMs
          : totalDurationMs !== null && totalDurationMs >= MIN_EFFECTIVE_STREAM_WINDOW_MS
            ? totalDurationMs
            : null;
      if (denominatorMs !== null) {
        effectiveTps = Number((usage.outputTokens / (denominatorMs / 1_000)).toFixed(1));
        tpsStatus = "measured";
      }
    } else if (isTurnActive && (hasStreamingOutput || firstOutputAtMs !== null)) {
      tpsStatus = "streaming";
    }

    const model =
      turn.model ??
      turn.turnTokenUsage?.models?.[0] ??
      projection.thread.modelSelection.model ??
      null;

    rows.push({
      turnId: turn.id,
      ordinal: turn.ordinal,
      runId,
      status: turn.status,
      model,
      startedAtMs,
      completedAtMs,
      firstOutputAtMs,
      ttftMs,
      ttftPending,
      totalDurationMs,
      streamDurationMs,
      effectiveTps,
      tpsStatus,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      uncachedInputTokens: usage.uncachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      toolCallCount,
      cacheStatus: usage.cacheStatus,
      cacheHitPct: usage.cacheHitPct,
      targetMet:
        usage.cacheHitPct !== null ? usage.cacheHitPct >= config.steadyStateTargetPct : null,
    });
  }

  // Present newest turn first for quick inspection.
  rows.sort((a, b) => b.ordinal - a.ordinal);

  const activeRun = projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  const waitingRun = projection.runs.findLast((run) => run.status === "waiting") ?? null;
  const hasPendingRuntimeRequest = projection.runtimeRequests.some(
    (req) => req.status === "pending",
  );
  const runningTurnRow = rows.find((row) => ACTIVE_TURN_STATUSES.has(row.status)) ?? null;
  const headlineTurn = runningTurnRow ?? rows[0] ?? null;
  const isLiveRunning = activeRun !== null || runningTurnRow !== null;

  // Latest context window snapshot from provider turns.
  let contextUsedTokens: number | null = null;
  let contextMaxTokens: number | null = null;
  let latestUsageMs = -1;
  for (const turn of effectiveTurns) {
    const liveUsage = turn.tokenUsage;
    if (!liveUsage) continue;
    const updatedMs = toEpochMs(liveUsage.updatedAt) ?? 0;
    if (updatedMs >= latestUsageMs) {
      latestUsageMs = updatedMs;
      contextUsedTokens = liveUsage.usedTokens;
      contextMaxTokens = liveUsage.maxTokens ?? null;
    }
  }
  const contextUsedPct =
    contextUsedTokens !== null && contextMaxTokens !== null && contextMaxTokens > 0
      ? Math.min(100, Math.round((contextUsedTokens / contextMaxTokens) * 100))
      : null;

  // Steady-state cache ratio across measured turns in this thread.
  const steadyStateCacheStatus: XRayCacheStatus =
    measuredTurnCount > 0 ? "measured" : sawNativeTokens ? "native" : "opaque";
  const steadyStateCacheHitPct =
    measuredTurnCount > 0 && measuredInputSum > 0
      ? Math.round((measuredCachedSum / measuredInputSum) * 100)
      : null;

  // Anti-stall Watchdog assessment.
  let watchdog: WatchdogAssessment = emptyWatchdog;
  if (hasPendingRuntimeRequest || (waitingRun !== null && activeRun === null)) {
    watchdog = {
      level: "healthy",
      phase: "waiting-user",
      silenceMs: 0,
      activeRunId: waitingRun?.id ?? activeRun?.id ?? null,
      activeToolLabel: null,
      stallKey: null,
      warnAfterSec: config.watchdogWarnAfterSec,
      criticalAfterSec: config.watchdogCriticalAfterSec,
    };
  } else if (isLiveRunning) {
    const activeRunId = activeRun?.id ?? runningTurnRow?.runId ?? null;
    const runItems = activeRunId ? (itemsByRunId.get(activeRunId) ?? []) : [];
    const activeToolItem =
      runItems.findLast(
        (item) => isToolLikeItem(item) && !SETTLED_ITEM_STATUSES.has(item.status),
      ) ?? null;

    const activityTimestamps: Array<number> = [];
    const runStartMs =
      toEpochMs(activeRun?.workStartedAt) ??
      toEpochMs(activeRun?.startedAt) ??
      toEpochMs(activeRun?.requestedAt);
    if (runStartMs !== null) activityTimestamps.push(runStartMs);
    if (runningTurnRow?.startedAtMs !== null && runningTurnRow?.startedAtMs !== undefined) {
      activityTimestamps.push(runningTurnRow.startedAtMs);
    }
    if (latestUsageMs > 0 && activeRun && latestUsageMs >= (runStartMs ?? 0)) {
      activityTimestamps.push(latestUsageMs);
    }
    for (const item of runItems) {
      const latest = itemLatestMs(item);
      if (latest !== null) activityTimestamps.push(latest);
    }

    const lastActivityMs = activityTimestamps.length > 0 ? Math.max(...activityTimestamps) : nowMs;
    const silenceMs = Math.max(0, nowMs - lastActivityMs);

    const phase: WatchdogPhase = activeToolItem
      ? "tool-execution"
      : runningTurnRow?.firstOutputAtMs != null
        ? "streaming-stalled"
        : "awaiting-first-token";

    let level: WatchdogLevel = "healthy";
    if (config.enabled && config.watchdogEnabled) {
      if (silenceMs >= config.watchdogCriticalAfterSec * 1_000) {
        level = "critical";
      } else if (silenceMs >= config.watchdogWarnAfterSec * 1_000) {
        level = "warn";
      }
    }

    watchdog = {
      level,
      phase,
      silenceMs,
      activeRunId,
      activeToolLabel: activeToolItem?.title ?? (activeToolItem ? activeToolItem.type : null),
      stallKey:
        level === "warn" || level === "critical"
          ? `${activeRunId ?? "live"}:${lastActivityMs}`
          : null,
      warnAfterSec: config.watchdogWarnAfterSec,
      criticalAfterSec: config.watchdogCriticalAfterSec,
    };
  }

  return {
    hasTurns: rows.length > 0,
    isLiveRunning,
    activeRunId: activeRun?.id ?? runningTurnRow?.runId ?? null,
    activeModel: headlineTurn?.model ?? projection.thread.modelSelection.model ?? null,
    headlineTurn,
    turns: rows,
    steadyStateCacheStatus,
    steadyStateCacheHitPct,
    steadyStateTargetPct: config.steadyStateTargetPct,
    measuredTurnCount,
    totalInputTokens,
    totalCachedInputTokens,
    totalCacheCreationTokens,
    totalOutputTokens,
    totalReasoningTokens,
    contextUsedTokens,
    contextMaxTokens,
    contextUsedPct,
    watchdog,
  };
}

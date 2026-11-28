import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG } from "./PluginSlotStore";
import {
  computeThreadObservability,
  formatCompactDurationMs,
  formatCompactTokens,
} from "./tokenOptimizerMetrics";

const BASE_MS = Date.parse("2026-11-28T12:00:00.000Z");

function utc(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(BASE_MS + offsetMs);
}

function makeProjection(overrides: {
  readonly runs?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly providerTurns?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly turnItems?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly runtimeRequests?: ReadonlyArray<{ readonly status: string }>;
}): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: "thread-obs-1",
      activeProviderThreadId: "pthread-1",
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claude-main",
        model: "claude-opus-4-6",
      },
    },
    runs: (overrides.runs ?? []).map((run, idx) => ({
      id: `run-${idx + 1}`,
      ordinal: idx + 1,
      status: "completed",
      requestedAt: utc(0),
      startedAt: utc(0),
      completedAt: utc(5_000),
      activeAttemptId: `attempt-${idx + 1}`,
      ...run,
    })),
    attempts: (overrides.runs ?? []).map((run, idx) => ({
      id: run.activeAttemptId ?? `attempt-${idx + 1}`,
      runId: run.id ?? `run-${idx + 1}`,
    })),
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: (overrides.providerTurns ?? []).map((turn, idx) => ({
      id: `turn-${idx + 1}`,
      providerThreadId: "pthread-1",
      nodeId: "node-1",
      runAttemptId: `attempt-${idx + 1}`,
      nativeTurnRef: null,
      ordinal: idx + 1,
      status: "completed",
      startedAt: utc(0),
      completedAt: utc(5_000),
      ...turn,
    })),
    runtimeRequests: overrides.runtimeRequests ?? [],
    messages: [],
    plans: [],
    turnItems: overrides.turnItems ?? [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: utc(5_000),
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("tokenOptimizerMetrics", () => {
  it("computes measured TTFT, total duration, effective streaming TPS, and honest cache hit ratio", () => {
    const projection = makeProjection({
      runs: [{ id: "run-1", status: "completed", startedAt: utc(0), completedAt: utc(6_000) }],
      providerTurns: [
        {
          id: "turn-1",
          ordinal: 1,
          status: "completed",
          startedAt: utc(0),
          completedAt: utc(6_000),
          model: "claude-opus-4-6",
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 10_000,
            cachedInputTokens: 9_200,
            cacheCreationTokens: 300,
            outputTokens: 250,
            reasoningTokens: 50,
            hasSubagents: false,
          },
          tokenUsage: {
            usedTokens: 10_250,
            maxTokens: 200_000,
            updatedAt: new Date(BASE_MS + 6_000).toISOString(),
          },
        },
      ],
      turnItems: [
        {
          id: "item-1",
          type: "assistant_message",
          runId: "run-1",
          providerTurnId: "turn-1",
          status: "completed",
          startedAt: utc(1_000),
          completedAt: utc(6_000),
          updatedAt: utc(6_000),
          streaming: false,
          text: "hello",
        },
      ],
    });

    const summary = computeThreadObservability({
      projection,
      nowMs: BASE_MS + 10_000,
      config: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    });

    expect(summary.hasTurns).toBe(true);
    expect(summary.isLiveRunning).toBe(false);
    expect(summary.headlineTurn?.ttftMs).toBe(1_000);
    expect(summary.headlineTurn?.totalDurationMs).toBe(6_000);
    // 250 output tokens over 5.0s streaming window (6000 - 1000) = 50.0 tok/s
    expect(summary.headlineTurn?.tpsStatus).toBe("measured");
    expect(summary.headlineTurn?.effectiveTps).toBe(50);
    // Provider inputTokens (10_000) already includes cachedInputTokens (9_200) -> 92%
    expect(summary.headlineTurn?.cacheStatus).toBe("measured");
    expect(summary.headlineTurn?.cacheHitPct).toBe(92);
    expect(summary.headlineTurn?.uncachedInputTokens).toBe(500);
    expect(summary.headlineTurn?.targetMet).toBe(true);
    expect(summary.steadyStateCacheStatus).toBe("measured");
    expect(summary.steadyStateCacheHitPct).toBe(92);
    expect(summary.contextUsedPct).toBe(5);
    expect(summary.watchdog.level).toBe("idle");
  });

  it("never fabricates cache hit or TPS on opaque and native-only tracks", () => {
    const projection = makeProjection({
      runs: [
        { id: "run-1", status: "completed", startedAt: utc(0), completedAt: utc(3_000) },
        { id: "run-2", status: "completed", startedAt: utc(4_000), completedAt: utc(8_000) },
      ],
      providerTurns: [
        {
          id: "turn-1",
          ordinal: 1,
          status: "completed",
          startedAt: utc(0),
          completedAt: utc(3_000),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "unavailable",
            hasSubagents: false,
          },
        },
        {
          id: "turn-2",
          ordinal: 2,
          status: "completed",
          startedAt: utc(4_000),
          completedAt: utc(8_000),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 4_000,
            outputTokens: 200,
            hasSubagents: false,
          },
        },
      ],
    });

    const summary = computeThreadObservability({
      projection,
      nowMs: BASE_MS + 10_000,
      config: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    });

    const turn2 = summary.turns[0];
    const turn1 = summary.turns[1];
    expect(turn1?.cacheStatus).toBe("opaque");
    expect(turn1?.cacheHitPct).toBeNull();
    expect(turn1?.tpsStatus).toBe("unavailable");
    expect(turn1?.effectiveTps).toBeNull();

    expect(turn2?.cacheStatus).toBe("native");
    expect(turn2?.cacheHitPct).toBeNull();
    expect(turn2?.effectiveTps).toBe(50);
    expect(summary.steadyStateCacheStatus).toBe("native");
    expect(summary.steadyStateCacheHitPct).toBeNull();
  });

  it("triggers gentle Watchdog warn and critical states and suppresses false alarms while waiting for user", () => {
    const runningProjection = makeProjection({
      runs: [{ id: "run-1", status: "running", startedAt: utc(0), completedAt: null }],
      providerTurns: [
        { id: "turn-1", ordinal: 1, status: "running", startedAt: utc(0), completedAt: null },
      ],
      turnItems: [],
    });

    const healthy = computeThreadObservability({
      projection: runningProjection,
      nowMs: BASE_MS + 20_000,
      config: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    });
    expect(healthy.watchdog.level).toBe("healthy");
    expect(healthy.watchdog.phase).toBe("awaiting-first-token");
    expect(healthy.headlineTurn?.ttftPending).toBe(true);
    expect(healthy.headlineTurn?.ttftMs).toBe(20_000);

    const warn = computeThreadObservability({
      projection: runningProjection,
      nowMs: BASE_MS + 50_000,
      config: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    });
    expect(warn.watchdog.level).toBe("warn");
    expect(warn.watchdog.stallKey).toBe(`run-1:${BASE_MS}`);

    const critical = computeThreadObservability({
      projection: runningProjection,
      nowMs: BASE_MS + 130_000,
      config: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    });
    expect(critical.watchdog.level).toBe("critical");

    const waitingUserProjection = makeProjection({
      runs: [{ id: "run-1", status: "running", startedAt: utc(0), completedAt: null }],
      providerTurns: [
        { id: "turn-1", ordinal: 1, status: "running", startedAt: utc(0), completedAt: null },
      ],
      runtimeRequests: [{ status: "pending" }],
    });
    const suppressed = computeThreadObservability({
      projection: waitingUserProjection,
      nowMs: BASE_MS + 200_000,
      config: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    });
    expect(suppressed.watchdog.level).toBe("healthy");
    expect(suppressed.watchdog.phase).toBe("waiting-user");
  });

  it("formats compact durations and token counts cleanly", () => {
    expect(formatCompactDurationMs(null)).toBe("-");
    expect(formatCompactDurationMs(420)).toBe("420ms");
    expect(formatCompactDurationMs(1_460)).toBe("1.5s");
    expect(formatCompactDurationMs(128_000)).toBe("2m 08s");
    expect(formatCompactTokens(null)).toBe("-");
    expect(formatCompactTokens(842)).toBe("842");
    expect(formatCompactTokens(12_400)).toBe("12.4k");
    expect(formatCompactTokens(1_250_000)).toBe("1.25M");
  });
});

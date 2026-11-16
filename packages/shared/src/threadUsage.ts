import type { OrchestrationV2ThreadProjection, RunId, UsageSessionScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type Interval = readonly [number, number];
export function intervalDuration(intervals: readonly Interval[]): number {
  let end = -Infinity;
  let total = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue;
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

export function threadUsageScope(
  projection: {
    readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "id" | "createdAt">;
    readonly runs: readonly Pick<
      OrchestrationV2ThreadProjection["runs"][number],
      "id" | "workStartedAt" | "startedAt" | "completedAt"
    >[];
    readonly attempts: readonly Pick<
      OrchestrationV2ThreadProjection["attempts"][number],
      "id" | "runId"
    >[];
    readonly providerTurns: readonly Pick<
      OrchestrationV2ThreadProjection["providerTurns"][number],
      "providerThreadId" | "runAttemptId" | "startedAt" | "completedAt" | "turnTokenUsage"
    >[];
    readonly providerThreads: readonly Pick<
      OrchestrationV2ThreadProjection["providerThreads"][number],
      "id" | "nativeThreadRef" | "appThreadId" | "driver"
    >[];
    readonly nodes: readonly Pick<
      OrchestrationV2ThreadProjection["nodes"][number],
      "id" | "runId" | "kind" | "startedAt" | "completedAt" | "status"
    >[];
    readonly runtimeRequests: readonly Pick<
      OrchestrationV2ThreadProjection["runtimeRequests"][number],
      "nodeId" | "createdAt" | "resolvedAt"
    >[];
  },
  runId: RunId | null,
  now: number,
) {
  const runs = projection.runs.filter((run) => runId === null || run.id === runId);
  const runIds = new Set(runs.map((run) => run.id));
  const attempts = new Set(
    projection.attempts.filter((attempt) => runIds.has(attempt.runId)).map((attempt) => attempt.id),
  );
  const turns = projection.providerTurns.filter(
    (turn) => turn.runAttemptId !== null && attempts.has(turn.runAttemptId),
  );
  const scopes: UsageSessionScope[] = [];
  for (const providerThread of projection.providerThreads) {
    const sessionId = providerThread.nativeThreadRef?.nativeId;
    if (!sessionId || providerThread.appThreadId !== projection.thread.id) continue;
    for (const turn of turns) {
      if (turn.providerThreadId !== providerThread.id || !turn.startedAt) continue;
      scopes.push({
        provider: providerThread.driver === "claudeAgent" ? "claude" : providerThread.driver,
        sessionId,
        since: Math.max(
          DateTime.toEpochMillis(turn.startedAt),
          DateTime.toEpochMillis(projection.thread.createdAt),
        ),
        until: turn.completedAt ? DateTime.toEpochMillis(turn.completedAt) : now,
      });
    }
  }
  const intervals: Interval[] = [];
  const active: Interval[] = [];
  const nodeRuns = new Map(projection.nodes.map((node) => [node.id, node.runId]));
  for (const run of runs) {
    const startedAt = run.workStartedAt ?? run.startedAt;
    if (!startedAt) continue;
    const start = DateTime.toEpochMillis(startedAt);
    const end = run.completedAt ? DateTime.toEpochMillis(run.completedAt) : now;
    intervals.push([start, end]);
    const waits = projection.runtimeRequests
      .filter((request) => nodeRuns.get(request.nodeId) === run.id)
      .map(
        (request) =>
          [
            Math.max(start, DateTime.toEpochMillis(request.createdAt)),
            Math.min(end, request.resolvedAt ? DateTime.toEpochMillis(request.resolvedAt) : now),
          ] as const,
      )
      .filter(([from, to]) => to > from)
      .sort((a, b) => a[0] - b[0]);
    let cursor = start;
    for (const [from, to] of waits) {
      if (from > cursor) active.push([cursor, from]);
      cursor = Math.max(cursor, to);
    }
    if (cursor < end) active.push([cursor, end]);
  }
  const reasoning: Interval[] = projection.nodes.flatMap((node) => {
    if (node.kind !== "reasoning" || !node.runId || !runIds.has(node.runId) || !node.startedAt)
      return [];
    if (!node.completedAt && node.status !== "running") return [];
    return [
      [
        DateTime.toEpochMillis(node.startedAt),
        node.completedAt ? DateTime.toEpochMillis(node.completedAt) : now,
      ] as const,
    ];
  });
  const knownTurns = turns.filter(
    (turn) => turn.turnTokenUsage && turn.turnTokenUsage.usageStatus !== "unavailable",
  );
  return {
    scopes,
    turns,
    runtimeMs: intervalDuration(active),
    waitingMs: Math.max(0, intervalDuration(intervals) - intervalDuration(active)),
    reasoningMs: reasoning.length ? intervalDuration(reasoning) : null,
    tokens: knownTurns.reduce(
      (sum, turn) =>
        sum + (turn.turnTokenUsage?.inputTokens ?? 0) + (turn.turnTokenUsage?.outputTokens ?? 0),
      0,
    ),
    hasUsage: knownTurns.length > 0,
    incomplete:
      knownTurns.length < turns.length ||
      knownTurns.some((turn) => turn.turnTokenUsage?.usageStatus !== "complete"),
  };
}

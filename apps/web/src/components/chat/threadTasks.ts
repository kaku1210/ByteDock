import type { OrchestrationV2PlanStep, OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";

export interface TaskTimelineItem {
  readonly id: string;
  readonly runId: RunId | null;
  readonly providerThreadId: string | null;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly at: number;
  readonly steps?: ReadonlyArray<OrchestrationV2PlanStep>;
}

export interface ThreadTask {
  readonly stepId: string;
  readonly key: string;
  readonly runId: RunId | null;
  readonly text: string;
  readonly status: OrchestrationV2PlanStep["status"];
  readonly sourceId: string;
  readonly executionId: string | null;
}

const executionTypes = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

export function deriveThreadTasks(items: ReadonlyArray<TaskTimelineItem>): ThreadTask[] {
  const groups = new Map<string, TaskTimelineItem[]>();
  const executions = new Map<string, TaskTimelineItem[]>();
  for (const item of items) {
    const key = JSON.stringify([item.runId ?? item.id, item.providerThreadId]);
    if (item.runId !== null && executionTypes.has(item.type)) {
      const records = executions.get(key) ?? [];
      records.push(item);
      executions.set(key, records);
    }
    if (!item.steps) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const tasks: ThreadTask[] = [];
  for (const [groupKey, snapshots] of [...groups].reverse()) {
    const latest = snapshots.at(-1)!;
    for (const step of latest.steps ?? []) {
      // Positional provider IDs must not inherit another task's source after a replacement.
      const matching: TaskTimelineItem[] = [];
      for (const snapshot of snapshots) {
        const candidate = snapshot.steps?.find((entry) => entry.id === step.id);
        if (!candidate || candidate.text !== step.text) matching.length = 0;
        else matching.push(snapshot);
      }
      const source = matching[0] ?? latest;
      let executionId: string | null = null;
      for (const snapshot of matching) {
        if (step.status === "pending") break;
        const running = snapshot.steps?.filter((entry) => entry.status === "running") ?? [];
        if (running.length !== 1 || running[0]?.id !== step.id) continue;
        const next = snapshots[snapshots.indexOf(snapshot) + 1];
        const since = running[0].durationAnchorAt;
        const start = since ? Date.parse(since) : snapshot.at;
        const candidate = executions
          .get(groupKey)
          ?.findLast(
            (item) => item.at >= start && (next ? item.at < next.at : step.status === "running"),
          );
        executionId = candidate?.id ?? executionId;
      }
      tasks.push({
        stepId: step.id,
        key: JSON.stringify([groupKey, step.id, step.text]),
        runId: latest.runId,
        text: step.text,
        status: step.status,
        sourceId: source.id,
        executionId,
      });
    }
  }
  return tasks;
}

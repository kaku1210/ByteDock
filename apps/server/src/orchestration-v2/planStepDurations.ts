import type { OrchestrationV2PlanArtifact, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

export function findLatestTodoListPlan(projection: {
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
}): TodoListPlan | undefined {
  const ordinalByPlanId = new Map<string, number>();
  for (const item of projection.turnItems ?? []) {
    if (item.type !== "todo_list") continue;
    const key = String(item.planId);
    const current = ordinalByPlanId.get(key);
    if (current === undefined || item.ordinal >= current) {
      ordinalByPlanId.set(key, item.ordinal);
    }
  }
  let latest: TodoListPlan | undefined;
  let latestOrdinal = -1;
  for (const plan of projection.plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded") continue;
    const ordinal = ordinalByPlanId.get(String(plan.id)) ?? -1;
    if (latest === undefined || ordinal >= latestOrdinal) {
      latest = plan;
      latestOrdinal = ordinal;
    }
  }
  return latest;
}

export function withPlanStepDurations(
  plan: TodoListPlan,
  previous: TodoListPlan | undefined,
  occurredAt: DateTime.Utc,
): TodoListPlan {
  const occurredAtIso = DateTime.formatIso(occurredAt);
  const occurredAtMs = DateTime.toEpochMillis(occurredAt);
  const previousById = new Map(previous?.steps.map((step) => [step.id, step]));
  // Provider step IDs may be positional. Changed text must not inherit another task's timing.
  const previousStep = (step: TodoListPlan["steps"][number]) => {
    const prior = previousById.get(step.id);
    return prior?.text === step.text ? prior : undefined;
  };
  const hasNewCompletion = plan.steps.some((step) => {
    const prior = previousStep(step);
    return step.status === "completed" && prior?.status !== "completed";
  });
  let fallbackCompletionConsumed = false;

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const prior = previousStep(step);
      const baseStep = { id: step.id, text: step.text, status: step.status };
      if (step.status === "completed") {
        if (prior?.status === "completed") {
          return {
            ...baseStep,
            ...(prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
          };
        }
        const durationAnchorAt =
          prior?.status === "running" || !fallbackCompletionConsumed
            ? prior?.durationAnchorAt
            : occurredAtIso;
        fallbackCompletionConsumed = true;
        const anchorMs =
          durationAnchorAt === undefined ? occurredAtMs : Date.parse(durationAnchorAt);
        const durationMs = Number.isFinite(anchorMs) ? Math.max(0, occurredAtMs - anchorMs) : 0;
        return {
          ...baseStep,
          ...(durationMs > 0 ? { durationMs } : {}),
        };
      }
      if (step.status === "running") {
        return {
          ...baseStep,
          durationAnchorAt:
            prior?.status === "running" ? (prior.durationAnchorAt ?? occurredAtIso) : occurredAtIso,
        };
      }
      return {
        ...baseStep,
        durationAnchorAt:
          hasNewCompletion || prior?.status !== "pending"
            ? occurredAtIso
            : (prior.durationAnchorAt ?? occurredAtIso),
      };
    }),
  };
}

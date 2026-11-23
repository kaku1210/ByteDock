import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { topOfPinnedRunOrderKey } from "@t3tools/shared/pinOrderKey";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { findLatestTodoListPlan } from "../../../orchestration-v2/planStepDurations.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

/**
 * Places an agent pin at the top of the Pinned section, as a client pin is placed.
 * Without a key the sidebar sorts the pin below every keyed pin. Ordering is
 * best effort: if the index cannot be read, the pin still lands, keyless.
 */
const topOfPinnedRunKey = Effect.fn("mcp.topOfPinnedRunKey")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "listActiveShellIndex">,
) {
  const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => null));
  if (index === null) return undefined;
  const pinnedKeys = index.flatMap((entry) => (entry.pinnedAt == null ? [] : [entry.pinOrderKey]));
  return topOfPinnedRunOrderKey(pinnedKeys) ?? undefined;
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

const MAX_TASK_LIST_STEPS = 200;

function allocateTaskStepId(usedIds: Set<string>): string {
  let index = 1;
  while (usedIds.has(`task-${index}`)) {
    index += 1;
  }
  const nextId = `task-${index}`;
  usedIds.add(nextId);
  return nextId;
}

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        taskId: task.id,
        threadId,
        ...(threadId === null
          ? {}
          : {
              link: McpInvocationContext.threadLinkFor(scope, threadId),
            }),
        lastRunStatus: task.lastRunStatus,
        lastRunError: task.lastRunError,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({ ...input, projectId: input.projectId ?? caller?.projectId })
        .pipe(Effect.mapError(unavailable));
      return {
        currentThreadId: scope.thread?.threadId ?? null,
        matches: matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId, match.title),
        })),
      };
    }),
  ),
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_thread_configure: McpToolAccess.either(
    (input) => input.modelSelection === undefined,
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const {
          projection: { thread },
        } = yield* readThread(input.threadId);
        return {
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const modelSelection = yield* required(input.modelSelection, "modelSelection");
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        const type = modelSelectionCommandType(thread.providerInstanceId, modelSelection);
        const result = yield* threads
          .dispatch({ type, threadId: thread.id, commandId: yield* newCommandId(), modelSelection })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_pending_request: McpToolAccess.either(
    (input) => input.action !== "respond",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.action === "list") {
          const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
          return {
            requestIds: projection.runtimeRequests
              .filter((request) => request.kind === "user_input" && request.status === "pending")
              .map((request) => request.id),
          };
        }
        const requestId = yield* required(input.requestId, "requestId");
        const { item } = yield* readQuestion({ threadId: input.threadId, requestId });
        return { requestId, questions: item.questions };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const requestId = yield* required(input.requestId, "requestId");
        const answers = yield* required(input.answers, "answers");
        const { threads, projection } = yield* readQuestion({
          threadId: input.threadId,
          requestId,
        });
        const result = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: projection.thread.id,
            commandId: yield* newCommandId(),
            requestId,
            answers,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_submit_output: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      if (scope.thread === undefined) return yield* unavailable();
      return yield* threads
        .submitRunOutput({
          threadId: scope.thread.threadId,
          commandId: yield* newCommandId(),
          json: input.json,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementRunOutputRejectedError"
              ? new OrchestratorMcpFailure({
                  code: "invalid_request",
                  // The agent wrote the value, so it is told what in it did not fit.
                  message:
                    error.cause instanceof Error
                      ? `${error.message}\n${error.cause.message.slice(0, 2000)}`
                      : error.message,
                })
              : unavailable(),
          ),
        );
    }),
  ),
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { threads, projection: queued } = yield* readThread(input.threadId, ["runs"], {
          runStatuses: ["queued"],
        });
        const messages = yield* threads
          .getMessagesById(
            queued.thread.id,
            queued.runs.map((run) => run.userMessageId),
          )
          .pipe(Effect.mapError(unavailable));
        const projection = { runs: queued.runs, messages: [...messages.values()] };
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        return (
          queueEntry(projection, queuedRunId, 16000) ??
          (yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          }))
        );
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            const { threads, projection } = yield* readThread(input.threadId);
            // An agent must not turn a person's queued message into a provider sign-out.
            const command = yield* ThreadMessageIntake.withQueuedAttachmentsOnSignOutText({
              type: "queued-run.edit",
              commandId: yield* newCommandId(),
              threadId: projection.thread.id,
              runId,
              text,
            }).pipe(
              Effect.mapError((error) =>
                error._tag === "EnvironmentAuthorizationError"
                  ? new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: "A queued message cannot be edited into a provider sign-out.",
                    })
                  : dispatchFailure(error),
              ),
            );
            const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence };
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "pin": {
          // Always send a key, as the client does: the reducer ignores it for a
          // thread that is already pinned, and a projection read before this
          // command can be stale if an unpin commits in between.
          const orderKey = yield* topOfPinnedRunKey(threads);
          command = { ...common, type: "thread.pin", ...(orderKey ? { orderKey } : {}) };
          break;
        }
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_task_list: McpToolAccess.either(
    (input) => input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["plans", "turnItems"]);
        const current = findLatestTodoListPlan(projection);
        if (current === undefined) {
          return {
            planId: null,
            runId: null,
            status: null,
            steps: [],
          };
        }
        return {
          planId: current.id,
          runId: current.runId,
          status: current.status,
          ...(current.explanation === undefined ? {} : { explanation: current.explanation }),
          steps: current.steps,
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const { threads, projection } = yield* readThread(input.threadId, ["plans", "turnItems"]);
        const current = findLatestTodoListPlan(projection);
        const currentSteps = current?.steps ?? [];
        type StepDraft = {
          readonly id: string;
          readonly text: string;
          readonly status: OrchestrationV2PlanStep["status"];
        };
        let nextSteps: Array<StepDraft> = [];

        switch (input.action) {
          case "read":
          case "clear": {
            nextSteps = [];
            break;
          }
          case "replace": {
            const steps = yield* required(input.steps, "steps");
            if (steps.length === 0) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "`replace` requires at least one step; use `clear` to empty the task list.",
              });
            }
            const usedIds = new Set<string>();
            for (const step of steps) {
              if (step.id !== undefined) {
                if (usedIds.has(step.id)) {
                  return yield* new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: `Duplicate task step id \`${step.id}\`.`,
                  });
                }
                usedIds.add(step.id);
              }
            }
            nextSteps = [];
            for (const step of steps) {
              if (step.text === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Each task step in `replace` needs `text`.",
                });
              }
              nextSteps.push({
                id: step.id ?? allocateTaskStepId(usedIds),
                text: step.text,
                status: step.status ?? "pending",
              });
            }
            break;
          }
          case "add": {
            const steps = yield* required(input.steps, "steps");
            if (steps.length === 0) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "`add` requires at least one step.",
              });
            }
            if (currentSteps.length + steps.length > MAX_TASK_LIST_STEPS) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Task list cannot exceed ${MAX_TASK_LIST_STEPS} steps.`,
              });
            }
            const usedIds = new Set(currentSteps.map((step) => step.id));
            for (const step of steps) {
              if (step.id !== undefined) {
                if (usedIds.has(step.id)) {
                  return yield* new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: `Task step id \`${step.id}\` already exists.`,
                  });
                }
                usedIds.add(step.id);
              }
            }
            const addedSteps: Array<StepDraft> = [];
            for (const step of steps) {
              if (step.text === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Each task step in `add` needs `text`.",
                });
              }
              addedSteps.push({
                id: step.id ?? allocateTaskStepId(usedIds),
                text: step.text,
                status: step.status ?? "pending",
              });
            }
            nextSteps = [
              ...currentSteps.map((step) => ({
                id: step.id,
                text: step.text,
                status: step.status,
              })),
              ...addedSteps,
            ];
            break;
          }
          case "update": {
            const steps = yield* required(input.steps, "steps");
            if (steps.length === 0) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "`update` requires at least one step.",
              });
            }
            if (currentSteps.length === 0) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "There are no current tasks to update. Use `add` or `replace` first.",
              });
            }
            const existingIds = new Set(currentSteps.map((step) => step.id));
            const patchesById = new Map<
              string,
              { text?: string; status?: OrchestrationV2PlanStep["status"] }
            >();
            for (const step of steps) {
              if (step.id === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Each task step in `update` needs `id`.",
                });
              }
              if (step.text === undefined && step.status === undefined) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Task step \`${step.id}\` needs \`status\` or \`text\` to update.`,
                });
              }
              if (!existingIds.has(step.id)) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Task step \`${step.id}\` was not found in the current task list.`,
                });
              }
              const prior = patchesById.get(step.id);
              patchesById.set(step.id, {
                ...prior,
                ...(step.text === undefined ? {} : { text: step.text }),
                ...(step.status === undefined ? {} : { status: step.status }),
              });
            }
            nextSteps = currentSteps.map((step) => {
              const patch = patchesById.get(step.id);
              return {
                id: step.id,
                text: patch?.text ?? step.text,
                status: patch?.status ?? step.status,
              };
            });
            break;
          }
        }

        const explanation =
          input.explanation !== undefined
            ? input.explanation
            : input.action === "add" || input.action === "update"
              ? current?.explanation
              : undefined;

        return yield* threads
          .updateTodoList({
            threadId: projection.thread.id,
            commandId: yield* newCommandId(),
            steps: nextSteps,
            ...(explanation === undefined ? {} : { explanation }),
          })
          .pipe(Effect.mapError(dispatchFailure));
      }),
    ),
  ),
});

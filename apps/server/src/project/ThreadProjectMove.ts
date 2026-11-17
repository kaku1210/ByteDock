import {
  EventId,
  type ProjectMoveThreadToScratchInput,
  type ProjectMoveThreadToScratchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Owns explicit thread reclassification; it never moves files or starts a provider. */
export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Move a stopped thread to the server's canonical No project, retaining its cwd and
     * all lifecycle fields. Reject stale source projects and unfinished work. Repeating
     * a completed move is a no-op, including when the original expected project is given.
     */
    readonly moveToScratch: (
      input: ProjectMoveThreadToScratchInput,
    ) => Effect.Effect<ProjectMoveThreadToScratchResult, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* Orchestrator.OrchestratorV2;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sink = yield* EventSink.EventSinkV2;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const moveToScratch: ThreadProjectMove["Service"]["moveToScratch"] = Effect.fn(
    "ThreadProjectMove.moveToScratch",
  )((input) =>
    commands.withLock(
      input.threadId,
      Effect.gen(function* () {
        const records = yield* threads
          .getThreadRecords(input.threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
          .pipe(Effect.mapError(fail("Could not read the thread.")));
        const thread = records.thread;
        if (thread.deletedAt !== null) {
          return yield* new ThreadProjectMoveError({ reason: "The thread is deleted." });
        }
        const source = Option.getOrUndefined(
          yield* projects
            .getById(thread.projectId)
            .pipe(Effect.mapError(fail("Could not read the project."))),
        );
        if (source === undefined || source.deletedAt !== null) {
          return yield* new ThreadProjectMoveError({ reason: "The thread's project is missing." });
        }
        const worktreePath = thread.worktreePath ?? source.workspaceRoot;
        if (yield* folders.isScratchProject(thread.projectId)) {
          return { threadId: thread.id, projectId: thread.projectId, worktreePath };
        }
        if (thread.projectId !== input.expectedProjectId) {
          return yield* new ThreadProjectMoveError({
            reason: "The thread's project changed. Read it again before moving.",
          });
        }
        if (thread.lineage.relationshipToParent === "subagent") {
          return yield* new ThreadProjectMoveError({
            reason: "A subagent must stay with its parent project.",
          });
        }
        if (Orchestrator.threadHasUnfinishedWork(records)) {
          return yield* new ThreadProjectMoveError({
            reason: "The thread still has work in progress. Finish or stop it first.",
          });
        }
        const { projectId } = yield* folders.ensureScratchProject.pipe(
          Effect.mapError(fail("Could not prepare No project.")),
        );
        const occurredAt = yield* DateTime.now;
        const eventId = EventId.make(`thread-project-move:${yield* random.uuidV4()}`);
        // Share the event sink's transaction/publication boundary with bound schedules.
        // The thread dispatch lock prevents a new run or full-row update during this commit.
        yield* sink
          .withProviderBatch(
            tasks.moveThreadTasks({ threadIds: [thread.id], projectId }).pipe(
              Effect.andThen(
                sink.write({
                  events: [
                    {
                      id: eventId,
                      type: "thread.metadata-updated",
                      threadId: thread.id,
                      providerInstanceId: thread.providerInstanceId,
                      occurredAt,
                      // Reclassification is not chat activity: retain dates, bindings and state.
                      payload: { ...thread, projectId, worktreePath },
                    },
                  ],
                }),
              ),
            ),
          )
          .pipe(Effect.mapError(fail("Could not move the thread to No project.")));
        return { threadId: thread.id, projectId, worktreePath };
      }),
    ),
  );

  return ThreadProjectMove.of({ moveToScratch });
});

export const layer = Layer.effect(ThreadProjectMove, make);

import {
  CommandId,
  EventId,
  type ProjectMoveThreadToProjectInput,
  type ProjectMoveThreadToProjectResult,
  type ProjectMoveThreadToScratchInput,
  type ProjectMoveThreadToScratchResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
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

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as {
    readonly code?: unknown;
    readonly systemError?: { readonly code?: unknown };
    readonly cause?: unknown;
  };
  if (typeof record.code === "string") return record.code;
  if (typeof record.systemError?.code === "string") return record.systemError.code;
  if (record.cause !== undefined && record.cause !== error) return getErrorCode(record.cause);
  return undefined;
}

function shouldFallbackToCopy(error: unknown): boolean {
  const code = getErrorCode(error);
  // EXDEV: cross-device rename (e.g. C:\ -> D:\ on Windows)
  // EBUSY/EPERM/EACCES: open directory handle held by an idle provider or terminal
  return code === "EXDEV" || code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function dispatchFailureReason(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  if (typeof squashed === "object" && squashed !== null && "cause" in squashed) {
    const inner = (squashed as { readonly cause?: unknown }).cause;
    if (typeof inner === "string" && inner.trim().length > 0) {
      return inner;
    }
    if (inner instanceof Error && inner.message.trim().length > 0) {
      return inner.message;
    }
  }
  if (squashed instanceof Error && squashed.message.trim().length > 0) {
    return squashed.message;
  }
  return "Could not move the thread into the target project.";
}

/** Owns explicit thread reclassification between No project and regular projects. */
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
    /**
     * Move a stopped No project thread and its dedicated scratch folder into an existing
     * regular project, detaching live provider sessions so the next turn hands off context
     * into a fresh session in the target project's working directory.
     */
    readonly moveToProject: (
      input: ProjectMoveThreadToProjectInput,
    ) => Effect.Effect<ProjectMoveThreadToProjectResult, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* Orchestrator.OrchestratorV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sink = yield* EventSink.EventSinkV2;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const normalizeForCompare = (value: string) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const isSameOrNestedPath = (candidate: string, parent: string) => {
    const normCandidate = normalizeForCompare(candidate);
    const normParent = normalizeForCompare(parent);
    if (normCandidate === normParent) return true;
    const rel = path.relative(normParent, normCandidate);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  const resolveDestinationFolder = Effect.fn("ThreadProjectMove.resolveDestinationFolder")(
    function* (sourceFolder: string, targetWorkspaceRoot: string) {
      const baseName = path.basename(sourceFolder);
      for (let attempt = 1; attempt <= 999; attempt++) {
        const name = attempt === 1 ? baseName : `${baseName}-${attempt}`;
        const candidate = path.join(targetWorkspaceRoot, name);
        const exists = yield* fileSystem
          .exists(candidate)
          .pipe(Effect.mapError(fail("Could not inspect the target project directory.")));
        if (!exists) return candidate;
      }
      return yield* new ThreadProjectMoveError({
        reason: `A folder named "${baseName}" already exists in the target project.`,
      });
    },
  );

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

  const moveToProject: ThreadProjectMove["Service"]["moveToProject"] = Effect.fn(
    "ThreadProjectMove.moveToProject",
  )(function* (input) {
    // 1. Pre-flight: read thread state (do not hold ThreadCommandExecutor lock across threads.dispatch).
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
      .pipe(Effect.mapError(fail("Could not read the thread.")));
    const thread = records.thread;
    if (thread.deletedAt !== null) {
      return yield* new ThreadProjectMoveError({ reason: "The thread is deleted." });
    }
    if (thread.projectId !== input.expectedProjectId) {
      return yield* new ThreadProjectMoveError({
        reason: "The thread's project changed. Read it again before moving.",
      });
    }
    if (!(yield* folders.isScratchProject(thread.projectId))) {
      return yield* new ThreadProjectMoveError({
        reason: "Only a No project thread can be moved into an existing project.",
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

    // 2. Validate target project.
    const targetProject = Option.getOrUndefined(
      yield* projects
        .getById(input.targetProjectId)
        .pipe(Effect.mapError(fail("Could not read the target project."))),
    );
    if (targetProject === undefined || targetProject.deletedAt !== null) {
      return yield* new ThreadProjectMoveError({ reason: "The target project was not found." });
    }
    if (targetProject.archivedAt !== null && targetProject.archivedAt !== undefined) {
      return yield* new ThreadProjectMoveError({
        reason: "The target project is archived. Unarchive it first.",
      });
    }
    if (yield* folders.isScratchProject(targetProject.id)) {
      return yield* new ThreadProjectMoveError({
        reason: "Choose a regular project as the destination.",
      });
    }
    const targetStat = yield* fileSystem
      .stat(targetProject.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => null));
    if (targetStat === null || targetStat.type !== "Directory") {
      return yield* new ThreadProjectMoveError({
        reason: "The target project folder does not exist on disk.",
      });
    }

    // 3. Validate source folder is a direct child of scratchRoot.
    const scratchRoot = Option.getOrUndefined(yield* folders.scratchRoot);
    const sourceFolder = thread.worktreePath;
    if (sourceFolder === null || scratchRoot === undefined) {
      return yield* new ThreadProjectMoveError({
        reason: "Only a No project thread with its own scratch folder can be moved into a project.",
      });
    }
    const realScratchRoot = yield* fileSystem
      .realPath(scratchRoot)
      .pipe(Effect.orElseSucceed(() => scratchRoot));
    const realSourceParent = yield* fileSystem
      .realPath(path.dirname(sourceFolder))
      .pipe(Effect.orElseSucceed(() => path.dirname(sourceFolder)));
    if (normalizeForCompare(realSourceParent) !== normalizeForCompare(realScratchRoot)) {
      return yield* new ThreadProjectMoveError({
        reason:
          "This thread does not use a dedicated No project folder (for example, it was imported or moved from another project) and cannot be moved into a project.",
      });
    }
    const sourceStat = yield* fileSystem.stat(sourceFolder).pipe(Effect.orElseSucceed(() => null));
    if (sourceStat === null || sourceStat.type !== "Directory") {
      return yield* new ThreadProjectMoveError({
        reason: "The thread's scratch folder no longer exists on disk.",
      });
    }

    // 4. Reject if another non-deleted thread shares this scratch folder.
    const sharedSnapshot = yield* Effect.flatten(
      threadManagement.readShellSnapshot({ worktreePath: sourceFolder }),
    ).pipe(Effect.mapError(fail("Could not inspect other threads in this folder.")));
    const otherThreads = [...sharedSnapshot.threads, ...sharedSnapshot.archivedThreads].filter(
      (candidate) => candidate.id !== thread.id,
    );
    if (otherThreads.length > 0) {
      return yield* new ThreadProjectMoveError({
        reason: "Another thread shares this scratch folder. Move or archive it separately first.",
      });
    }

    // 5. Reject if this scratch folder (or a nested subfolder) is registered as a project.
    const allProjects = yield* projects
      .listShells()
      .pipe(Effect.mapError(fail("Could not inspect existing projects.")));
    const realSourceFolder = yield* fileSystem
      .realPath(sourceFolder)
      .pipe(Effect.orElseSucceed(() => sourceFolder));
    for (const existing of allProjects) {
      const existingReal = yield* fileSystem
        .realPath(existing.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => existing.workspaceRoot));
      if (isSameOrNestedPath(existingReal, realSourceFolder)) {
        return yield* new ThreadProjectMoveError({
          reason: `Cannot move this scratch folder because project "${existing.title}" is registered inside it.`,
        });
      }
    }

    // 6. Compute unique destination folder and move/copy inside an uninterruptible section.
    const destFolder = yield* resolveDestinationFolder(sourceFolder, targetProject.workspaceRoot);

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const transferMode: "renamed" | "copied" = yield* fileSystem
          .rename(sourceFolder, destFolder)
          .pipe(
            Effect.as("renamed" as const),
            Effect.catchIf(shouldFallbackToCopy, () =>
              fileSystem.copy(sourceFolder, destFolder).pipe(
                Effect.as("copied" as const),
                Effect.tapError(() =>
                  fileSystem
                    .remove(destFolder, { recursive: true, force: true })
                    .pipe(Effect.ignore),
                ),
              ),
            ),
            Effect.mapError(fail("Could not move the scratch folder into the target project.")),
          );

        // 7. Atomically commit Orchestrator state (re-checks inside lock, detaches sessions, cleans terminals, logs notice).
        const commandId = CommandId.make(`thread-project-move:${yield* random.uuidV4()}`);
        const dispatchResult = yield* Effect.exit(
          threads.dispatch({
            type: "thread.project.move",
            commandId,
            threadId: thread.id,
            expectedProjectId: input.expectedProjectId,
            targetProjectId: targetProject.id,
            sourceFolderPath: sourceFolder,
            movedFolderPath: destFolder,
          }),
        );

        if (Exit.isFailure(dispatchResult)) {
          if (transferMode === "renamed") {
            yield* fileSystem.rename(destFolder, sourceFolder).pipe(Effect.ignore);
          } else {
            yield* fileSystem
              .remove(destFolder, { recursive: true, force: true })
              .pipe(Effect.ignore);
          }
          return yield* new ThreadProjectMoveError({
            reason: dispatchFailureReason(dispatchResult.cause),
            cause: dispatchResult.cause,
          });
        }

        // 8. Move scheduled tasks bound to this thread.
        yield* tasks.moveThreadTasks({ threadIds: [thread.id], projectId: targetProject.id }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Moved thread to project, but moving scheduled tasks failed", {
              threadId: thread.id,
              targetProjectId: targetProject.id,
              cause,
            }),
          ),
        );

        // 9. When copied (cross-device or locked handle), retry removing the original scratch folder.
        let cleanupWarning: string | undefined;
        if (transferMode === "copied") {
          const removed = yield* fileSystem
            .remove(sourceFolder, { recursive: true, force: true })
            .pipe(
              Effect.retry({
                times: 6,
                schedule: Schedule.spaced("250 millis"),
              }),
              Effect.as(true),
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Moved scratch folder by copy, but could not remove original folder",
                  { sourceFolder, destFolder, cause },
                ).pipe(Effect.as(false)),
              ),
            );
          if (!removed) {
            cleanupWarning = `Files were copied to "${destFolder}", but the original folder "${sourceFolder}" is still in use by another program and could not be removed automatically.`;
          }
        }

        return {
          threadId: thread.id,
          projectId: targetProject.id,
          workspaceRoot: targetProject.workspaceRoot,
          movedFolderPath: destFolder,
          ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
        } satisfies ProjectMoveThreadToProjectResult;
      }),
    );
  });

  return ThreadProjectMove.of({ moveToScratch, moveToProject });
});

export const layer = Layer.effect(ThreadProjectMove, make);

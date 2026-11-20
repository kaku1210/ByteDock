import {
  isTaskChildLineage,
  MAX_TASK_TREE_DEPTH,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type TaskTreeDepthTarget = Pick<
  OrchestrationV2AppThread,
  "id" | "lineage" | "delegatedFrom" | "deletedAt"
> & {
  readonly archivedAt?: OrchestrationV2AppThread["archivedAt"];
};

export class TaskTreeDepthError extends Schema.TaggedError<TaskTreeDepthError>()(
  "TaskTreeDepthError",
  {
    parentThreadId: Schema.String,
    reason: Schema.Literals([
      "missing_parent",
      "deleted_parent",
      "side_chat_parent",
      "cycle",
      "max_depth_exceeded",
      "unverifiable_remote_ancestor",
    ]),
    depth: Schema.optional(Schema.Number),
    message: Schema.String,
  },
) {}

export interface ResolvedTaskChildPlacement {
  readonly parentDepth: number;
  readonly childDepth: number;
  readonly rootThreadId: ThreadId;
}

/**
 * Validates that a new task child (subtask or subagent) can be created under `parentThreadId`.
 * Depth is computed strictly along task-child edges (`subagent` / `subtask`), capping children at L2
 * (`MAX_TASK_TREE_DEPTH = 2`).
 */
export const validateTaskChildPlacement = Effect.fn("TaskTreeDepth.validateTaskChildPlacement")(
  function* <E>(input: {
    readonly parentThreadId: ThreadId;
    readonly loadThread: (threadId: ThreadId) => Effect.Effect<TaskTreeDepthTarget | null, E>;
    readonly maxDepth?: number;
  }) {
    const maxDepth = input.maxDepth ?? MAX_TASK_TREE_DEPTH;
    const directParent = yield* input.loadThread(input.parentThreadId);
    if (directParent === null) {
      return yield* new TaskTreeDepthError({
        parentThreadId: input.parentThreadId,
        reason: "missing_parent",
        message: `Parent thread ${input.parentThreadId} was not found.`,
      });
    }
    if (directParent.deletedAt !== null) {
      return yield* new TaskTreeDepthError({
        parentThreadId: input.parentThreadId,
        reason: "deleted_parent",
        message: `Parent thread ${input.parentThreadId} was deleted.`,
      });
    }
    if (directParent.lineage.sideChat === true) {
      return yield* new TaskTreeDepthError({
        parentThreadId: input.parentThreadId,
        reason: "side_chat_parent",
        message: `Side chat ${input.parentThreadId} cannot create child tasks.`,
      });
    }

    const seen = new Set<ThreadId>([directParent.id]);
    let depth = 0;
    let current: TaskTreeDepthTarget = directParent;

    while (true) {
      if (current.delegatedFrom !== undefined) {
        // A thread delegated from a linked environment is already at least L1 on the remote side,
        // and local storage cannot verify whether the remote parent itself is L0 or L1.
        // Allow creating one local child only if we have not already climbed a local task edge;
        // otherwise conservatively reject to guarantee we never exceed L2 across environments.
        if (depth >= 1 || maxDepth < 2) {
          return yield* new TaskTreeDepthError({
            parentThreadId: input.parentThreadId,
            reason: "unverifiable_remote_ancestor",
            depth: depth + 1,
            message: `Cannot create a deeper child under remotely delegated thread ${current.id} without verifying remote ancestor depth.`,
          });
        }
        depth += 1;
        break;
      }

      if (!isTaskChildLineage(current.lineage)) {
        break;
      }

      const nextParentId = current.lineage.parentThreadId;
      if (nextParentId === null) {
        return yield* new TaskTreeDepthError({
          parentThreadId: input.parentThreadId,
          reason: "missing_parent",
          depth,
          message: `Task thread ${current.id} has no parentThreadId.`,
        });
      }
      if (seen.has(nextParentId)) {
        return yield* new TaskTreeDepthError({
          parentThreadId: input.parentThreadId,
          reason: "cycle",
          depth,
          message: `Task lineage cycle detected at thread ${nextParentId}.`,
        });
      }
      seen.add(nextParentId);
      depth += 1;

      const ancestor = yield* input.loadThread(nextParentId);
      if (ancestor === null) {
        return yield* new TaskTreeDepthError({
          parentThreadId: input.parentThreadId,
          reason: "missing_parent",
          depth,
          message: `Ancestor thread ${nextParentId} was not found.`,
        });
      }
      if (ancestor.lineage.sideChat === true) {
        return yield* new TaskTreeDepthError({
          parentThreadId: input.parentThreadId,
          reason: "side_chat_parent",
          depth,
          message: `Ancestor thread ${nextParentId} is a side chat and cannot own child tasks.`,
        });
      }
      current = ancestor;
    }

    const childDepth = depth + 1;
    if (childDepth > maxDepth) {
      return yield* new TaskTreeDepthError({
        parentThreadId: input.parentThreadId,
        reason: "max_depth_exceeded",
        depth: childDepth,
        message: `Task tree depth limit (${maxDepth}) exceeded: cannot create L${childDepth} child under L${depth} thread ${input.parentThreadId}.`,
      });
    }

    return {
      parentDepth: depth,
      childDepth,
      rootThreadId: current.lineage.rootThreadId,
    };
  },
);

/**
 * Resolves the root L0 owner thread for a task tree by climbing only task-child edges
 * (`subtask` / `subagent`). Plain user forks remain independent L0 roots.
 */
export const resolveTaskTreeRootThreadId = Effect.fn("TaskTreeDepth.resolveTaskTreeRootThreadId")(
  function* <E>(input: {
    readonly thread: TaskTreeDepthTarget;
    readonly loadThread: (threadId: ThreadId) => Effect.Effect<TaskTreeDepthTarget | null, E>;
  }) {
    const seen = new Set<ThreadId>([input.thread.id]);
    let current: TaskTreeDepthTarget = input.thread;
    while (isTaskChildLineage(current.lineage) && current.lineage.parentThreadId !== null) {
      const parentId = current.lineage.parentThreadId;
      if (seen.has(parentId)) break;
      seen.add(parentId);
      const parent = yield* input.loadThread(parentId);
      if (parent === null) break;
      current = parent;
    }
    return current.id;
  },
);

export class HorizontalEscalationSourceError extends Schema.TaggedError<HorizontalEscalationSourceError>()(
  "HorizontalEscalationSourceError",
  {
    sourceThreadId: Schema.String,
    rootThreadId: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "invalid_source",
      "root_unreachable",
      "root_deleted",
      "root_archived",
    ]),
    message: Schema.String,
  },
) {}

export interface ResolvedHorizontalEscalation<T extends TaskTreeDepthTarget> {
  readonly sourceThread: T;
  readonly rootThread: T;
}

/**
 * Validates that `sourceThreadId` is an active L1 task child eligible to initiate horizontal
 * escalation to its live, unarchived L0 root thread. Rejects L0, L2+, side chats, remote
 * delegated threads, and unreachable/archived/deleted roots.
 */
export const validateHorizontalEscalationSource = Effect.fn(
  "TaskTreeDepth.validateHorizontalEscalationSource",
)(function* <T extends TaskTreeDepthTarget, E>(input: {
  readonly sourceThreadId: ThreadId;
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<T | null, E>;
}) {
  const sourceThread = yield* input.loadThread(input.sourceThreadId);
  if (sourceThread === null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      reason: "invalid_source",
      message: `Source thread ${input.sourceThreadId} was not found.`,
    });
  }
  if (sourceThread.lineage.sideChat === true) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      reason: "invalid_source",
      message: `Side chat ${input.sourceThreadId} cannot initiate horizontal escalation.`,
    });
  }
  if (sourceThread.delegatedFrom !== undefined) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      reason: "invalid_source",
      message: `Remotely delegated thread ${input.sourceThreadId} cannot initiate local horizontal escalation.`,
    });
  }
  if (!isTaskChildLineage(sourceThread.lineage) || sourceThread.lineage.parentThreadId === null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      reason: "invalid_source",
      message: `Root thread ${input.sourceThreadId} is already at L0; create a subtask or delegate directly instead of escalating.`,
    });
  }

  const parentThreadId = sourceThread.lineage.parentThreadId;
  if (parentThreadId === sourceThread.id) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      reason: "invalid_source",
      message: `Task lineage cycle detected at thread ${sourceThread.id}.`,
    });
  }

  const parentThread = yield* input.loadThread(parentThreadId);
  if (parentThread === null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThreadId,
      reason: "root_unreachable",
      message: `Root thread ${parentThreadId} could not be reached.`,
    });
  }
  if (parentThread.lineage.sideChat === true) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThread.id,
      reason: "invalid_source",
      message: `Parent thread ${parentThread.id} is a side chat and cannot accept horizontal escalation.`,
    });
  }
  // If the direct parent is itself a task child or remotely delegated, source is L2+ -> strictly forbidden.
  if (
    parentThread.delegatedFrom !== undefined ||
    (isTaskChildLineage(parentThread.lineage) && parentThread.lineage.parentThreadId !== null)
  ) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThread.lineage.rootThreadId,
      reason: "invalid_source",
      message: `L2 subtask ${input.sourceThreadId} cannot initiate horizontal escalation to L0.`,
    });
  }
  // Check root deletion/archival before source deletion/archival because root archive/delete
  // cascades down to L1 children, and callers expect explicit root_deleted / root_archived errors.
  if (parentThread.deletedAt !== null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThread.id,
      reason: "root_deleted",
      message: `Root thread ${parentThread.id} was deleted and cannot accept new sibling L1 escalations.`,
    });
  }
  if (parentThread.archivedAt != null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThread.id,
      reason: "root_archived",
      message: `Root thread ${parentThread.id} is archived and cannot accept new sibling L1 escalations.`,
    });
  }
  if (sourceThread.deletedAt !== null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThread.id,
      reason: "invalid_source",
      message: `Source thread ${input.sourceThreadId} was deleted and cannot escalate.`,
    });
  }
  if (sourceThread.archivedAt != null) {
    return yield* new HorizontalEscalationSourceError({
      sourceThreadId: input.sourceThreadId,
      rootThreadId: parentThread.id,
      reason: "invalid_source",
      message: `Source thread ${input.sourceThreadId} is archived and cannot escalate.`,
    });
  }

  return {
    sourceThread,
    rootThread: parentThread,
  } satisfies ResolvedHorizontalEscalation<T>;
});

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
>;

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

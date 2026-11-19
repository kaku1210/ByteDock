import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  type TaskTreeDepthTarget,
  TaskTreeDepthError,
  validateTaskChildPlacement,
} from "./TaskTreeDepth.ts";

const makeNode = (
  id: string,
  lineage: TaskTreeDepthTarget["lineage"],
  extra?: Partial<Pick<TaskTreeDepthTarget, "delegatedFrom" | "deletedAt">>,
): TaskTreeDepthTarget => ({
  id: ThreadId.make(id),
  lineage,
  delegatedFrom: extra?.delegatedFrom,
  deletedAt: extra?.deletedAt ?? null,
});

const loaderOf =
  (nodes: ReadonlyArray<TaskTreeDepthTarget>) =>
  (threadId: ThreadId): Effect.Effect<TaskTreeDepthTarget | null> =>
    Effect.succeed(nodes.find((node) => node.id === threadId) ?? null);

describe("TaskTreeDepth.validateTaskChildPlacement", () => {
  it.effect(
    "allows mixed L0 -> L1 -> L2 trees and rejects L3 across subtask and subagent edges",
    () =>
      Effect.gen(function* () {
        const l0 = makeNode("thread:l0", {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make("thread:l0"),
        });
        const humanL1 = makeNode("thread:human-l1", {
          parentThreadId: l0.id,
          relationshipToParent: "subtask",
          rootThreadId: l0.id,
        });
        const aiL1 = makeNode("thread:ai-l1", {
          parentThreadId: l0.id,
          relationshipToParent: "subagent",
          rootThreadId: l0.id,
        });
        const l2FromHuman = makeNode("thread:l2-from-human", {
          parentThreadId: humanL1.id,
          relationshipToParent: "subagent",
          rootThreadId: l0.id,
        });
        const l2FromAi = makeNode("thread:l2-from-ai", {
          parentThreadId: aiL1.id,
          relationshipToParent: "subtask",
          rootThreadId: l0.id,
        });
        const loadThread = loaderOf([l0, humanL1, aiL1, l2FromHuman, l2FromAi]);

        expect(yield* validateTaskChildPlacement({ parentThreadId: l0.id, loadThread })).toEqual({
          parentDepth: 0,
          childDepth: 1,
          rootThreadId: l0.id,
        });
        expect(
          yield* validateTaskChildPlacement({ parentThreadId: humanL1.id, loadThread }),
        ).toEqual({
          parentDepth: 1,
          childDepth: 2,
          rootThreadId: l0.id,
        });
        expect(yield* validateTaskChildPlacement({ parentThreadId: aiL1.id, loadThread })).toEqual({
          parentDepth: 1,
          childDepth: 2,
          rootThreadId: l0.id,
        });

        for (const l2Id of [l2FromHuman.id, l2FromAi.id]) {
          const exit = yield* Effect.exit(
            validateTaskChildPlacement({ parentThreadId: l2Id, loadThread }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons[0];
            expect(failure?._tag).toBe("Fail");
            if (failure?._tag === "Fail") {
              expect(failure.error).toBeInstanceOf(TaskTreeDepthError);
              expect(failure.error.reason).toBe("max_depth_exceeded");
            }
          }
        }
      }),
  );

  it.effect("rejects side chats, deleted parents, cycles, and deep remote-delegated chains", () =>
    Effect.gen(function* () {
      const rootId = ThreadId.make("thread:root");
      const sideChat = makeNode("thread:side", {
        parentThreadId: rootId,
        relationshipToParent: "fork",
        rootThreadId: rootId,
        sideChat: true,
      });
      const deleted = makeNode(
        "thread:deleted",
        {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make("thread:deleted"),
        },
        { deletedAt: DateTime.makeUnsafe("2026-11-19T00:00:00Z") },
      );
      const cycleA = makeNode("thread:cycle-a", {
        parentThreadId: ThreadId.make("thread:cycle-b"),
        relationshipToParent: "subtask",
        rootThreadId: rootId,
      });
      const cycleB = makeNode("thread:cycle-b", {
        parentThreadId: cycleA.id,
        relationshipToParent: "subtask",
        rootThreadId: rootId,
      });
      const remoteL1 = makeNode(
        "thread:remote-l1",
        {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make("thread:remote-l1"),
        },
        {
          delegatedFrom: {
            environmentId: EnvironmentId.make("env:remote"),
            threadId: ThreadId.make("thread:remote-l0"),
            title: "Remote Root",
          },
        },
      );
      const remoteL2 = makeNode("thread:remote-l2", {
        parentThreadId: remoteL1.id,
        relationshipToParent: "subtask",
        rootThreadId: remoteL1.id,
      });
      const loadThread = loaderOf([sideChat, deleted, cycleA, cycleB, remoteL1, remoteL2]);

      const checkReason = (parentThreadId: ThreadId, expected: TaskTreeDepthError["reason"]) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            validateTaskChildPlacement({ parentThreadId, loadThread }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons[0];
            expect(failure?._tag).toBe("Fail");
            if (failure?._tag === "Fail") {
              expect(failure.error).toBeInstanceOf(TaskTreeDepthError);
              expect(failure.error.reason).toBe(expected);
            }
          }
        });

      yield* checkReason(ThreadId.make("thread:missing"), "missing_parent");
      yield* checkReason(sideChat.id, "side_chat_parent");
      yield* checkReason(deleted.id, "deleted_parent");
      yield* checkReason(cycleA.id, "cycle");

      // Remote-delegated thread can host one local child (treated conservatively as L1 -> L2)
      expect(
        yield* validateTaskChildPlacement({ parentThreadId: remoteL1.id, loadThread }),
      ).toEqual({
        parentDepth: 1,
        childDepth: 2,
        rootThreadId: remoteL1.id,
      });
      // A child of a remotely delegated thread cannot spawn further without verifying remote depth
      yield* checkReason(remoteL2.id, "unverifiable_remote_ancestor");
    }),
  );
});

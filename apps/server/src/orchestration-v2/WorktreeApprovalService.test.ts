import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  WorktreeApprovalRequestId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorktreeApproval from "./WorktreeApprovalService.ts";

function makeLayer(ttlMs = 60_000) {
  const database = SqlitePersistence.layerMemory;
  return WorktreeApproval.layerWithConfig({ defaultTtlMs: ttlMs }).pipe(
    Layer.provide(database),
    Layer.merge(database),
  );
}

function makeEnsureInput(
  overrides: Partial<WorktreeApproval.WorktreeApprovalEnsureInput> = {},
): WorktreeApproval.WorktreeApprovalEnsureInput {
  return {
    requestId: WorktreeApprovalRequestId.make("worktree-approval:cmd-1"),
    commandId: CommandId.make("cmd-1"),
    projectId: ProjectId.make("project:1"),
    parentThreadId: ThreadId.make("thread:parent"),
    parentRunId: RunId.make("run:parent"),
    parentTaskId: NodeId.make("task:1"),
    childThreadId: ThreadId.make("thread:child"),
    childRunId: RunId.make("run:child"),
    baseRef: "main",
    baseCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branch: "feature/child",
    startFromOrigin: false,
    requestedBy: "agent",
    creationSource: "mcp",
    ...overrides,
  };
}

it.effect("persists requests idempotently and rejects immutable binding mismatches", () =>
  Effect.gen(function* () {
    const service = yield* WorktreeApproval.WorktreeApprovalService;
    const input = makeEnsureInput();

    const created = yield* service.ensureRequest(input);
    assert.equal(created.status, "pending");
    assert.equal(created.projectId, input.projectId);
    assert.equal(created.baseCommitSha, input.baseCommitSha);

    // Same requestId returns existing row idempotently
    const sameById = yield* service.ensureRequest(input);
    assert.equal(sameById.requestId, created.requestId);

    // Different requestId for same (childThreadId, childRunId) reuses existing row
    const sameByRun = yield* service.ensureRequest(
      makeEnsureInput({
        requestId: WorktreeApprovalRequestId.make("worktree-approval:retry-1"),
        commandId: CommandId.make("cmd-retry-1"),
      }),
    );
    assert.equal(sameByRun.requestId, created.requestId);

    // Different requestId for same (parentTaskId, childThreadId) reuses existing row
    const sameByTask = yield* service.ensureRequest(
      makeEnsureInput({
        requestId: WorktreeApprovalRequestId.make("worktree-approval:retry-2"),
        commandId: CommandId.make("cmd-retry-2"),
        childRunId: null,
      }),
    );
    assert.equal(sameByTask.requestId, created.requestId);

    // Mismatched projectId fails with binding_mismatch
    const badProject = yield* service
      .ensureRequest(makeEnsureInput({ projectId: ProjectId.make("project:other") }))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(badProject));

    // Mismatched baseCommitSha fails with binding_mismatch
    const badSha = yield* service
      .ensureRequest(makeEnsureInput({ baseCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(badSha));

    // Mismatched childThreadId on same requestId fails with binding_mismatch
    const badChild = yield* service
      .ensureRequest(makeEnsureInput({ childThreadId: ThreadId.make("thread:other-child") }))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(badChild));

    // Visible from both parent and child thread queries
    const parentList = yield* service.listForThread(ThreadId.make("thread:parent"));
    const childList = yield* service.listForThread(ThreadId.make("thread:child"));
    assert.equal(parentList.length, 1);
    assert.equal(childList.length, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("enforces single-resolution human decisions and wakes awaitResolution", () =>
  Effect.gen(function* () {
    const service = yield* WorktreeApproval.WorktreeApprovalService;
    const created = yield* service.ensureRequest(makeEnsureInput());

    const waiter = yield* service.awaitResolution(created.requestId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    const resolved = yield* service.resolveByHuman({
      requestId: created.requestId,
      decision: "approve",
      reason: "Looks good",
    });
    assert.equal(resolved.request.status, "approved");
    assert.equal(resolved.request.resolvedBy, "user");

    const awaited = yield* Fiber.join(waiter);
    assert.equal(awaited.status, "approved");

    // Second resolution is rejected
    const second = yield* service
      .resolveByHuman({ requestId: created.requestId, decision: "deny" })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(second));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("expires pending requests after TTL and rejects late human approval", () =>
  Effect.gen(function* () {
    const service = yield* WorktreeApproval.WorktreeApprovalService;
    const created = yield* service.ensureRequest(makeEnsureInput());

    const waiter = yield* service.awaitResolution(created.requestId).pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    yield* TestClock.adjust(Duration.seconds(61));
    const awaited = yield* Fiber.join(waiter);
    assert.equal(awaited.status, "expired");

    const lateApprove = yield* service
      .resolveByHuman({ requestId: created.requestId, decision: "approve" })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(lateApprove));

    const persisted = yield* service.getById(created.requestId);
    assert.equal(Option.getOrThrow(persisted).status, "expired");
  }).pipe(Effect.provide(makeLayer(60_000))),
);

it.effect("cancels pending requests by parent task scope and updates thread stream", () =>
  Effect.gen(function* () {
    const service = yield* WorktreeApproval.WorktreeApprovalService;
    const created = yield* service.ensureRequest(makeEnsureInput());

    const waiter = yield* service.awaitResolution(created.requestId).pipe(Effect.forkChild);
    const streamFiber = yield* service
      .streamForThread(ThreadId.make("thread:parent"))
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
    yield* Effect.yieldNow;

    const cancelledCount = yield* service.cancelByScope({
      parentTaskId: NodeId.make("task:1"),
      reason: "Parent task cancelled",
    });
    assert.equal(cancelledCount, 1);

    const awaited = yield* Fiber.join(waiter);
    assert.equal(awaited.status, "cancelled");
    assert.equal(awaited.resolutionReason, "Parent task cancelled");

    const events = Array.from(yield* Fiber.join(streamFiber));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.requests[0]?.status, "pending");
    assert.equal(events[1]?.requests[0]?.status, "cancelled");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect(
  "withProvisionLock creates worktree at most once across concurrent and replayed callers",
  () =>
    Effect.gen(function* () {
      const service = yield* WorktreeApproval.WorktreeApprovalService;
      const created = yield* service.ensureRequest(makeEnsureInput());

      // Rejects provisioning before approval
      const beforeApprove = yield* service
        .withProvisionLock(created.requestId, () =>
          Effect.succeed({ worktreePath: "/wt/1", branch: "feature/child" }),
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(beforeApprove));

      yield* service.resolveByHuman({
        requestId: created.requestId,
        decision: "approve",
      });

      const gate = yield* Deferred.make<void>();
      const provision = vi.fn<
        () => Effect.Effect<{ readonly worktreePath: string; readonly branch: string | null }>
      >(() =>
        Deferred.await(gate).pipe(
          Effect.as({ worktreePath: "/wt/approved-1", branch: "feature/child" }),
        ),
      );

      const firstFiber = yield* service
        .withProvisionLock(created.requestId, provision)
        .pipe(Effect.forkChild);
      const secondFiber = yield* service
        .withProvisionLock(created.requestId, provision)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);

      const [first, second] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)]);
      assert.equal(provision.mock.calls.length, 1);
      assert.equal(first.worktreePath, "/wt/approved-1");
      assert.equal(second.worktreePath, "/wt/approved-1");
      assert.notEqual(first.alreadyProvisioned, second.alreadyProvisioned);

      // Subsequent replay reuses persisted worktree without calling provision again
      const replay = yield* service.withProvisionLock(created.requestId, provision);
      assert.equal(provision.mock.calls.length, 1);
      assert.isTrue(replay.alreadyProvisioned);
      assert.equal(replay.worktreePath, "/wt/approved-1");
      assert.equal(replay.branch, "feature/child");
    }).pipe(Effect.provide(makeLayer())),
);

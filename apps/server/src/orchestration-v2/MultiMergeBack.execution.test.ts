import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}

function makeControlledAdapterLayer(input: {
  readonly name: string;
  readonly capturedTurns: Array<CapturedTurn>;
  readonly shouldFailTurnStart?: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
}) {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "model-alpha" };
  let eventQueue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event> | null = null;
  let nativeThreadSeq = 0;

  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: ({ providerSessionId }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        eventQueue = queue;
        return {
          instanceId,
          driver,
          providerSessionId,
          providerSession: {
            id: providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(queue),
          ensureThread: ({ threadId, existingProviderThread, forceNewNativeThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: {
                driver,
                nativeId: forceNewNativeThread
                  ? `native:${threadId}:fresh:${++nativeThreadSeq}`
                  : (existingProviderThread?.nativeThreadRef?.nativeId ?? `native:${threadId}`),
                strength: "strong",
              },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          forkThread: () => Effect.die(new Error("forkThread not expected")),
          startTurn: (turn) =>
            Effect.gen(function* () {
              input.capturedTurns.push({
                threadId: turn.threadId,
                runId: turn.runId,
                text: turn.message.text,
              });
              if (input.shouldFailTurnStart?.(turn)) {
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  runId: turn.runId,
                  cause: new Error("Simulated pre-delivery provider refusal"),
                });
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          rollbackThread: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };

  return {
    driver,
    instanceId,
    modelSelection,
    emitProviderEvent: (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.suspend(() => (eventQueue ? Queue.offer(eventQueue, event) : Effect.void)),
    layer: ProviderReplayHarness.layerWithRegistry(
      { name: input.name },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
    ),
  };
}

function writeCompletedRun(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly userText: string;
  readonly assistantText: string;
}) {
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`pt:${input.threadId}`);
    const attemptId = RunAttemptId.make(`attempt:${input.runId}:1`);
    const rootNodeId = NodeId.make(`node:${input.runId}:root`);
    const userMessageId = MessageId.make(`msg:${input.runId}:user`);
    const assistantMessageId = MessageId.make(`msg:${input.runId}:assistant`);

    yield* sink.write({
      events: [
        {
          id: EventId.make(`ev:${input.runId}:pt`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: input.driver,
            providerInstanceId: input.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: input.driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:run`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: input.instanceId,
            modelSelection: input.modelSelection,
            providerThreadId,
            userMessageId,
            rootNodeId,
            activeAttemptId: attemptId,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:attempt`),
          type: "run-attempt.created",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: attemptId,
            runId: input.runId,
            attemptOrdinal: 1,
            rootNodeId,
            providerInstanceId: input.instanceId,
            providerThreadId,
            providerTurnId: null,
            reason: "initial",
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:node`),
          type: "node.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "completed",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:user-msg`),
          type: "message.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: userMessageId,
            threadId: input.threadId,
            runId: input.runId,
            nodeId: rootNodeId,
            role: "user",
            text: input.userText,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:user-item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`ti:${input.runId}:user`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: rootNodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100,
            status: "completed",
            title: null,
            type: "user_message",
            messageId: userMessageId,
            inputIntent: "turn_start",
            text: input.userText,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:assistant-item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: rootNodeId,
          providerInstanceId: input.instanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`ti:${input.runId}:assistant`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: rootNodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100 + 1,
            status: "completed",
            title: null,
            type: "assistant_message",
            messageId: assistantMessageId,
            text: input.assistantText,
            streaming: false,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });
}

function waitUntil<E>(check: () => Effect.Effect<boolean, E>, label: string) {
  return Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    if (yield* check()) return;
    assert.fail(`Expected condition after draining effect worker: ${label}`);
  });
}

describe("Multi-attachment passive Bring back pool (Acceptance Scenario 3)", () => {
  it.effect(
    "pools multiple sources while busy/queued, isolates pre-queued X and child reports, supports idempotency & revoke, delivers once under shared budget, and never replays",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const { driver, instanceId, modelSelection, layer } = makeControlledAdapterLayer({
        name: "multi-merge-back-scenario-3",
        capturedTurns,
      });

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const projectId = ProjectId.make("project:mmb-s3");
        const parentId = ThreadId.make("thread:parent-mmb-s3");
        const childAId = ThreadId.make("thread:child-a-mmb-s3");
        const childBId = ThreadId.make("thread:child-b-mmb-s3");
        const childCId = ThreadId.make("thread:child-c-mmb-s3");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-parent-mmb-s3"),
          threadId: parentId,
          projectId,
          title: "Parent Root",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        const parentRun1 = RunId.make("run:parent-mmb-1");
        yield* writeCompletedRun({
          driver,
          instanceId,
          modelSelection,
          threadId: parentId,
          runId: parentRun1,
          ordinal: 1,
          userText: "Start root task",
          assistantText: "Root task initialized",
        });

        // Spawn Side Chat A (fork), Subtask B (subtask), and Fork C (fork)
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:fork-a"),
          sourceThreadId: parentId,
          targetThreadId: childAId,
          sourcePoint: { type: "run", runId: parentRun1 },
          title: "Side Chat A",
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:subtask-b"),
          sourceThreadId: parentId,
          targetThreadId: childBId,
          sourcePoint: { type: "run", runId: parentRun1 },
          title: "Subtask B",
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:fork-c"),
          sourceThreadId: parentId,
          targetThreadId: childCId,
          sourcePoint: { type: "run", runId: parentRun1 },
          title: "Fork C",
          createdBy: "user",
          creationSource: "web",
        });

        const runA = RunId.make("run:child-a-1");
        const runB = RunId.make("run:child-b-1");
        const runC = RunId.make("run:child-c-1");
        const verbosePadding = "EXTRA_DETAIL_LINE ".repeat(350);
        yield* writeCompletedRun({
          driver,
          instanceId,
          modelSelection,
          threadId: childAId,
          runId: runA,
          ordinal: 1,
          userText: `Analyze A ${verbosePadding}`,
          assistantText: "CONCLUSION_FROM_A: use lock-free queue",
        });
        yield* writeCompletedRun({
          driver,
          instanceId,
          modelSelection,
          threadId: childBId,
          runId: runB,
          ordinal: 1,
          userText: "Analyze B",
          assistantText: "CONCLUSION_FROM_B: preserve SQLite index",
        });
        yield* writeCompletedRun({
          driver,
          instanceId,
          modelSelection,
          threadId: childCId,
          runId: runC,
          ordinal: 1,
          userText: "Analyze C",
          assistantText: "CONCLUSION_FROM_C: enforce root-to-leaf delete order",
        });

        // Put parent in an active running turn and pre-queue message X BEFORE any Bring back
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:parent-busy-turn"),
          threadId: parentId,
          messageId: MessageId.make("msg:parent-busy-turn"),
          text: "PARENT_BUSY_TURN",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(
          () => Effect.sync(() => capturedTurns.some((t) => t.text.includes("PARENT_BUSY_TURN"))),
          "parent busy turn started",
        );

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:parent-prequeued-x"),
          threadId: parentId,
          messageId: MessageId.make("msg:parent-prequeued-x"),
          text: "PREQUEUED_MESSAGE_X",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        // Attach A, B, C while parent is busy + has pre-queued X
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:mb-a-1"),
          sourceThreadId: childAId,
          targetThreadId: parentId,
          sourcePoint: { type: "run", runId: runA },
          createdBy: "user",
          creationSource: "web",
        });
        const afterA1 = yield* orchestrator.getThreadProjection(parentId);
        const transferA1 = afterA1.contextTransfers.find(
          (t) => t.type === "merge_back" && t.sourceThreadId === childAId && t.status === "pending",
        );
        assert.isDefined(transferA1);

        // Repeat A with same run -> idempotent, no ID churn
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:mb-a-dup"),
          sourceThreadId: childAId,
          targetThreadId: parentId,
          sourcePoint: { type: "run", runId: runA },
          createdBy: "user",
          creationSource: "web",
        });
        const afterADup = yield* orchestrator.getThreadProjection(parentId);
        const pendingA = afterADup.contextTransfers.filter(
          (t) => t.type === "merge_back" && t.sourceThreadId === childAId && t.status === "pending",
        );
        assert.lengthOf(pendingA, 1);
        assert.equal(pendingA[0]!.id, transferA1!.id);

        // Attach B, revoke B, then re-attach B
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:mb-b-1"),
          sourceThreadId: childBId,
          targetThreadId: parentId,
          sourcePoint: { type: "run", runId: runB },
          createdBy: "user",
          creationSource: "web",
        });
        const afterB1 = yield* orchestrator.getThreadProjection(parentId);
        const transferB1 = afterB1.contextTransfers.find(
          (t) => t.type === "merge_back" && t.sourceThreadId === childBId && t.status === "pending",
        )!;
        yield* orchestrator.dispatch({
          type: "thread.merge_back.revoke",
          commandId: CommandId.make("cmd:mb-b-revoke"),
          threadId: parentId,
          transferId: transferB1.id,
          createdBy: "user",
          creationSource: "web",
        });
        const afterBRevoke = yield* orchestrator.getThreadProjection(parentId);
        assert.isUndefined(
          afterBRevoke.contextTransfers.find(
            (t) =>
              t.type === "merge_back" && t.sourceThreadId === childBId && t.status === "pending",
          ),
        );
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:mb-b-2"),
          sourceThreadId: childBId,
          targetThreadId: parentId,
          sourcePoint: { type: "run", runId: runB },
          createdBy: "user",
          creationSource: "web",
        });

        // Attach C
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:mb-c-1"),
          sourceThreadId: childCId,
          targetThreadId: parentId,
          sourcePoint: { type: "run", runId: runC },
          createdBy: "user",
          creationSource: "web",
        });

        // Child interim report & /compact MUST NOT steal pending merge-backs
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:child-report-no-steal"),
          threadId: parentId,
          senderThreadId: childBId,
          childReport: {
            childThreadId: childBId,
            childRunId: runB,
            reportKind: "interim",
          },
          messageId: MessageId.make("msg:child-report-no-steal"),
          text: "Halfway done",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const afterReport = yield* orchestrator.getThreadProjection(parentId);
        assert.lengthOf(
          afterReport.contextTransfers.filter(
            (t) => t.type === "merge_back" && t.status === "pending",
          ),
          3,
        );

        // Submit NEW normal human parent message M -> atomically binds A, B, C to M!
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:parent-message-m"),
          threadId: parentId,
          messageId: MessageId.make("msg:parent-message-m"),
          text: "SYNTHESIZE_MESSAGE_M",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        const afterBindM = yield* orchestrator.getThreadProjection(parentId);
        const runM = afterBindM.runs.find(
          (r) => r.userMessageId === MessageId.make("msg:parent-message-m"),
        )!;
        const boundToM = afterBindM.contextTransfers.filter(
          (t) => t.type === "merge_back" && t.status === "bound" && t.targetRunId === runM.id,
        );
        assert.lengthOf(boundToM, 3);
        assert.lengthOf(
          afterBindM.contextTransfers.filter(
            (t) => t.type === "merge_back" && t.status === "pending",
          ),
          0,
        );

        // Bound transfer cannot be revoked
        const revokeBoundError = yield* orchestrator
          .dispatch({
            type: "thread.merge_back.revoke",
            commandId: CommandId.make("cmd:revoke-bound-error"),
            threadId: parentId,
            transferId: boundToM[0]!.id,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.include(String(revokeBoundError.cause), "bound");

        // Helper to complete whichever active run is currently running on parent
        const completeActiveParentRun = Effect.fn("completeActiveParentRun")(function* (
          tag: string,
          expectNextStarting = false,
        ) {
          const proj = yield* orchestrator.getThreadProjection(parentId);
          const active = proj.runs.find((r) => r.status === "running" || r.status === "starting");
          assert.isDefined(active, `Expected active run for ${tag}`);
          const attempt = proj.attempts.find((a) => a.id === active!.activeAttemptId)!;
          const node = proj.nodes.find((n) => n.id === active!.rootNodeId)!;
          const completedAt = yield* DateTime.now;
          const nextStartingFiber = expectNextStarting
            ? yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.type === "run.updated" &&
                    event.threadId === parentId &&
                    event.runId !== active!.id &&
                    event.payload.status === "starting",
                ),
                Stream.runHead,
                Effect.forkChild({ startImmediately: true }),
              )
            : null;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`ev:complete:${tag}:run`),
                type: "run.updated",
                threadId: parentId,
                runId: active!.id,
                nodeId: node.id,
                providerInstanceId: active!.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...active!, status: "completed", completedAt },
              },
              {
                id: EventId.make(`ev:complete:${tag}:attempt`),
                type: "run-attempt.updated",
                threadId: parentId,
                runId: active!.id,
                nodeId: node.id,
                providerInstanceId: active!.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...attempt, status: "completed", completedAt },
              },
              {
                id: EventId.make(`ev:complete:${tag}:node`),
                type: "node.updated",
                threadId: parentId,
                runId: active!.id,
                nodeId: node.id,
                providerInstanceId: active!.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...node, status: "completed", completedAt },
              },
            ],
          });
          if (nextStartingFiber !== null) {
            yield* Fiber.join(nextStartingFiber);
          }
        });

        // Finish busy turn -> pre-queued X runs WITHOUT A/B/C!
        yield* completeActiveParentRun("busy-turn", true);
        yield* waitUntil(
          () =>
            Effect.sync(() => capturedTurns.some((t) => t.text.includes("PREQUEUED_MESSAGE_X"))),
          "pre-queued X started",
        );
        const turnX = capturedTurns.find((t) => t.text.includes("PREQUEUED_MESSAGE_X"))!;
        assert.notInclude(turnX.text, "CONCLUSION_FROM_A");
        assert.notInclude(turnX.text, "CONCLUSION_FROM_B");
        assert.notInclude(turnX.text, "CONCLUSION_FROM_C");

        // Finish X -> interim report runs WITHOUT A/B/C!
        yield* completeActiveParentRun("prequeued-x", true);
        yield* waitUntil(
          () => Effect.sync(() => capturedTurns.some((t) => t.text.includes("Halfway done"))),
          "interim child report started",
        );
        const turnReport = capturedTurns.find((t) => t.text.includes("Halfway done"))!;
        assert.notInclude(turnReport.text, "CONCLUSION_FROM_A");
        assert.notInclude(turnReport.text, "CONCLUSION_FROM_B");
        assert.notInclude(turnReport.text, "CONCLUSION_FROM_C");

        // Finish interim report -> M runs WITH A, B, C in a single turn!
        yield* completeActiveParentRun("interim-report", true);
        yield* waitUntil(
          () =>
            Effect.sync(() => capturedTurns.some((t) => t.text.includes("SYNTHESIZE_MESSAGE_M"))),
          "message M started",
        );
        const turnM = capturedTurns.find((t) => t.text.includes("SYNTHESIZE_MESSAGE_M"))!;
        assert.include(turnM.text, "CONCLUSION_FROM_A: use lock-free queue");
        assert.include(turnM.text, "CONCLUSION_FROM_B: preserve SQLite index");
        assert.include(turnM.text, "CONCLUSION_FROM_C: enforce root-to-leaf delete order");
        assert.include(turnM.text, childAId);
        assert.include(turnM.text, childBId);
        assert.include(turnM.text, childCId);
        assert.include(turnM.text, "t3_thread_read");

        // All 3 transfers are promoted to consumed right after provider acceptance
        yield* waitUntil(
          () =>
            orchestrator
              .getThreadProjection(parentId)
              .pipe(
                Effect.map(
                  (proj) =>
                    proj.contextTransfers.filter(
                      (t) =>
                        t.type === "merge_back" &&
                        t.targetRunId === runM.id &&
                        t.status === "consumed" &&
                        t.consumedAt !== null,
                    ).length === 3,
                ),
              ),
          "all 3 merge-back transfers marked consumed",
        );

        // Finish M and send follow-up N -> NO replay of A/B/C
        yield* completeActiveParentRun("message-m");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:parent-message-n"),
          threadId: parentId,
          messageId: MessageId.make("msg:parent-message-n"),
          text: "FOLLOWUP_MESSAGE_N",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(
          () => Effect.sync(() => capturedTurns.some((t) => t.text.includes("FOLLOWUP_MESSAGE_N"))),
          "follow-up message N started",
        );
        const turnN = capturedTurns.find((t) => t.text.includes("FOLLOWUP_MESSAGE_N"))!;
        assert.notInclude(turnN.text, "CONCLUSION_FROM_A");
        assert.notInclude(turnN.text, "CONCLUSION_FROM_B");
        assert.notInclude(turnN.text, "CONCLUSION_FROM_C");

        void now;
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "rolls bound merge-back back to pending on queued cancel or pre-delivery refusal, and keeps consumed on post-delivery failure",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      let refuseNextTurn = false;
      const { driver, instanceId, modelSelection, layer } = makeControlledAdapterLayer({
        name: "multi-merge-back-3state-recovery",
        capturedTurns,
        shouldFailTurnStart: (turn) => {
          if (refuseNextTurn && turn.message.text.includes("REFUSED_MSG")) {
            refuseNextTurn = false;
            return true;
          }
          return false;
        },
      });

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:mmb-recovery");
        const parentId = ThreadId.make("thread:parent-mmb-recovery");
        const childId = ThreadId.make("thread:child-mmb-recovery");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-parent-rec"),
          threadId: parentId,
          projectId,
          title: "Recovery Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        const parentRun1 = RunId.make("run:parent-rec-1");
        yield* writeCompletedRun({
          driver,
          instanceId,
          modelSelection,
          threadId: parentId,
          runId: parentRun1,
          ordinal: 1,
          userText: "Init",
          assistantText: "Ready",
        });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:subtask-rec"),
          sourceThreadId: parentId,
          targetThreadId: childId,
          sourcePoint: { type: "run", runId: parentRun1 },
          title: "Subtask Recovery",
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        const childRun1 = RunId.make("run:child-rec-1");
        yield* writeCompletedRun({
          driver,
          instanceId,
          modelSelection,
          threadId: childId,
          runId: childRun1,
          ordinal: 1,
          userText: "Investigate recovery",
          assistantText: "RECOVERY_CONCLUSION_TOKEN",
        });

        // 1) Busy parent -> attach child -> queue M1 -> cancel M1 -> rolls back to pending
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:busy-rec"),
          threadId: parentId,
          messageId: MessageId.make("msg:busy-rec"),
          text: "BUSY_REC",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(
          () => Effect.sync(() => capturedTurns.some((t) => t.text.includes("BUSY_REC"))),
          "busy turn started",
        );

        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:mb-rec"),
          sourceThreadId: childId,
          targetThreadId: parentId,
          sourcePoint: { type: "run", runId: childRun1 },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:m1-queued-cancel"),
          threadId: parentId,
          messageId: MessageId.make("msg:m1-queued-cancel"),
          text: "CANCELLED_M1",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const beforeCancel = yield* orchestrator.getThreadProjection(parentId);
        const runM1 = beforeCancel.runs.find(
          (r) => r.userMessageId === MessageId.make("msg:m1-queued-cancel"),
        )!;
        assert.equal(
          beforeCancel.contextTransfers.find((t) => t.type === "merge_back")?.status,
          "bound",
        );

        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cmd:cancel-m1"),
          threadId: parentId,
          runId: runM1.id,
        });
        const afterCancel = yield* orchestrator.getThreadProjection(parentId);
        const rolledBackAfterCancel = afterCancel.contextTransfers.find(
          (t) => t.type === "merge_back",
        )!;
        assert.equal(rolledBackAfterCancel.status, "pending");
        assert.isNull(rolledBackAfterCancel.targetRunId);

        // Complete busy turn
        const activeBusy = afterCancel.runs.find(
          (r) => r.status === "running" || r.status === "starting",
        )!;
        const busyAttempt = afterCancel.attempts.find((a) => a.id === activeBusy.activeAttemptId)!;
        const busyNode = afterCancel.nodes.find((n) => n.id === activeBusy.rootNodeId)!;
        const doneAt = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:rec:busy-done:run"),
              type: "run.updated",
              threadId: parentId,
              runId: activeBusy.id,
              nodeId: busyNode.id,
              providerInstanceId: activeBusy.providerInstanceId,
              occurredAt: doneAt,
              payload: { ...activeBusy, status: "completed", completedAt: doneAt },
            },
            {
              id: EventId.make("ev:rec:busy-done:attempt"),
              type: "run-attempt.updated",
              threadId: parentId,
              runId: activeBusy.id,
              nodeId: busyNode.id,
              providerInstanceId: activeBusy.providerInstanceId,
              occurredAt: doneAt,
              payload: { ...busyAttempt, status: "completed", completedAt: doneAt },
            },
            {
              id: EventId.make("ev:rec:busy-done:node"),
              type: "node.updated",
              threadId: parentId,
              runId: activeBusy.id,
              nodeId: busyNode.id,
              providerInstanceId: activeBusy.providerInstanceId,
              occurredAt: doneAt,
              payload: { ...busyNode, status: "completed", completedAt: doneAt },
            },
          ],
        });

        // 2) Pre-delivery refusal -> rolls back to pending
        refuseNextTurn = true;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:m2-refused"),
          threadId: parentId,
          messageId: MessageId.make("msg:m2-refused"),
          text: "REFUSED_MSG",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(
          () =>
            orchestrator.getThreadProjection(parentId).pipe(
              Effect.map((proj) => {
                const runM2 = proj.runs.find(
                  (r) => r.userMessageId === MessageId.make("msg:m2-refused"),
                );
                const transfer = proj.contextTransfers.find((t) => t.type === "merge_back");
                return (
                  runM2?.status === "failed" &&
                  transfer?.status === "pending" &&
                  transfer.targetRunId === null
                );
              }),
            ),
          "refused turn failed and merge-back rolled back to pending",
        );

        // 3) Provider accepts M3 -> status becomes consumed even if M3 fails mid-stream, and M4 does NOT replay
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:m3-accepted"),
          threadId: parentId,
          messageId: MessageId.make("msg:m3-accepted"),
          text: "ACCEPTED_M3",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(
          () =>
            orchestrator.getThreadProjection(parentId).pipe(
              Effect.map((proj) => {
                const transfer = proj.contextTransfers.find((t) => t.type === "merge_back");
                return transfer?.status === "consumed" && transfer.consumedAt !== null;
              }),
            ),
          "merge-back marked consumed after provider acceptance",
        );
        const turnM3 = capturedTurns.find((t) => t.text.includes("ACCEPTED_M3"))!;
        assert.include(turnM3.text, "RECOVERY_CONCLUSION_TOKEN");

        // Simulate post-delivery failure of M3
        const projM3 = yield* orchestrator.getThreadProjection(parentId);
        const runM3 = projM3.runs.find(
          (r) => r.userMessageId === MessageId.make("msg:m3-accepted"),
        )!;
        const attemptM3 = projM3.attempts.find((a) => a.id === runM3.activeAttemptId)!;
        const nodeM3 = projM3.nodes.find((n) => n.id === runM3.rootNodeId)!;
        const failAt = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:rec:m3-fail:run"),
              type: "run.updated",
              threadId: parentId,
              runId: runM3.id,
              nodeId: nodeM3.id,
              providerInstanceId: runM3.providerInstanceId,
              occurredAt: failAt,
              payload: { ...runM3, status: "failed", completedAt: failAt },
            },
            {
              id: EventId.make("ev:rec:m3-fail:attempt"),
              type: "run-attempt.updated",
              threadId: parentId,
              runId: runM3.id,
              nodeId: nodeM3.id,
              providerInstanceId: runM3.providerInstanceId,
              occurredAt: failAt,
              payload: { ...attemptM3, status: "failed", completedAt: failAt },
            },
            {
              id: EventId.make("ev:rec:m3-fail:node"),
              type: "node.updated",
              threadId: parentId,
              runId: runM3.id,
              nodeId: nodeM3.id,
              providerInstanceId: runM3.providerInstanceId,
              occurredAt: failAt,
              payload: { ...nodeM3, status: "failed", completedAt: failAt },
            },
          ],
        });

        // Next turn M4 must NOT silently replay the already-consumed merge-back!
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:m4-no-replay"),
          threadId: parentId,
          messageId: MessageId.make("msg:m4-no-replay"),
          text: "FOLLOWUP_M4",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* waitUntil(
          () => Effect.sync(() => capturedTurns.some((t) => t.text.includes("FOLLOWUP_M4"))),
          "follow-up M4 started",
        );
        const turnM4 = capturedTurns.find((t) => t.text.includes("FOLLOWUP_M4"))!;
        assert.notInclude(turnM4.text, "RECOVERY_CONCLUSION_TOKEN");
      }).pipe(Effect.provide(layer));
    },
  );
});

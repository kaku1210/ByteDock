import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  SubtaskEscalationRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SubtaskEscalationService from "./SubtaskEscalationService.ts";
import * as SubtaskEscalationStore from "./SubtaskEscalationStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}

function makeHarness(capturedTurns: Array<CapturedTurn>) {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "model-alpha" };
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
                strength: "weak",
              },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          forkThread: () => Effect.die(new Error("forkThread not expected")),
          startTurn: (turn) =>
            Effect.sync(() => {
              capturedTurns.push({
                threadId: turn.threadId,
                runId: turn.runId,
                text: turn.message.text,
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          rollbackThread: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };

  const layerDatabase = SqlitePersistence.layerMemory;
  const base = ProviderReplayHarness.layerWithRegistry(
    { name: "subtask-escalation-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );

  return {
    modelSelection,
    layer: ThreadManagementService.layer.pipe(
      Layer.provideMerge(base),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    ),
  };
}

function completeRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly replyText: string;
}) {
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sink = yield* EventSink.EventSinkV2;
    const projection = yield* orchestrator.getThreadProjection(input.threadId);
    const run = projection.runs.find((candidate) => candidate.id === input.runId);
    assert.isDefined(run);
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    assert.isDefined(attempt);
    const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
    assert.isDefined(node);
    const now = yield* DateTime.now;
    const assistantMessageId = MessageId.make(`msg:${input.runId}:assistant`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`ev:${input.runId}:assistant-msg`),
          type: "message.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: assistantMessageId,
            threadId: input.threadId,
            runId: run.id,
            nodeId: node.id,
            role: "assistant",
            text: input.replyText,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:assistant-item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`ti:${input.runId}:assistant`),
            threadId: input.threadId,
            runId: run.id,
            nodeId: node.id,
            providerThreadId: attempt.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: run.ordinal * 100 + 1,
            status: "completed",
            title: null,
            type: "assistant_message",
            messageId: assistantMessageId,
            text: input.replyText,
            streaming: false,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:run-done`),
          type: "run.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            ...run,
            status: "completed",
            completedAt: now,
            checkpointId: CheckpointId.make(`cp:${run.id}`),
          },
        },
        {
          id: EventId.make(`ev:${input.runId}:attempt-done`),
          type: "run-attempt.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "completed", completedAt: now },
        },
        {
          id: EventId.make(`ev:${input.runId}:node-done`),
          type: "node.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "completed", completedAt: now },
        },
      ],
    });
    yield* worker.drain();
  });
}

describe("SubtaskEscalationService (P0-6 horizontal L1 escalation)", () => {
  it.effect(
    "enforces L1-only source guard, creates sibling L1 draft under L0 with sourceAnchor & sibling handoff, and is idempotent across retries and cross-channel resolution",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeHarness(capturedTurns);
      const projectId = ProjectId.make("project:esc-1");
      const l0 = ThreadId.make("thread:esc:l0");
      const l1 = ThreadId.make("thread:esc:l1");
      const l2 = ThreadId.make("thread:esc:l2");
      const sideChat = ThreadId.make("thread:esc:side");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* SubtaskEscalationService.SubtaskEscalationService;

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:esc:create-l0"),
          threadId: l0,
          projectId,
          title: "Root L0",
          modelSelection: env.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:esc:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:esc:l0-r1"),
          text: "Root goal",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run1 = (yield* orchestrator.getThreadProjection(l0)).runs[0]!;
        yield* completeRun({ threadId: l0, runId: l0Run1.id, replyText: "Root analysis ready." });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:esc:fork-l1"),
          sourceThreadId: l0,
          targetThreadId: l1,
          subtask: true,
          title: "Subtask L1-A",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:esc:l1-r1"),
          threadId: l1,
          messageId: MessageId.make("msg:esc:l1-r1"),
          text: "Investigate module A",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l1Run1 = (yield* orchestrator.getThreadProjection(l1)).runs[0]!;
        yield* completeRun({ threadId: l1, runId: l1Run1.id, replyText: "Needs sibling L1-B." });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:esc:fork-l2"),
          sourceThreadId: l1,
          targetThreadId: l2,
          subtask: true,
          title: "Subtask L2",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:esc:fork-side"),
          sourceThreadId: l0,
          targetThreadId: sideChat,
          sideChat: true,
          temporary: false,
          title: "Side Chat",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // L0, L2, and Side Chat must all be rejected with invalid_source.
        for (const forbiddenSource of [l0, l2, sideChat]) {
          const error = yield* service
            .createHumanDraft({
              sourceThreadId: forbiddenSource,
              task: "Attempt forbidden escalation",
            })
            .pipe(Effect.flip);
          assert.equal(error.reason, "invalid_source");
        }

        // L1 human escalation creates a persistent sibling L1 draft under L0 without auto-sending.
        const req1 = SubtaskEscalationRequestId.make("esc:req:human-1");
        const first = yield* service.createHumanDraft({
          requestId: req1,
          sourceThreadId: l1,
          title: "Sibling L1-B",
          task: "Audit cross-cutting auth module",
          sourceRunId: l1Run1.id,
          excerpt: "Needs sibling L1-B.",
        });
        assert.isFalse(first.replayed);
        assert.equal(first.request.status, "fulfilled");
        assert.equal(first.request.rootThreadId, l0);
        assert.equal(first.request.sourceThreadId, l1);
        assert.equal(first.request.childThreadId, first.childThreadId);

        const siblingProj = yield* orchestrator.getThreadProjection(first.childThreadId);
        assert.equal(siblingProj.thread.lineage.relationshipToParent, "subtask");
        assert.equal(siblingProj.thread.lineage.parentThreadId, l0);
        assert.equal(siblingProj.thread.lineage.rootThreadId, l0);
        assert.equal(siblingProj.thread.sourceAnchor?.sourceThreadId, l1);
        assert.equal(siblingProj.thread.sourceAnchor?.sourceRunId, l1Run1.id);
        assert.equal(siblingProj.thread.sourceAnchor?.excerpt, "Needs sibling L1-B.");
        assert.equal(siblingProj.runs.length, 0);

        // Sending the first turn into the sibling L1 injects the sibling escalation anchor in handoff.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:esc:sibling-r1"),
          threadId: first.childThreadId,
          messageId: MessageId.make("msg:esc:sibling-r1"),
          text: "Start auditing auth",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const siblingTurn = capturedTurns.find((turn) => turn.threadId === first.childThreadId);
        assert.isDefined(siblingTurn);
        assert.include(siblingTurn.text, `Escalated from sibling L1 subtask: ${l1}`);

        // Replaying with the same requestId is strictly idempotent and returns the same childThreadId.
        const replay = yield* service.createHumanDraft({
          requestId: req1,
          sourceThreadId: l1,
          task: "Duplicate retry",
        });
        assert.isTrue(replay.replayed);
        assert.equal(replay.childThreadId, first.childThreadId);

        // Reusing req1 from a different sourceThreadId (the sibling L1-B) fails with binding_mismatch.
        const mismatchError = yield* service
          .createHumanDraft({
            requestId: req1,
            sourceThreadId: first.childThreadId,
            task: "Hijack requestId",
          })
          .pipe(Effect.flip);
        assert.equal(mismatchError.reason, "binding_mismatch");

        // Cross-channel dedupe: agent submits escalation -> human accepts via create_draft -> L0 delegate retry gets replayed same childThreadId!
        const reqCross = SubtaskEscalationRequestId.make("esc:req:cross-1");
        const submitted = yield* service.submitAgentEscalation({
          requestId: reqCross,
          sourceThreadId: l1,
          title: "Sibling L1-C",
          task: "Handle billing edge case",
          holdParentQueue: true,
        });
        assert.isFalse(submitted.replayed);
        assert.equal(submitted.request.status, "pending");
        assert.isTrue(submitted.request.parentQueueHeld);

        const resolved = yield* service.resolveByHuman({
          requestId: reqCross,
          decision: "create_draft",
        });
        assert.equal(resolved.request.status, "fulfilled");
        assert.isNotNull(resolved.childThreadId);

        let delegationRan = false;
        const delegateReplay = yield* service.fulfillForDelegation({
          requestId: reqCross,
          callerThreadId: l0,
          runDelegation: () => {
            delegationRan = true;
            return Effect.die("must not run delegation on already-fulfilled escalation");
          },
        });
        assert.isFalse(delegationRan);
        assert.isTrue(delegateReplay.replayed);
        assert.equal(delegateReplay.childThreadId, resolved.childThreadId);
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "returns explicit terminal errors when root is archived/deleted, cancels pending escalations on root archive/delete, and never deadlocks under concurrent escalate + archive (Scenarios #4 & #6)",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeHarness(capturedTurns);
      const projectId = ProjectId.make("project:esc-2");
      const l0 = ThreadId.make("thread:esc2:l0");
      const l1 = ThreadId.make("thread:esc2:l1");
      const l0b = ThreadId.make("thread:esc2:l0b");
      const l1b = ThreadId.make("thread:esc2:l1b");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* SubtaskEscalationService.SubtaskEscalationService;
        const store = yield* SubtaskEscalationStore.SubtaskEscalationStore;

        // Setup tree A: L0 -> L1 with a pending agent escalation, then archive L0.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:esc2:create-l0"),
          threadId: l0,
          projectId,
          title: "Root A",
          modelSelection: env.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:esc2:fork-l1"),
          sourceThreadId: l0,
          targetThreadId: l1,
          subtask: true,
          title: "L1 A",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        const pendingReqId = SubtaskEscalationRequestId.make("esc:req:archive-cancel");
        const submitted = yield* service.submitAgentEscalation({
          requestId: pendingReqId,
          sourceThreadId: l1,
          task: "Needs sibling before archive",
          holdParentQueue: true,
        });
        assert.equal(submitted.request.status, "pending");

        // Archive L0: pending escalation must be cancelled automatically via Orchestrator hook.
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd:esc2:archive-l0"),
          threadId: l0,
        });
        yield* worker.drain();

        const afterArchive = yield* store.getById(pendingReqId);
        assert.isTrue(Option.isSome(afterArchive));
        if (Option.isSome(afterArchive)) {
          assert.equal(afterArchive.value.status, "cancelled");
        }

        // New escalation against archived L0 returns explicit root_archived error.
        const archivedError = yield* service
          .createHumanDraft({
            sourceThreadId: l1,
            task: "Escalate after archive",
          })
          .pipe(Effect.flip);
        assert.equal(archivedError.reason, "root_archived");

        // Delete L0 -> escalating returns root_deleted.
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd:esc2:delete-l0"),
          threadId: l0,
        });
        const deletedError = yield* service
          .createHumanDraft({
            sourceThreadId: l1,
            task: "Escalate after delete",
          })
          .pipe(Effect.flip);
        assert.equal(deletedError.reason, "root_deleted");

        // Scenario #4 & #6 race: concurrent createHumanDraft + thread.archive(L0b) must complete without deadlock and leave consistent state.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:esc2:create-l0b"),
          threadId: l0b,
          projectId,
          title: "Root B",
          modelSelection: env.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:esc2:fork-l1b"),
          sourceThreadId: l0b,
          targetThreadId: l1b,
          subtask: true,
          title: "L1 B",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        const raceReqId = SubtaskEscalationRequestId.make("esc:req:race-1");
        const [escExit, archiveExit] = yield* Effect.all(
          [
            service
              .createHumanDraft({
                requestId: raceReqId,
                sourceThreadId: l1b,
                task: "Concurrent escalation during archive",
              })
              .pipe(Effect.exit),
            orchestrator
              .dispatch({
                type: "thread.archive",
                commandId: CommandId.make("cmd:esc2:race-archive-l0b"),
                threadId: l0b,
              })
              .pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        );

        // Archive always succeeds (no running descendants).
        assert.isTrue(Exit.isSuccess(archiveExit));
        const rootBProj = yield* orchestrator.getThreadProjection(l0b);
        assert.isNotNull(rootBProj.thread.archivedAt);
        // Escalation either succeeded before archive (so the created sibling was also cascaded-archived) OR failed cleanly with root_archived.
        if (Exit.isSuccess(escExit)) {
          const siblingProj = yield* orchestrator.getThreadProjection(escExit.value.childThreadId);
          assert.isNotNull(siblingProj.thread.archivedAt);
        } else {
          assert.include(String(escExit.cause), "root_archived");
        }
      }).pipe(Effect.provide(env.layer));
    },
  );
});

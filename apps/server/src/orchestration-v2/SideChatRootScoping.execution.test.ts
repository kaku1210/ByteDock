import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

function makeControlledAdapterLayer(input: { readonly capturedTurns: Array<CapturedTurn> }) {
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
              input.capturedTurns.push({
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

  return {
    driver,
    instanceId,
    modelSelection,
    layer: ProviderReplayHarness.layerWithRegistry(
      { name: "side-chat-root-scoping" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
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

describe("Root-scoped Side Chat decoupling (Acceptance Scenario 4)", () => {
  it.effect(
    "attaches Side Chats from L1/L2 to rootThreadId with sourceAnchor, digests from L1/L2, brings back to L0, blocks nesting, and cascades only with L0 deletion",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const controlled = makeControlledAdapterLayer({ capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

        const projectId = ProjectId.make("project-sidechat-root");
        const l0Id = ThreadId.make("thread-l0-root");
        const l1Id = ThreadId.make("thread-l1-subtask");
        const l2Id = ThreadId.make("thread-l2-subtask");
        const sideFromL1Id = ThreadId.make("thread-side-from-l1");
        const sideFromL2Id = ThreadId.make("thread-side-from-l2");

        // 1. Create L0 and complete an initial run.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-create-l0"),
          threadId: l0Id,
          projectId,
          title: "Root L0",
          modelSelection: controlled.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd-l0-msg-1"),
          threadId: l0Id,
          messageId: MessageId.make("msg-l0-1"),
          text: "Root goal: refactor auth",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection: controlled.modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Proj1 = yield* orchestrator.getThreadProjection(l0Id);
        const l0Run1Id = l0Proj1.runs.at(-1)!.id;
        yield* completeRun({
          threadId: l0Id,
          runId: l0Run1Id,
          replyText: "L0_ROOT_PLAN: split token validation",
        });

        // 2. Create L1 subtask under L0 and complete a run on L1.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd-fork-l1"),
          sourceThreadId: l0Id,
          targetThreadId: l1Id,
          sourcePoint: { type: "latest_stable" },
          title: "L1 Subtask",
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd-l1-msg-1"),
          threadId: l1Id,
          messageId: MessageId.make("msg-l1-1"),
          text: "Investigate JWT leeway bug",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection: controlled.modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l1Proj1 = yield* orchestrator.getThreadProjection(l1Id);
        const l1Run1Id = l1Proj1.runs.at(-1)!.id;
        yield* completeRun({
          threadId: l1Id,
          runId: l1Run1Id,
          replyText: "L1_UNIQUE_FINDING: clock skew exceeds 30s",
        });

        // 3. Create L2 subtask under L1 and complete a run on L2.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd-fork-l2"),
          sourceThreadId: l1Id,
          targetThreadId: l2Id,
          sourcePoint: { type: "latest_stable" },
          title: "L2 Subtask",
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd-l2-msg-1"),
          threadId: l2Id,
          messageId: MessageId.make("msg-l2-1"),
          text: "Check NTP drift in CI",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection: controlled.modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l2Proj1 = yield* orchestrator.getThreadProjection(l2Id);
        const l2Run1Id = l2Proj1.runs.at(-1)!.id;
        yield* completeRun({
          threadId: l2Id,
          runId: l2Run1Id,
          replyText: "L2_UNIQUE_FINDING: CI runner drifts by 45s",
        });

        // 4. Open Side Chat from L1 and from L2.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd-side-from-l1"),
          sourceThreadId: l1Id,
          targetThreadId: sideFromL1Id,
          sourcePoint: { type: "latest_stable" },
          title: "Side from L1",
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd-side-from-l2"),
          sourceThreadId: l2Id,
          targetThreadId: sideFromL2Id,
          sourcePoint: { type: "latest_stable" },
          title: "Side from L2",
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });

        const sideFromL1Proj = yield* orchestrator.getThreadProjection(sideFromL1Id);
        assert.equal(sideFromL1Proj.thread.lineage.sideChat, true);
        assert.equal(sideFromL1Proj.thread.lineage.parentThreadId, l0Id);
        assert.equal(sideFromL1Proj.thread.lineage.rootThreadId, l0Id);
        assert.equal(sideFromL1Proj.thread.sourceAnchor?.sourceThreadId, l1Id);
        assert.equal(sideFromL1Proj.thread.sourceAnchor?.sourceRunId, l1Run1Id);

        const sideFromL2Proj = yield* orchestrator.getThreadProjection(sideFromL2Id);
        assert.equal(sideFromL2Proj.thread.lineage.sideChat, true);
        assert.equal(sideFromL2Proj.thread.lineage.parentThreadId, l0Id);
        assert.equal(sideFromL2Proj.thread.lineage.rootThreadId, l0Id);
        assert.equal(sideFromL2Proj.thread.sourceAnchor?.sourceThreadId, l2Id);
        assert.equal(sideFromL2Proj.thread.sourceAnchor?.sourceRunId, l2Run1Id);

        const errorText = (error: unknown): string => {
          const cause =
            typeof error === "object" && error !== null && "cause" in error
              ? (error as { readonly cause?: unknown }).cause
              : undefined;
          return cause !== undefined ? `${String(error)} ${errorText(cause)}` : String(error);
        };

        // 5. Nested Side Chat and subtask inside Side Chat are both forbidden.
        const nestedSideError = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("cmd-nested-side"),
            sourceThreadId: sideFromL1Id,
            targetThreadId: ThreadId.make("thread-nested-side"),
            sourcePoint: { type: "latest_stable" },
            title: "Nested side",
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.include(errorText(nestedSideError), "A side chat cannot start another side chat.");

        const subtaskInSideError = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("cmd-subtask-in-side"),
            sourceThreadId: sideFromL1Id,
            targetThreadId: ThreadId.make("thread-subtask-in-side"),
            sourcePoint: { type: "latest_stable" },
            title: "Subtask in side",
            subtask: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.include(errorText(subtaskInSideError), "cannot create child tasks");

        // 6. Send first message in Side Chat opened from L1 -> verify digest carries L1 context.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd-side-msg-1"),
          threadId: sideFromL1Id,
          messageId: MessageId.make("msg-side-1"),
          text: "Should we raise leeway to 60s?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection: controlled.modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const sideProj1 = yield* orchestrator.getThreadProjection(sideFromL1Id);
        const sideRun1Id = sideProj1.runs.at(-1)!.id;
        const sideFirstTurn = capturedTurns.find((turn) => turn.runId === sideRun1Id);
        assert.isDefined(sideFirstTurn);
        assert.include(sideFirstTurn.text, "L1_UNIQUE_FINDING: clock skew exceeds 30s");

        yield* completeRun({
          threadId: sideFromL1Id,
          runId: sideRun1Id,
          replyText: "SIDE_CONCLUSION: yes, bump leeway to 60s",
        });

        // 7. Bring back targeting L1 is rejected; targeting L0 succeeds and delivers into L0.
        const badMergeBack = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            commandId: CommandId.make("cmd-merge-to-l1"),
            sourceThreadId: sideFromL1Id,
            targetThreadId: l1Id,
            sourcePoint: { type: "run", runId: sideRun1Id },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.include(
          errorText(badMergeBack),
          `not a child fork, subtask, or subagent of ${l1Id}`,
        );

        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd-merge-to-l0"),
          sourceThreadId: sideFromL1Id,
          targetThreadId: l0Id,
          sourcePoint: { type: "run", runId: sideRun1Id },
          createdBy: "user",
          creationSource: "web",
        });

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd-l0-msg-2"),
          threadId: l0Id,
          messageId: MessageId.make("msg-l0-2"),
          text: "Apply side chat conclusion",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection: controlled.modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Proj2 = yield* orchestrator.getThreadProjection(l0Id);
        const l0Run2Id = l0Proj2.runs.at(-1)!.id;
        const l0Turn2 = capturedTurns.find((turn) => turn.runId === l0Run2Id);
        assert.isDefined(l0Turn2);
        assert.include(l0Turn2.text, "SIDE_CONCLUSION: yes, bump leeway to 60s");
        yield* completeRun({
          threadId: l0Id,
          runId: l0Run2Id,
          replyText: "Applied 60s leeway",
        });

        // 8. Deleting L1 leaves root-scoped Side Chat alive; deleting L0 cascades to Side Chats.
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete-l1"),
          threadId: l1Id,
        });
        yield* worker.drain();
        const sideAfterL1Delete = yield* orchestrator.getThreadProjection(sideFromL1Id);
        assert.isNull(sideAfterL1Delete.thread.deletedAt);

        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete-l0"),
          threadId: l0Id,
        });
        yield* worker.drain();
        const side1AfterL0Delete = yield* orchestrator.getThreadProjection(sideFromL1Id);
        const side2AfterL0Delete = yield* orchestrator.getThreadProjection(sideFromL2Id);
        assert.isNotNull(side1AfterL0Delete.thread.deletedAt);
        assert.isNotNull(side2AfterL0Delete.thread.deletedAt);
      }).pipe(Effect.provide(controlled.layer));
    },
  );
});

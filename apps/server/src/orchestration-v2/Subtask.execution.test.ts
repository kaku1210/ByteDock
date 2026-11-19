import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

describe("Subtask execution lifecycle (Acceptance Scenario 1)", () => {
  it.effect(
    "creates idempotent persistent subtask drafts, lazily injects cutoff-anchored skeleton without native fork, and enforces L2 depth cap",
    () => {
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make(driver);
      const modelSelection = { instanceId, model: "test-model" };
      let forkCalls = 0;
      const startedTurns: Array<{
        readonly threadId: ThreadId;
        readonly text: string;
      }> = [];

      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: ({ providerSessionId }) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId,
              providerSession: {
                id: providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: "/tmp/subtask-acceptance-1",
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: ({ threadId, existingProviderThread }) =>
                Effect.succeed({
                  ...existingProviderThread!,
                  appThreadId: threadId,
                  nativeThreadRef: {
                    driver,
                    nativeId: `native:${threadId}`,
                    strength: "strong",
                  },
                  status: "idle",
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.sync(() => {
                  startedTurns.push({
                    threadId: turn.threadId,
                    text: turn.message.text,
                  });
                }),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: ({ sourceProviderThread, targetThreadId }) => {
                forkCalls += 1;
                return Effect.succeed({
                  ...sourceProviderThread,
                  appThreadId: targetThreadId,
                  nativeThreadRef: {
                    driver,
                    nativeId: "unexpected-native-fork",
                    strength: "strong",
                  },
                  updatedAt: now,
                });
              },
            } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      };

      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "subtask-acceptance-1" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const now = yield* DateTime.now;

        const rootId = ThreadId.make("subtask-l0");
        const l1Id = ThreadId.make("subtask-l1");
        const l2Id = ThreadId.make("subtask-l2");
        const l3Id = ThreadId.make("subtask-l3");
        const rootProviderThreadId = ProviderThreadId.make("pt:root");
        const run1Id = RunId.make("run:root-1");
        const run2Id = RunId.make("run:root-2");
        const msg1Id = MessageId.make("msg:root-1");
        const msg2Id = MessageId.make("msg:root-2");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:root-create"),
          threadId: rootId,
          projectId: ProjectId.make("proj:subtask"),
          title: "Architecture redesign",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        // Write completed Turn 1 on L0 with a strong native thread (would trigger native_fork on regular fork).
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("ev:root-pt"),
              type: "provider-thread.updated",
              threadId: rootId,
              occurredAt: now,
              payload: {
                id: rootProviderThreadId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: rootId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:root", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:root-run-1"),
              type: "run.created",
              threadId: rootId,
              runId: run1Id,
              occurredAt: now,
              payload: {
                id: run1Id,
                threadId: rootId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: rootProviderThreadId,
                userMessageId: msg1Id,
                rootNodeId: null,
                activeAttemptId: null,
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
              id: EventId.make("ev:root-item-1"),
              type: "turn-item.updated",
              threadId: rootId,
              runId: run1Id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("item:root-1"),
                threadId: rootId,
                runId: run1Id,
                nodeId: null,
                providerThreadId: rootProviderThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId: msg1Id,
                text: "TURN_1_CUTOFF_DECISION: migrate index to parentThreadId",
                attachments: [],
              },
            },
          ],
        });

        // Split L1 from L0 anchored at Turn 1 with client idempotency commandId.
        const splitCommand = {
          type: "thread.fork" as const,
          commandId: CommandId.make("cmd:split-l1-idempotent"),
          sourceThreadId: rootId,
          targetThreadId: l1Id,
          sourcePoint: { type: "run" as const, runId: run1Id },
          subtask: true,
          sourceAnchor: {
            sourceThreadId: rootId,
            sourceRunId: run1Id,
            sourceMessageId: msg1Id,
            excerpt: "migrate index to parentThreadId",
          },
          createdBy: "user" as const,
          creationSource: "web" as const,
        };
        const firstSplit = yield* orchestrator.dispatch(splitCommand);
        assert.isUndefined(firstSplit.replayed);

        // Simulate disconnect retry with the exact same commandId -> idempotent replay!
        const retriedSplit = yield* orchestrator.dispatch(splitCommand);
        assert.isTrue(retriedSplit.replayed);

        // Before user sends first turn: 0 provider starts, 0 native forks, sourceAnchor preserved.
        yield* worker.drain();
        assert.equal(startedTurns.length, 0);
        assert.equal(forkCalls, 0);
        const l1Draft = yield* orchestrator.getThreadProjection(l1Id);
        assert.equal(l1Draft.thread.lineage.relationshipToParent, "subtask");
        assert.equal(l1Draft.thread.lineage.parentThreadId, rootId);
        assert.equal(l1Draft.thread.lineage.rootThreadId, rootId);
        assert.isNull(l1Draft.thread.forkedFrom);
        assert.equal(l1Draft.thread.sourceAnchor?.excerpt, "migrate index to parentThreadId");
        assert.lengthOf(l1Draft.runs, 0);

        // L0 advances with Turn 2 AFTER L1 was split; this must NOT drift into L1's skeleton.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("ev:root-run-2"),
              type: "run.created",
              threadId: rootId,
              runId: run2Id,
              occurredAt: now,
              payload: {
                id: run2Id,
                threadId: rootId,
                ordinal: 2,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: rootProviderThreadId,
                userMessageId: msg2Id,
                rootNodeId: null,
                activeAttemptId: null,
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
              id: EventId.make("ev:root-item-2"),
              type: "turn-item.updated",
              threadId: rootId,
              runId: run2Id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("item:root-2"),
                threadId: rootId,
                runId: run2Id,
                nodeId: null,
                providerThreadId: rootProviderThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId: msg2Id,
                text: "TURN_2_LATER_DRIFT_SHOULD_NOT_APPEAR",
                attachments: [],
              },
            },
          ],
        });

        // User confirms and sends first message in L1.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:l1-first-send"),
          threadId: l1Id,
          messageId: MessageId.make("msg:l1-1"),
          text: "Implement the SQLite parent index migration",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

        for (let step = 0; step < 3; step += 1) {
          yield* worker.drain();
          yield* TestClock.adjust("1 second");
        }
        const l1AfterSend = yield* orchestrator.getThreadProjection(l1Id);
        assert.deepEqual(
          l1AfterSend.turnItems.flatMap((item) =>
            item.type === "error" ? [JSON.stringify(item)] : [],
          ),
          [],
        );
        assert.equal(forkCalls, 0);
        assert.equal(
          startedTurns.length,
          1,
          `runs=${JSON.stringify(l1AfterSend.runs.map((r) => ({ id: r.id, status: r.status })))}`,
        );
        const deliveredPrompt = startedTurns[0]!.text;
        assert.include(deliveredPrompt, "dedicated subtask branched from parent thread");
        assert.notInclude(deliveredPrompt, "do not continue or redo the main thread's task");
        assert.include(deliveredPrompt, "Selected excerpt: migrate index to parentThreadId");
        assert.include(deliveredPrompt, "TURN_1_CUTOFF_DECISION: migrate index to parentThreadId");
        assert.notInclude(deliveredPrompt, "TURN_2_LATER_DRIFT_SHOULD_NOT_APPEAR");
        assert.include(deliveredPrompt, `t3_thread_read({ threadId: "${rootId}"`);
        assert.include(deliveredPrompt, "Implement the SQLite parent index migration");

        assert.equal(l1AfterSend.contextTransfers[0]?.status, "consumed");
        assert.equal(l1AfterSend.contextHandoffs[0]?.delivery?.status, "inline");

        // Mixed L0 -> L1 -> L2 creation succeeds; L3 is hard rejected by server.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:split-l2"),
          sourceThreadId: l1Id,
          targetThreadId: l2Id,
          sourcePoint: { type: "latest_stable" },
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        const l2Projection = yield* orchestrator.getThreadProjection(l2Id);
        assert.equal(l2Projection.thread.lineage.relationshipToParent, "subtask");
        assert.equal(l2Projection.thread.lineage.parentThreadId, l1Id);
        assert.equal(l2Projection.thread.lineage.rootThreadId, rootId);

        const l3Exit = yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("cmd:split-l3-rejected"),
            sourceThreadId: l2Id,
            targetThreadId: l3Id,
            sourcePoint: { type: "latest_stable" },
            subtask: true,
            createdBy: "user",
            creationSource: "web",
          }),
        );
        assert.isTrue(Exit.isFailure(l3Exit));
      }).pipe(Effect.provide(layer));
    },
  );
});

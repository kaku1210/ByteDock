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
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  SubtaskSummaryGenerationInput,
  SubtaskSummaryGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SubtaskSummaryCache from "../persistence/SubtaskSummaryCache.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SubtaskSummaryCacheService from "./SubtaskSummaryCacheService.ts";
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

        // Creating an L2 subtask from an AI-delegated L1 (relationshipToParent: "subagent") also succeeds,
        // and attempting L3 from that L2 is hard rejected.
        const aiL1Id = ThreadId.make("subtask-ai-l1");
        const aiL1ProviderThreadId = ProviderThreadId.make("pt:ai-l1");
        const aiL2Id = ThreadId.make("subtask-ai-l2");
        const aiL3Id = ThreadId.make("subtask-ai-l3");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("ev:ai-l1-thread"),
              type: "thread.created",
              threadId: aiL1Id,
              occurredAt: now,
              payload: {
                id: aiL1Id,
                projectId: ProjectId.make("proj:subtask"),
                title: "AI Delegated L1",
                providerInstanceId: instanceId,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                activeProviderThreadId: aiL1ProviderThreadId,
                lineage: {
                  parentThreadId: rootId,
                  relationshipToParent: "subagent",
                  rootThreadId: rootId,
                },
                forkedFrom: null,
                createdBy: "agent",
                creationSource: "mcp",
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                snoozedUntil: null,
                snoozedAt: null,
                deletedAt: null,
              },
            },
          ],
        });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:split-l2-from-ai-l1"),
          sourceThreadId: aiL1Id,
          targetThreadId: aiL2Id,
          sourcePoint: { type: "latest_stable" },
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        const aiL2Projection = yield* orchestrator.getThreadProjection(aiL2Id);
        assert.equal(aiL2Projection.thread.lineage.relationshipToParent, "subtask");
        assert.equal(aiL2Projection.thread.lineage.parentThreadId, aiL1Id);
        assert.equal(aiL2Projection.thread.lineage.rootThreadId, rootId);

        const aiL3Exit = yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("cmd:split-l3-from-ai-l2-rejected"),
            sourceThreadId: aiL2Id,
            targetThreadId: aiL3Id,
            sourcePoint: { type: "latest_stable" },
            subtask: true,
            createdBy: "user",
            creationSource: "web",
          }),
        );
        assert.isTrue(Exit.isFailure(aiL3Exit));
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("Subtask cached semantic summary end-to-end & deletion cleanup (P3-A3)", () => {
  const makeStubAdapter = (
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    model: string,
    startedTurns: Array<{ readonly threadId: ThreadId; readonly text: string }>,
  ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
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
            cwd: "/tmp/subtask-semantic-e2e",
            model,
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
          forkThread: () => Effect.die("subtask must never invoke native forkThread"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });

  it.effect(
    "injects cached semantic summary into subtask turns, reuses SQLite cache across siblings, and clears cache on parent thread deletion",
    () => {
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make(driver);
      const modelSelection = { instanceId, model: "test-model" };
      const startedTurns: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];
      let summaryCalls = 0;

      const adapter = makeStubAdapter(driver, instanceId, modelSelection.model, startedTurns);
      const textGenerationLayer = Layer.mock(TextGeneration.TextGeneration)({
        generateSubtaskSummary: (_input: SubtaskSummaryGenerationInput) => {
          summaryCalls += 1;
          return Effect.succeed({
            goal: "Migrate SQLite parent index safely",
            constraints: ["Do not drop existing rows", "Keep fork cutoff immutable"],
            decisions: ["Composite PK with content_digest for subtask_summary_cache"],
            openQuestions: ["Add background prune worker later"],
            keyAnchors: ["run=run:e2e-root-1", "item=item:e2e-root-1"],
            summary:
              "Parent locked migration plan and cutoff semantics before splitting parallel subtasks.",
          } satisfies SubtaskSummaryGenerationResult);
        },
      });

      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "subtask-semantic-e2e-cache" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { textGenerationLayer },
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const cacheRepo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
        const now = yield* DateTime.now;

        const rootId = ThreadId.make("semantic-e2e-l0");
        const l1aId = ThreadId.make("semantic-e2e-l1a");
        const l1bId = ThreadId.make("semantic-e2e-l1b");
        const rootProviderThreadId = ProviderThreadId.make("pt:e2e-root");
        const run1Id = RunId.make("run:e2e-root-1");
        const run2Id = RunId.make("run:e2e-root-2");
        const msg1Id = MessageId.make("msg:e2e-root-1");
        const msg2Id = MessageId.make("msg:e2e-root-2");
        const item1Id = TurnItemId.make("item:e2e-root-1");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:e2e-root-create"),
          threadId: rootId,
          projectId: ProjectId.make("proj:e2e-semantic"),
          title: "Parent migration thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        const turn1Item = {
          id: item1Id,
          threadId: rootId,
          runId: run1Id,
          nodeId: null,
          providerThreadId: rootProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
          inputIntent: "turn_start" as const,
          messageId: msg1Id,
          text: "TURN_1_SEMANTIC_SOURCE: migrate parentThreadId index cleanly",
          attachments: [],
        };

        yield* eventSink.write({
          events: [
            {
              id: EventId.make("ev:e2e-root-pt"),
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
                nativeThreadRef: { driver, nativeId: "native:e2e-root", strength: "strong" },
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
              id: EventId.make("ev:e2e-root-run-1"),
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
              id: EventId.make("ev:e2e-root-item-1"),
              type: "turn-item.updated",
              threadId: rootId,
              runId: run1Id,
              occurredAt: now,
              payload: turn1Item,
            },
          ],
        });

        const sharedAnchor = {
          sourceThreadId: rootId,
          sourceRunId: run1Id,
          sourceOrdinal: 1,
          sourceMessageId: msg1Id,
          sourceTurnItemId: item1Id,
          excerpt: "migrate parentThreadId index cleanly",
        };

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:e2e-fork-l1a"),
          sourceThreadId: rootId,
          targetThreadId: l1aId,
          sourcePoint: { type: "run", runId: run1Id },
          subtask: true,
          sourceAnchor: sharedAnchor,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:e2e-fork-l1b"),
          sourceThreadId: rootId,
          targetThreadId: l1bId,
          sourcePoint: { type: "run", runId: run1Id },
          subtask: true,
          sourceAnchor: sharedAnchor,
          createdBy: "user",
          creationSource: "web",
        });

        // First subtask generates and persists semantic summary.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:e2e-l1a-send"),
          threadId: l1aId,
          messageId: MessageId.make("msg:e2e-l1a-1"),
          text: "Write migration 099",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        for (let step = 0; step < 3; step += 1) {
          yield* worker.drain();
          yield* TestClock.adjust("1 second");
        }

        assert.equal(summaryCalls, 1);
        assert.equal(startedTurns.length, 1);
        const promptA = startedTurns[0]!.text;
        assert.include(promptA, "Context summary mode: semantic (llm-summary-v1, generated");
        assert.include(promptA, "Goal: Migrate SQLite parent index safely");
        assert.include(promptA, "Constraints:\n- Do not drop existing rows");
        assert.include(
          promptA,
          "Decisions:\n- Composite PK with content_digest for subtask_summary_cache",
        );
        assert.include(promptA, `t3_thread_read({ threadId: "${rootId}", view: "activity" })`);
        assert.include(promptA, `item=${item1Id}`);
        assert.include(promptA, "Write migration 099");

        // Verify cache row exists in SQLite.
        const rootProjection = yield* orchestrator.getThreadProjection(rootId);
        const l1aProjection = yield* orchestrator.getThreadProjection(l1aId);
        const expectedCacheKey = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
          parentThreadId: rootId,
          parentTitle: rootProjection.thread.title,
          parentGoal: null,
          sourceAnchor: l1aProjection.thread.sourceAnchor,
          coveredRunOrdinals: { from: 1, to: 1 },
          parentItems: rootProjection.turnItems,
          maxSummaryChars: 8_000,
        });
        assert.isTrue(
          Option.isSome(yield* cacheRepo.get(expectedCacheKey)),
          `expected cached row for key=${JSON.stringify(expectedCacheKey)}`,
        );

        // Parent advances with Turn 2 AFTER fork; sibling L1-B at Turn 1 hits cache without drift.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("ev:e2e-root-run-2"),
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
              id: EventId.make("ev:e2e-root-item-2"),
              type: "turn-item.updated",
              threadId: rootId,
              runId: run2Id,
              occurredAt: now,
              payload: {
                ...turn1Item,
                id: TurnItemId.make("item:e2e-root-2"),
                runId: run2Id,
                ordinal: 2,
                messageId: msg2Id,
                text: "TURN_2_LATER_DRIFT_MUST_NOT_LEAK",
              },
            },
          ],
        });

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:e2e-l1b-send"),
          threadId: l1bId,
          messageId: MessageId.make("msg:e2e-l1b-1"),
          text: "Write unit tests for cache invalidation",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        for (let step = 0; step < 3; step += 1) {
          yield* worker.drain();
          yield* TestClock.adjust("1 second");
        }

        assert.equal(summaryCalls, 1);
        assert.equal(startedTurns.length, 2);
        const promptB = startedTurns[1]!.text;
        assert.include(promptB, "Context summary mode: semantic (llm-summary-v1, cache_hit");
        assert.include(promptB, "Goal: Migrate SQLite parent index safely");
        assert.notInclude(promptB, "TURN_2_LATER_DRIFT_MUST_NOT_LEAK");
        assert.include(promptB, `t3_thread_read({ threadId: "${rootId}", view: "activity" })`);

        // Deleting parent thread invalidates cached summaries for the parent (and cascaded descendants).
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd:e2e-delete-root"),
          threadId: rootId,
        });
        assert.isTrue(Option.isNone(yield* cacheRepo.get(expectedCacheKey)));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "degrades end-to-end to MVP skeleton with explicit fallback reason and t3_thread_read anchor when summary model fails",
    () => {
      const driver = ProviderDriverKind.make("codex");
      const instanceId = ProviderInstanceId.make(driver);
      const modelSelection = { instanceId, model: "test-model" };
      const startedTurns: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];

      const adapter = makeStubAdapter(driver, instanceId, modelSelection.model, startedTurns);
      const textGenerationLayer = Layer.mock(TextGeneration.TextGeneration)({
        generateSubtaskSummary: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateSubtaskSummary",
              detail: "Upstream text generation model unavailable.",
            }),
          ),
      });

      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "subtask-semantic-e2e-fallback" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { textGenerationLayer },
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const now = yield* DateTime.now;

        const rootId = ThreadId.make("fallback-e2e-l0");
        const l1Id = ThreadId.make("fallback-e2e-l1");
        const rootProviderThreadId = ProviderThreadId.make("pt:fallback-root");
        const run1Id = RunId.make("run:fallback-root-1");
        const msg1Id = MessageId.make("msg:fallback-root-1");
        const item1Id = TurnItemId.make("item:fallback-root-1");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:fallback-root-create"),
          threadId: rootId,
          projectId: ProjectId.make("proj:e2e-fallback"),
          title: "Fallback parent thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        yield* eventSink.write({
          events: [
            {
              id: EventId.make("ev:fallback-root-pt"),
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
                nativeThreadRef: { driver, nativeId: "native:fallback-root", strength: "strong" },
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
              id: EventId.make("ev:fallback-root-run-1"),
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
              id: EventId.make("ev:fallback-root-item-1"),
              type: "turn-item.updated",
              threadId: rootId,
              runId: run1Id,
              occurredAt: now,
              payload: {
                id: item1Id,
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
                text: "TURN_1_SKELETON_PRESERVED_ON_FAILURE",
                attachments: [],
              },
            },
          ],
        });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:fallback-fork-l1"),
          sourceThreadId: rootId,
          targetThreadId: l1Id,
          sourcePoint: { type: "run", runId: run1Id },
          subtask: true,
          sourceAnchor: {
            sourceThreadId: rootId,
            sourceRunId: run1Id,
            sourceMessageId: msg1Id,
            sourceTurnItemId: item1Id,
          },
          createdBy: "user",
          creationSource: "web",
        });

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:fallback-l1-send"),
          threadId: l1Id,
          messageId: MessageId.make("msg:fallback-l1-1"),
          text: "Proceed even if summary model is offline",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        for (let step = 0; step < 3; step += 1) {
          yield* worker.drain();
          yield* TestClock.adjust("1 second");
        }

        assert.equal(startedTurns.length, 1);
        const delivered = startedTurns[0]!.text;
        assert.include(
          delivered,
          "Context summary fallback: mvp_skeleton (reason=model_unavailable:",
        );
        assert.include(delivered, "TURN_1_SKELETON_PRESERVED_ON_FAILURE");
        assert.include(delivered, `t3_thread_read({ threadId: "${rootId}", view: "activity" })`);
        assert.include(delivered, `item=${item1Id}`);
        assert.include(delivered, "Proceed even if summary model is offline");
      }).pipe(Effect.provide(layer));
    },
  );
});

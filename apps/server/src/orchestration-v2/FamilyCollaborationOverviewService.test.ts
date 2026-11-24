import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  MessageId,
  NodeId,
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
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as FamilyCollaborationOverviewService from "./FamilyCollaborationOverviewService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SharedWorktreeCoordinationService from "./SharedWorktreeCoordinationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

function makeOverviewTestLayer(name: string) {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "model-alpha" };

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
            cwd: `/tmp/${name}`,
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
          forkThread: () => Effect.die(new Error("forkThread not expected")),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          rollbackThread: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };

  const layerDb = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDb, runEffectWorker: false },
  );
  const layerProjection = ProjectionStore.layer.pipe(Layer.provide(layerDb));
  const layerSharedWorktreeMock = Layer.mock(
    SharedWorktreeCoordinationService.SharedWorktreeCoordinationService,
  )({
    getSnapshot: (rootThreadId) =>
      Effect.succeed({
        rootThreadId,
        checkoutPath: `/tmp/${name}`,
        checkoutKey: `/tmp/${name}`,
        policy: {
          checkoutKey: `/tmp/${name}`,
          checkoutPath: `/tmp/${name}`,
          serializationMode: "parallel" as const,
          shellConstraintCoverage: {
            serverEnforcedWorktreeGate: true,
            serverEnforcedWriteReservation: true,
            checkoutWriteSerializationEnabled: false,
            shellGitWorktreeConstraint: "provider_tool_permission" as const,
            summary: "Server enforces worktree approval gate and write reservations.",
          },
          updatedAt: "2026-10-20T00:00:00.000Z",
          updatedBy: null,
        },
        sharedThreadCount: 3,
        threads: [
          {
            threadId: ThreadId.make("thread:collab-l1-active"),
            title: "L1 Active Delegated",
            depth: 1,
            activeRunId: RunId.make("run:collab-l1-active:1"),
            status: "running" as const,
            inFamily: true,
            plannedPaths: [],
            confirmedWritePaths: [
              {
                path: "src/shared.ts",
                normalizedPath: "src/shared.ts",
                oldPath: null,
                oldNormalizedPath: null,
                operation: "modify",
                runId: RunId.make("run:collab-l1-active:1"),
                turnItemId: null,
                source: "turn_item" as const,
                updatedAt: "2026-10-20T00:00:00.000Z",
              },
            ],
            activeReservations: [],
          },
          {
            threadId: ThreadId.make("thread:collab-l2-leaf"),
            title: "L2 Leaf",
            depth: 2,
            activeRunId: null,
            status: "idle" as const,
            inFamily: true,
            plannedPaths: [
              {
                path: "src/shared.ts",
                normalizedPath: "src/shared.ts",
                runId: null,
                note: null,
                declaredAt: "2026-10-20T00:00:00.000Z",
              },
            ],
            confirmedWritePaths: [],
            activeReservations: [],
          },
        ],
        overlaps: [
          {
            normalizedPath: "src/shared.ts",
            kind: "exact" as const,
            severity: "warning" as const,
            participants: [
              {
                threadId: ThreadId.make("thread:collab-l1-active"),
                threadTitle: "L1 Active Delegated",
                runId: RunId.make("run:collab-l1-active:1"),
                layers: ["confirmed_write" as const],
                rawPaths: ["src/shared.ts"],
              },
              {
                threadId: ThreadId.make("thread:collab-l2-leaf"),
                threadTitle: "L2 Leaf",
                runId: null,
                layers: ["planned" as const],
                rawPaths: ["src/shared.ts"],
              },
            ],
            recommendedAction: "Coordinate writes on src/shared.ts.",
          },
        ],
        observedUnverifiedPaths: [
          {
            path: "src/unverified-shell.ts",
            normalizedPath: "src/unverified-shell.ts",
            attribution: "observed_unverified" as const,
            reason: "external_or_unattributed" as const,
            insertions: 3,
            deletions: 1,
          },
        ],
        activeReservations: [],
        waitingReservations: [],
        activeSerializedRun: null,
        waitingSerializedRuns: [],
        restoreSafetyProtected: true,
        generatedAt: "2026-10-20T00:00:00.000Z",
      }),
  });
  const layerOverview = FamilyCollaborationOverviewService.layer.pipe(
    Layer.provide(Layer.mergeAll(layerProjection, layerSharedWorktreeMock)),
  );

  return {
    driver,
    instanceId,
    modelSelection,
    layer: Layer.mergeAll(layerOrchestrator, layerOverview),
  };
}

describe("FamilyCollaborationOverviewService (Phase 2)", () => {
  it.effect(
    "builds L0 -> L1 -> L2 topology with separate session/task/delivery/canStop semantics and stays strictly read-only across overview + summary",
    () => {
      const { driver, instanceId, modelSelection, layer } =
        makeOverviewTestLayer("family-collab-overview");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const overviewService =
          yield* FamilyCollaborationOverviewService.FamilyCollaborationOverviewService;
        const now = yield* DateTime.now;

        const projectId = ProjectId.make("proj:collab-overview");
        const l0Id = ThreadId.make("thread:collab-l0");
        const l1DoneId = ThreadId.make("thread:collab-l1-done");
        const l1ActiveId = ThreadId.make("thread:collab-l1-active");
        const l1PreRunDelegatedId = ThreadId.make("thread:collab-l1-prerun");
        const l1HeldQueueId = ThreadId.make("thread:collab-l1-held");
        const l2LeafId = ThreadId.make("thread:collab-l2-leaf");
        const sideChatId = ThreadId.make("thread:collab-sidechat");

        // Create L0 root with completed turn 1 and active turn 2.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:collab-l0"),
          threadId: l0Id,
          projectId,
          title: "L0 Coordinator",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: "/tmp/family-collab-overview",
          createdBy: "user",
          creationSource: "web",
        });

        const l0PtId = ProviderThreadId.make("pt:collab-l0");
        const l0Run1Id = RunId.make("run:collab-l0:1");
        const l0Run2Id = RunId.make("run:collab-l0:2");
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:l0-pt"),
              type: "provider-thread.updated",
              threadId: l0Id,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: l0PtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: l0Id,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:l0", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 2,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:l0-r1"),
              type: "run.created",
              threadId: l0Id,
              runId: l0Run1Id,
              occurredAt: now,
              payload: {
                id: l0Run1Id,
                threadId: l0Id,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: l0PtId,
                userMessageId: MessageId.make("msg:l0-1"),
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
              id: EventId.make("ev:l0-r2"),
              type: "run.created",
              threadId: l0Id,
              runId: l0Run2Id,
              occurredAt: now,
              payload: {
                id: l0Run2Id,
                threadId: l0Id,
                ordinal: 2,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: l0PtId,
                userMessageId: MessageId.make("msg:l0-2"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "running",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });

        // Create L1-Done (completed AI delegation with unacknowledged completionDelivery + pending merge_back).
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:collab-l1-done"),
          sourceThreadId: l0Id,
          targetThreadId: l1DoneId,
          title: "L1 Done Pending Delivery",
          sourcePoint: { type: "run", runId: l0Run1Id },
          subtask: true,
          createdBy: "agent",
          creationSource: "mcp",
        });
        const l1DonePtId = ProviderThreadId.make("pt:collab-l1-done");
        const l1DoneRun1Id = RunId.make("run:collab-l1-done:1");
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:l1-done-pt"),
              type: "provider-thread.updated",
              threadId: l1DoneId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: l1DonePtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: l1DoneId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:l1-done", strength: "strong" },
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
              id: EventId.make("ev:l1-done-r1"),
              type: "run.created",
              threadId: l1DoneId,
              runId: l1DoneRun1Id,
              occurredAt: now,
              payload: {
                id: l1DoneRun1Id,
                threadId: l1DoneId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: l1DonePtId,
                userMessageId: MessageId.make("msg:l1-done-u1"),
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
              id: EventId.make("ev:l1-done-item"),
              type: "turn-item.updated",
              threadId: l1DoneId,
              runId: l1DoneRun1Id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("item:l1-done-a1"),
                threadId: l1DoneId,
                runId: l1DoneRun1Id,
                nodeId: null,
                providerThreadId: l1DonePtId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId: MessageId.make("msg:l1-done-a1"),
                text: "L1-Done finished audit with 2 findings.",
                streaming: false,
              },
            },
          ],
        });

        // Create L1-Active (running AI delegation) + L2-Leaf under it.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:collab-l1-active"),
          sourceThreadId: l0Id,
          targetThreadId: l1ActiveId,
          title: "L1 Active Delegated",
          sourcePoint: { type: "run", runId: l0Run1Id },
          subtask: true,
          createdBy: "agent",
          creationSource: "mcp",
        });
        const l1ActivePtId = ProviderThreadId.make("pt:collab-l1-active");
        const l1ActiveRun1Id = RunId.make("run:collab-l1-active:1");
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:l1-active-pt"),
              type: "provider-thread.updated",
              threadId: l1ActiveId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: l1ActivePtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: l1ActiveId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:l1-active", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "active",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:l1-active-r1"),
              type: "run.created",
              threadId: l1ActiveId,
              runId: l1ActiveRun1Id,
              occurredAt: now,
              payload: {
                id: l1ActiveRun1Id,
                threadId: l1ActiveId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: l1ActivePtId,
                userMessageId: MessageId.make("msg:l1-active-u1"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "running",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });

        // L2 Leaf forked from L1-Active.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:collab-l2-leaf"),
          sourceThreadId: l1ActiveId,
          targetThreadId: l2LeafId,
          title: "L2 Leaf",
          sourcePoint: { type: "run", runId: l1ActiveRun1Id },
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });

        // L1 Pre-run delegated: subagent is queued on L0, child thread has no runs yet -> canStop must be true.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:collab-l1-prerun"),
          sourceThreadId: l0Id,
          targetThreadId: l1PreRunDelegatedId,
          title: "L1 Pre-Run Delegated",
          sourcePoint: { type: "run", runId: l0Run1Id },
          subtask: true,
          createdBy: "agent",
          creationSource: "mcp",
        });

        // L1 Held Queue: no active run, only a held queued run -> sessionStatus queue_paused, canStop must be false.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:collab-l1-held"),
          sourceThreadId: l0Id,
          targetThreadId: l1HeldQueueId,
          title: "L1 Held Queue",
          sourcePoint: { type: "run", runId: l0Run1Id },
          subtask: true,
          createdBy: "user",
          creationSource: "web",
        });
        const l1HeldRun1Id = RunId.make("run:collab-l1-held:1");
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:l1-held-r1"),
              type: "run.created",
              threadId: l1HeldQueueId,
              runId: l1HeldRun1Id,
              occurredAt: now,
              payload: {
                id: l1HeldRun1Id,
                threadId: l1HeldQueueId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make("msg:l1-held-u1"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "queued",
                queuePosition: 1,
                queueHeld: true,
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });

        // Root-level Side Chat attached to L0.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:collab-sidechat"),
          sourceThreadId: l0Id,
          targetThreadId: sideChatId,
          title: "Root Side Chat",
          sourcePoint: { type: "run", runId: l0Run1Id },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });

        // Attach subagent records on L0 (done w/ pending delivery, running active, queued pre-run).
        const subagentDoneId = NodeId.make("node:delegated-task:l1-done");
        const subagentActiveId = NodeId.make("node:delegated-task:l1-active");
        const subagentPreRunId = NodeId.make("node:delegated-task:l1-prerun");
        const l0RootNodeId = NodeId.make("node:l0:root");
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:subagent-done"),
              type: "subagent.updated",
              threadId: l0Id,
              runId: l0Run2Id,
              nodeId: subagentDoneId,
              driver,
              occurredAt: now,
              payload: {
                id: subagentDoneId,
                threadId: l0Id,
                runId: l0Run2Id,
                parentNodeId: l0RootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: l1DonePtId,
                childThreadId: l1DoneId,
                nativeTaskRef: null,
                model: modelSelection.model,
                modelSelection,
                prompt: "Audit L1 done",
                title: "L1 Done Pending Delivery",
                completionWake: "always",
                completionDelivery: { state: "pending", observedByRunId: null },
                status: "completed",
                result: "L1-Done finished audit with 2 findings.",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:subagent-active"),
              type: "subagent.updated",
              threadId: l0Id,
              runId: l0Run2Id,
              nodeId: subagentActiveId,
              driver,
              occurredAt: now,
              payload: {
                id: subagentActiveId,
                threadId: l0Id,
                runId: l0Run2Id,
                parentNodeId: l0RootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: l1ActivePtId,
                childThreadId: l1ActiveId,
                nativeTaskRef: null,
                model: modelSelection.model,
                modelSelection,
                prompt: "Active L1 delegation",
                title: "L1 Active Delegated",
                completionWake: "always",
                status: "running",
                result: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:subagent-prerun"),
              type: "subagent.updated",
              threadId: l0Id,
              runId: l0Run2Id,
              nodeId: subagentPreRunId,
              driver,
              occurredAt: now,
              payload: {
                id: subagentPreRunId,
                threadId: l0Id,
                runId: l0Run2Id,
                parentNodeId: l0RootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: null,
                childThreadId: l1PreRunDelegatedId,
                nativeTaskRef: null,
                model: modelSelection.model,
                modelSelection,
                prompt: "Queued pre-run delegation",
                title: "L1 Pre-Run Delegated",
                completionWake: "always",
                status: "pending",
                result: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              },
            },
          ],
        });

        // Create a pending passive merge_back from L1-Done to L0.
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:collab-merge-back-l1-done"),
          sourceThreadId: l1DoneId,
          targetThreadId: l0Id,
          sourcePoint: { type: "run", runId: l1DoneRun1Id },
          createdBy: "user",
          creationSource: "web",
        });

        // Query overview from L2 (proves querying from any depth resolves full family rooted at L0)
        // AND request dynamic summary.
        const overviewFromL2 = yield* overviewService.getOverview({
          threadId: l2LeafId,
          includeSummary: true,
        });
        assert.isTrue(overviewFromL2.readOnlyGuaranteed);
        assert.equal(overviewFromL2.rootThreadId, l0Id);
        assert.equal(overviewFromL2.requestedThreadId, l2LeafId);
        assert.equal(overviewFromL2.nodes.length, 6);
        assert.equal(overviewFromL2.sideChats.length, 1);
        assert.equal(overviewFromL2.sideChats[0]?.threadId, sideChatId);

        const byId = new Map(overviewFromL2.nodes.map((node) => [node.threadId, node] as const));
        assert.isTrue(byId.get(l2LeafId)?.isCurrentThread);
        assert.equal(byId.get(l2LeafId)?.depth, 2);
        assert.equal(byId.get(l2LeafId)?.parentThreadId, l1ActiveId);
        assert.equal(byId.get(l2LeafId)?.sessionStatus, "awaiting_initial_send");
        assert.isFalse(byId.get(l2LeafId)?.canStop);

        // L1 Done: idle session, completed task, pending delivery + pending merge-back, not stoppable.
        // resolveDeliveryStatus prioritizes pending_merge_back over pending_auto_wake when both exist.
        const doneNode = byId.get(l1DoneId)!;
        assert.equal(doneNode.sessionStatus, "idle");
        assert.equal(doneNode.taskStatus, "completed");
        assert.equal(doneNode.deliveryStatus, "pending_merge_back");
        assert.equal(doneNode.delegatedDeliveryState, "pending");
        assert.equal(doneNode.pendingMergeBackCount, 1);
        assert.isFalse(doneNode.canStop);

        // L1 Active: running session + task + stoppable + shared worktree overlap attribution.
        const activeNode = byId.get(l1ActiveId)!;
        assert.equal(activeNode.sessionStatus, "running");
        assert.equal(activeNode.taskStatus, "running");
        assert.isTrue(activeNode.canStop);
        assert.isTrue(activeNode.hasPathOverlap);
        assert.deepEqual(activeNode.confirmedWritePaths, ["src/shared.ts"]);

        // L1 Pre-Run Delegated: child thread has no runs yet, but delegated subagent is queued -> canStop MUST be true.
        const preRunNode = byId.get(l1PreRunDelegatedId)!;
        assert.isNull(preRunNode.activeRunId);
        assert.equal(preRunNode.queuedMessageCount, 0);
        assert.equal(preRunNode.delegatedTaskId, subagentPreRunId);
        assert.equal(preRunNode.taskStatus, "queued");
        assert.isTrue(preRunNode.canStop);

        // L1 Held Queue: only a held queued run -> queue_paused, canStop MUST be false.
        const heldNode = byId.get(l1HeldQueueId)!;
        assert.equal(heldNode.sessionStatus, "queue_paused");
        assert.equal(heldNode.blockingKind, "queue_paused");
        assert.isFalse(heldNode.canStop);

        // Dynamic summary populated with pending delivery + merge-back + shared worktree warning.
        assert.isNotNull(overviewFromL2.summary);
        assert.equal(overviewFromL2.summary?.pendingDeliveryCount, 1);
        assert.equal(overviewFromL2.summary?.pendingMergeBackCount, 1);
        assert.equal(overviewFromL2.summary?.overlapCount, 1);
        assert.equal(overviewFromL2.summary?.observedUnverifiedCount, 1);
        assert.include(overviewFromL2.summary?.markdownDigest ?? "", "Observed Unverified=1");
        assert.deepEqual(
          overviewFromL2.sharedWorktree?.observedUnverifiedPaths.map((p) => p.normalizedPath),
          ["src/unverified-shell.ts"],
        );

        // Repeat overview + summary refresh from L0 and assert strictly read-only projection state.
        yield* overviewService.getOverview({ threadId: l0Id, includeSummary: true });

        const l0ProjectionAfter = yield* orchestrator.getThreadProjection(l0Id);
        const subagentAfter = l0ProjectionAfter.subagents.find((s) => s.id === subagentDoneId);
        assert.equal(subagentAfter?.completionDelivery?.state, "pending");
        assert.isNull(subagentAfter?.completionDelivery?.observedByRunId);

        const pendingMergeBacksAfter = l0ProjectionAfter.contextTransfers.filter(
          (t) => t.type === "merge_back" && t.sourceThreadId === l1DoneId,
        );
        assert.equal(pendingMergeBacksAfter.length, 1);
        assert.equal(pendingMergeBacksAfter[0]?.status, "pending");
        assert.isNull(pendingMergeBacksAfter[0]?.targetRunId);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "exposes L0 Coordinator and L1 Sub-Coordinator tier overrides on overview nodes and markdown digest",
    () => {
      const { instanceId, modelSelection, layer } = makeOverviewTestLayer(
        "family-collab-coordinator-digest",
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const overviewService =
          yield* FamilyCollaborationOverviewService.FamilyCollaborationOverviewService;
        const now = yield* DateTime.now;

        const projectId = ProjectId.make("proj:collab-coord");
        const l0Id = ThreadId.make("thread:collab-coord-l0");
        const l1LeadId = ThreadId.make("thread:collab-coord-l1-lead");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:coord-l0"),
          threadId: l0Id,
          projectId,
          title: "Season Production Root",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.coordinator-mode.set",
          commandId: CommandId.make("cmd:coord-l0-mode"),
          threadId: l0Id,
          coordinatorMode: {
            enabled: true,
            templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
            tierModelOverrides: {
              L1: { instanceId, model: "gpt-5.4-mini" },
            },
          },
        });

        const l0Thread = (yield* orchestrator.getThreadProjection(l0Id)).thread;
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:coord-l1-created"),
              type: "thread.created",
              threadId: l1LeadId,
              occurredAt: now,
              payload: {
                ...l0Thread,
                id: l1LeadId,
                title: "Episode 1 Lead",
                createdBy: "agent",
                coordinatorMode: undefined,
                lineage: {
                  parentThreadId: l0Id,
                  relationshipToParent: "subtask",
                  rootThreadId: l0Id,
                },
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "thread.coordinator-mode.set",
          commandId: CommandId.make("cmd:coord-l1-mode"),
          threadId: l1LeadId,
          coordinatorMode: {
            enabled: true,
            templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
            tierModelOverrides: {
              L2: { instanceId, model: "gpt-5.4-nano" },
            },
          },
        });

        const overview = yield* overviewService.getOverview({
          threadId: l0Id,
          includeSummary: true,
        });
        const l0Node = overview.nodes.find((node) => node.threadId === l0Id);
        const l1Node = overview.nodes.find((node) => node.threadId === l1LeadId);

        assert.deepEqual(l0Node?.coordinatorMode, {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L1: { instanceId, model: "gpt-5.4-mini" },
          },
        });
        assert.deepEqual(l1Node?.coordinatorMode, {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L2: { instanceId, model: "gpt-5.4-nano" },
          },
        });

        const digest = overview.summary?.markdownDigest ?? "";
        assert.include(digest, "Coordinators: L0=1, L1 Sub-Coordinators=1");
        assert.include(digest, "[Coordinator:general-batch | overrides: L1=codex/gpt-5.4-mini]");
        assert.include(
          digest,
          "[Sub-Coordinator:general-batch | overrides: L2=codex/gpt-5.4-nano]",
        );
      }).pipe(Effect.provide(layer));
    },
  );
});

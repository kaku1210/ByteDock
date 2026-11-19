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
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

function makeTestLayer(name: string) {
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

  return {
    driver,
    instanceId,
    modelSelection,
    layer: ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
    ),
  };
}

describe("Subtask active reporting & delegation lifecycle (Acceptance Scenarios 2 & 7)", () => {
  it.effect(
    "queues dual child reports on busy/paused parent without interrupting or auto-resuming, deduplicates retries, and follows parent model switch",
    () => {
      const { driver, instanceId, modelSelection, layer } = makeTestLayer(
        "subtask-reporting-scenario-2",
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const projectId = ProjectId.make("project:report-s2");
        const parentId = ThreadId.make("thread:parent-s2");
        const childAId = ThreadId.make("thread:child-a-s2");
        const childBId = ThreadId.make("thread:child-b-s2");
        const parentRunId = RunId.make("run:parent-waiting-s2");
        const parentProviderThreadId = ProviderThreadId.make("pt:parent-s2");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-parent-s2"),
          threadId: parentId,
          projectId,
          title: "Coordinator L0",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        // Put parent in waiting state (e.g., awaiting approval) so incoming child reports must queue without interrupting.
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:parent-pt-s2"),
              type: "provider-thread.updated",
              threadId: parentId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: parentProviderThreadId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: parentId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:parent-s2", strength: "strong" },
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
              id: EventId.make("ev:parent-run-s2"),
              type: "run.created",
              threadId: parentId,
              runId: parentRunId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: parentRunId,
                threadId: parentId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: parentProviderThreadId,
                userMessageId: MessageId.make("msg:parent-initial-s2"),
                rootNodeId: NodeId.make("node:parent-root-s2"),
                activeAttemptId: RunAttemptId.make("att:parent-s2"),
                status: "waiting",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });

        // Create two child subtasks under parent.
        for (const [key, childId] of [
          ["a", childAId],
          ["b", childBId],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`cmd:fork-${key}-s2`),
            sourceThreadId: parentId,
            targetThreadId: childId,
            sourcePoint: { type: "latest_stable" },
            subtask: true,
            title: `Child ${key.toUpperCase()}`,
            createdBy: "user",
            creationSource: "web",
          });
        }

        const runA = RunId.make("run:child-a-final");
        const runB = RunId.make("run:child-b-final");

        // Child A reports final; simulate both same-commandId retry and different-commandId duplicate retry.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:report-a-1"),
          threadId: parentId,
          senderThreadId: childAId,
          childReport: {
            childThreadId: childAId,
            childRunId: runA,
            reportKind: "final",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:report-a-1"),
          text: "Final conclusion from A",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:report-a-1"),
          threadId: parentId,
          senderThreadId: childAId,
          childReport: {
            childThreadId: childAId,
            childRunId: runA,
            reportKind: "final",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:report-a-1"),
          text: "Final conclusion from A",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:report-a-dup-different-cmd"),
          threadId: parentId,
          senderThreadId: childAId,
          childReport: {
            childThreadId: childAId,
            childRunId: runA,
            reportKind: "final",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:report-a-dup-different-cmd"),
          text: "Final conclusion from A (duplicate retry)",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        // Child B reports final.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:report-b-1"),
          threadId: parentId,
          senderThreadId: childBId,
          childReport: {
            childThreadId: childBId,
            childRunId: runB,
            reportKind: "final",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:report-b-1"),
          text: "Final conclusion from B",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        const parentAfterReports = yield* orchestrator.getThreadProjection(parentId);
        // Active waiting run was not interrupted.
        assert.equal(
          parentAfterReports.runs.find((run) => run.id === parentRunId)?.status,
          "waiting",
        );
        // Exactly 2 queued reports in A -> B order (deduplicated!).
        const queuedRuns = parentAfterReports.runs
          .filter((run) => run.status === "queued")
          .toSorted(
            (left, right) =>
              (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
          );
        assert.equal(queuedRuns.length, 2);
        const queuedMessages = queuedRuns.map((run) =>
          parentAfterReports.messages.find((msg) => msg.id === run.userMessageId),
        );
        assert.deepEqual(
          queuedMessages.map((msg) => msg?.text),
          ["Final conclusion from A", "Final conclusion from B"],
        );
        // Both follow parent thread's current model selection when dequeued.
        assert.isTrue(queuedMessages.every((msg) => msg?.followsThreadSelection === true));

        // Now test paused-queue protection (Locked Decision #3):
        const pausedParentId = ThreadId.make("thread:paused-parent-s2");
        const pausedChildId = ThreadId.make("thread:paused-child-s2");
        const heldRunId = RunId.make("run:paused-held-s2");
        const pausedPtId = ProviderThreadId.make("pt:paused-parent-s2");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-paused-parent"),
          threadId: pausedParentId,
          projectId,
          title: "Paused Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:paused-pt"),
              type: "provider-thread.updated",
              threadId: pausedParentId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: pausedPtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: pausedParentId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:paused", strength: "strong" },
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
              id: EventId.make("ev:paused-held-run"),
              type: "run.created",
              threadId: pausedParentId,
              runId: heldRunId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: heldRunId,
                threadId: pausedParentId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: pausedPtId,
                userMessageId: MessageId.make("msg:held-existing"),
                rootNodeId: NodeId.make("node:held-existing"),
                activeAttemptId: RunAttemptId.make("att:held-existing"),
                status: "queued",
                queueHeld: true,
                queuePosition: 1,
                requestedAt: now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:paused-child-report"),
          threadId: pausedParentId,
          senderThreadId: pausedChildId,
          childReport: {
            childThreadId: pausedChildId,
            childRunId: RunId.make("run:paused-child-1"),
            reportKind: "final",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:paused-child-report"),
          text: "Report arriving while parent queue is paused",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        const pausedProjection = yield* orchestrator.getThreadProjection(pausedParentId);
        // Existing held run MUST stay held (NOT auto-released), and incoming child report MUST stay queued + held!
        assert.equal(pausedProjection.runs.length, 2);
        assert.isTrue(
          pausedProjection.runs.every((run) => run.status === "queued" && run.queueHeld === true),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "keeps mid-task human steering and [阶段性进度] interim reports inside open delegation, includes human adjustment note on settlement, and isolates post-settlement human follow-ups",
    () => {
      const { driver, instanceId, modelSelection, layer } = makeTestLayer(
        "subtask-reporting-scenario-7",
      );

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const projectId = ProjectId.make("project:report-s7");
        const parentId = ThreadId.make("thread:parent-s7");
        const childId = ThreadId.make("thread:child-s7");
        const parentRunId = RunId.make("run:parent-s7");
        const parentRootNodeId = NodeId.make("node:parent-root-s7");
        const taskId = NodeId.make("node:delegated-task-s7");
        const parentPtId = ProviderThreadId.make("pt:parent-s7");
        const childPtId = ProviderThreadId.make("pt:child-s7");
        const childRun1Id = RunId.make("run:child-1-s7");

        // Seed parent A with an open delegated task pointing to child AA.
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:create-parent-s7"),
          threadId: parentId,
          projectId,
          title: "Parent A",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:parent-pt-s7"),
              type: "provider-thread.updated",
              threadId: parentId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: parentPtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: parentId,
                ownerNodeId: parentRootNodeId,
                nativeThreadRef: { driver, nativeId: "native:parent-s7", strength: "strong" },
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
              id: EventId.make("ev:parent-run-s7"),
              type: "run.created",
              threadId: parentId,
              runId: parentRunId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: parentRunId,
                threadId: parentId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: parentPtId,
                userMessageId: MessageId.make("msg:parent-run-s7"),
                rootNodeId: parentRootNodeId,
                activeAttemptId: RunAttemptId.make("att:parent-s7"),
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make("ev:parent-subagent-s7"),
              type: "subagent.updated",
              threadId: parentId,
              runId: parentRunId,
              nodeId: taskId,
              driver,
              occurredAt: now,
              payload: {
                id: taskId,
                threadId: parentId,
                runId: parentRunId,
                parentNodeId: parentRootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: childPtId,
                childThreadId: childId,
                nativeTaskRef: null,
                model: modelSelection.model,
                modelSelection,
                prompt: "Original delegated brief",
                title: "Child AA",
                completionWake: "always",
                completionDelivery: { state: "pending", observedByRunId: null },
                status: "running",
                result: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("ev:child-created-s7"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                id: childId,
                projectId,
                title: "Child AA",
                providerInstanceId: instanceId,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                activeProviderThreadId: childPtId,
                lineage: {
                  parentThreadId: parentId,
                  relationshipToParent: "subagent",
                  rootThreadId: parentId,
                },
                forkedFrom: {
                  type: "node",
                  nodeId: taskId,
                },
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
            {
              id: EventId.make("ev:child-pt-s7"),
              type: "provider-thread.updated",
              threadId: childId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: childPtId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: childId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native:child-s7", strength: "strong" },
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
              id: EventId.make("ev:child-run-1-s7"),
              type: "run.created",
              threadId: childId,
              runId: childRun1Id,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: childRun1Id,
                threadId: childId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: childPtId,
                userMessageId: MessageId.make("msg:child-initial-s7"),
                rootNodeId: NodeId.make("node:child-run-1-s7"),
                activeAttemptId: RunAttemptId.make("att:child-run-1-s7"),
                delegatedTaskId: taskId,
                status: "running",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });

        // 1. Human sends mid-task adjustment while delegation is unsettled.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:human-midtask-steer-s7"),
          threadId: childId,
          messageId: MessageId.make("msg:human-midtask-steer-s7"),
          text: "Also include pagination edge cases in the migration",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        const childAfterMidtask = yield* orchestrator.getThreadProjection(childId);
        const adjustedRun = childAfterMidtask.runs.find((run) => run.ordinal === 2);
        assert.isDefined(adjustedRun);
        // Mid-task human adjustment stays bound to the open original delegated task!
        assert.equal(adjustedRun!.delegatedTaskId, taskId);

        // 2. While AA is still running, send an interim progress report to A.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:interim-report-s7"),
          threadId: parentId,
          senderThreadId: childId,
          childReport: {
            childThreadId: childId,
            childRunId: childRun1Id,
            reportKind: "interim",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:interim-report-s7"),
          text: "50% done; applying pagination adjustment now",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });

        const parentAfterInterim = yield* orchestrator.getThreadProjection(parentId);
        const interimMsg = parentAfterInterim.messages.find(
          (msg) => msg.id === MessageId.make("msg:interim-report-s7"),
        );
        assert.isDefined(interimMsg);
        assert.isTrue(interimMsg!.text.startsWith("[阶段性进度]"));
        // Interim report MUST NOT prematurely settle the open delegation!
        assert.isNull(parentAfterInterim.subagents.find((t) => t.id === taskId)?.result);

        // 3. Complete both child runs (run 1 + adjusted run 2) and run delegated recovery to settle.
        const adjustedRunId = adjustedRun!.id;
        yield* sink.write({
          events: [
            {
              id: EventId.make("ev:child-run-1-done"),
              type: "run.updated",
              threadId: childId,
              runId: childRun1Id,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                ...childAfterMidtask.runs.find((r) => r.id === childRun1Id)!,
                status: "completed",
                completedAt: now,
              },
            },
            {
              id: EventId.make("ev:child-run-2-done"),
              type: "run.updated",
              threadId: childId,
              runId: adjustedRunId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                ...adjustedRun!,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("ev:child-run-2-answer"),
              type: "turn-item.updated",
              threadId: childId,
              runId: adjustedRunId,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("ti:child-run-2-answer"),
                threadId: childId,
                runId: adjustedRunId,
                nodeId: adjustedRun!.rootNodeId,
                providerThreadId: childPtId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 10,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId: MessageId.make("msg:child-run-2-answer"),
                text: "Migration and pagination edge cases completed.",
                streaming: false,
              },
            },
          ],
        });

        yield* orchestrator.recoverDelegatedTasks;

        const parentAfterSettle = yield* orchestrator.getThreadProjection(parentId);
        const settledTask = parentAfterSettle.subagents.find((t) => t.id === taskId);
        assert.isDefined(settledTask);
        assert.equal(settledTask!.status, "completed");
        assert.isNotNull(settledTask!.result);
        assert.include(settledTask!.result!, "Migration and pagination edge cases completed.");
        assert.include(settledTask!.result!, "Completed with human mid-task adjustments");
        assert.include(settledTask!.result!, "Also include pagination edge cases in the migration");

        // 4. Duplicate explicit final report for the already-settled run is deduplicated!
        const parentRunCountBeforeDup = parentAfterSettle.runs.length;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:explicit-final-after-settle-dup"),
          threadId: parentId,
          senderThreadId: childId,
          childReport: {
            childThreadId: childId,
            childRunId: adjustedRunId,
            reportKind: "final",
            resultVersion: 0,
          },
          messageId: MessageId.make("msg:explicit-final-after-settle-dup"),
          text: "Duplicate explicit final report",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const parentAfterDup = yield* orchestrator.getThreadProjection(parentId);
        assert.equal(parentAfterDup.runs.length, parentRunCountBeforeDup);

        // 5. Post-settlement human follow-up in AA MUST NOT create a follow-up task or auto-wake A!
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:post-settlement-human-chat-s7"),
          threadId: childId,
          messageId: MessageId.make("msg:post-settlement-human-chat-s7"),
          text: "Human follow-up exploration after delegation settled",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

        const childAfterPostSettle = yield* orchestrator.getThreadProjection(childId);
        const postSettleRun = childAfterPostSettle.runs.find((run) => run.ordinal === 3);
        assert.isDefined(postSettleRun);
        assert.isUndefined(postSettleRun!.delegatedTaskId);

        const parentAfterPostSettle = yield* orchestrator.getThreadProjection(parentId);
        // No new follow-up subagent card was created on parent A!
        assert.equal(parentAfterPostSettle.subagents.length, 1);
      }).pipe(Effect.provide(layer));
    },
  );
});

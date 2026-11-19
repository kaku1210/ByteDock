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
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
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
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}

function makeControlledLayer(input: { readonly capturedTurns: Array<CapturedTurn> }) {
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

  const layerDatabase = SqlitePersistence.layerMemory;
  const base = ProviderReplayHarness.layerWithRegistry(
    { name: "hierarchy-lifecycle-and-guards" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );

  return {
    driver,
    instanceId,
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

describe("Hierarchy lifecycle, parent Stop isolation, cascades, and causationChain guards", () => {
  it.effect(
    "parent Stop cancels bound AI delegated tasks while leaving independent running human subtasks untouched",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeControlledLayer({ capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projectId = ProjectId.make("project:stop-isolation");
        const l0 = ThreadId.make("thread:stop-l0");
        const humanSubtask = ThreadId.make("thread:stop-human-subtask");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:stop:create-l0"),
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
          commandId: CommandId.make("cmd:stop:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:stop:l0-r1"),
          text: "Initial root turn",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run1 = (yield* orchestrator.getThreadProjection(l0)).runs[0]!;
        yield* completeRun({ threadId: l0, runId: l0Run1.id, replyText: "L0 ready." });

        // Create independent human subtask and start its own running turn.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:stop:fork-human-subtask"),
          sourceThreadId: l0,
          targetThreadId: humanSubtask,
          subtask: true,
          title: "Independent Human Subtask",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:stop:human-subtask-r1"),
          threadId: humanSubtask,
          messageId: MessageId.make("msg:stop:human-subtask-r1"),
          text: "Work independently on docs",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // Start a second active turn on L0 and delegate an app_owned AI task from it.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:stop:l0-r2"),
          threadId: l0,
          messageId: MessageId.make("msg:stop:l0-r2"),
          text: "Delegate work to AI subagent",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run2 = (yield* orchestrator.getThreadProjection(l0)).runs.at(-1)!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("cmd:stop:delegate"),
          parentThreadId: l0,
          parentRunId: l0Run2.id,
          parentNodeId: l0Run2.rootNodeId!,
          title: "AI Delegated Child",
          task: "Investigate module X",
          modelSelection: env.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        const delegatedChildId = (yield* orchestrator.getThreadProjection(l0)).subagents.find(
          (candidate) => candidate.prompt === "Investigate module X",
        )!.childThreadId!;

        assert.equal(
          (yield* orchestrator.getThreadProjection(humanSubtask)).runs[0]?.status,
          "running",
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(delegatedChildId)).runs[0]?.status,
          "running",
        );

        // User clicks Stop on L0.
        const stopCommandId = CommandId.make("cmd:stop:l0-interrupt");
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: stopCommandId,
          threadId: l0,
        });
        yield* threads.stopDelegatedTasks({ threadId: l0, commandId: stopCommandId });
        yield* worker.drain();

        // Parent and AI delegated child are interrupted, while independent human subtask keeps running!
        assert.equal(
          (yield* orchestrator.getThreadProjection(l0)).runs.at(-1)?.status,
          "interrupted",
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(delegatedChildId)).runs[0]?.status,
          "interrupted",
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(humanSubtask)).runs[0]?.status,
          "running",
        );
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "thread.delete cascades across L0 -> L1 -> L2 + root Side Chat, supersedes ancestor merge-backs, and preserves independent plain forks",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeControlledLayer({ capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projectId = ProjectId.make("project:delete-cascade");
        const l0 = ThreadId.make("thread:del-l0");
        const l1a = ThreadId.make("thread:del-l1a");
        const l2a = ThreadId.make("thread:del-l2a");
        const l1b = ThreadId.make("thread:del-l1b");
        const sideChat = ThreadId.make("thread:del-sidechat");
        const plainFork = ThreadId.make("thread:del-plain-fork");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:del:create-l0"),
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
          commandId: CommandId.make("cmd:del:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:del:l0-r1"),
          text: "Start L0",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run1 = (yield* orchestrator.getThreadProjection(l0)).runs[0]!;
        yield* completeRun({ threadId: l0, runId: l0Run1.id, replyText: "L0 done." });

        // Create L1-a, L1-b, root Side Chat, and an independent plain fork.
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:del:fork-l1a"),
          sourceThreadId: l0,
          targetThreadId: l1a,
          subtask: true,
          title: "L1-a",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:del:fork-l1b"),
          sourceThreadId: l0,
          targetThreadId: l1b,
          subtask: true,
          title: "L1-b",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:del:fork-sidechat"),
          sourceThreadId: l1a,
          targetThreadId: sideChat,
          sideChat: true,
          title: "Root Side Chat",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:del:fork-plain"),
          sourceThreadId: l0,
          targetThreadId: plainFork,
          title: "Plain Independent Fork",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // Complete runs on L1-a and L1-b, create L2-a under L1-a, and attach pending merge-backs on L0.
        for (const [label, tid] of [
          ["l1a", l1a],
          ["l1b", l1b],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`cmd:del:${label}-r1`),
            threadId: tid,
            messageId: MessageId.make(`msg:del:${label}-r1`),
            text: `Run ${label}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          const run = (yield* orchestrator.getThreadProjection(tid)).runs[0]!;
          yield* completeRun({ threadId: tid, runId: run.id, replyText: `${label} conclusion.` });
          yield* orchestrator.dispatch({
            type: "thread.merge_back",
            commandId: CommandId.make(`cmd:del:mb-${label}`),
            sourceThreadId: tid,
            targetThreadId: l0,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          });
        }

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:del:fork-l2a"),
          sourceThreadId: l1a,
          targetThreadId: l2a,
          subtask: true,
          title: "L2-a",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // 1. Deleting L1-a cascades to L2-a and supersedes L1-a's pending merge_back on L0,
        // while keeping L0, L1-b, L1-b's pending merge_back, root Side Chat, and plainFork alive.
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd:del:delete-l1a"),
          threadId: l1a,
        });

        assert.isNotNull((yield* orchestrator.getThreadProjection(l1a)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(l2a)).thread.deletedAt);
        assert.isNull((yield* orchestrator.getThreadProjection(l0)).thread.deletedAt);
        assert.isNull((yield* orchestrator.getThreadProjection(l1b)).thread.deletedAt);
        assert.isNull((yield* orchestrator.getThreadProjection(sideChat)).thread.deletedAt);
        assert.isNull((yield* orchestrator.getThreadProjection(plainFork)).thread.deletedAt);

        const l0TransfersAfterL1aDelete = (yield* orchestrator.getThreadProjection(l0))
          .contextTransfers;
        const mbFromL1a = l0TransfersAfterL1aDelete.find(
          (transfer) => transfer.type === "merge_back" && transfer.sourceThreadId === l1a,
        );
        const mbFromL1b = l0TransfersAfterL1aDelete.find(
          (transfer) => transfer.type === "merge_back" && transfer.sourceThreadId === l1b,
        );
        assert.equal(mbFromL1a?.status, "superseded");
        assert.equal(mbFromL1b?.status, "pending");

        // 2. Deleting L0 cascades to L1-b and root Side Chat, supersedes L1-b's pending merge_back,
        // and leaves independent plainFork untouched.
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("cmd:del:delete-l0"),
          threadId: l0,
        });

        assert.isNotNull((yield* orchestrator.getThreadProjection(l0)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(l1b)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(sideChat)).thread.deletedAt);
        assert.isNull((yield* orchestrator.getThreadProjection(plainFork)).thread.deletedAt);

        const l0TransfersAfterL0Delete = (yield* orchestrator.getThreadProjection(l0))
          .contextTransfers;
        const mbFromL1bAfterL0Delete = l0TransfersAfterL0Delete.find(
          (transfer) => transfer.type === "merge_back" && transfer.sourceThreadId === l1b,
        );
        assert.equal(mbFromL1bAfterL0Delete?.status, "superseded");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "thread.archive refuses while a descendant subtask is actively running, then cascades cleanly across the task tree once stopped",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeControlledLayer({ capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projectId = ProjectId.make("project:archive-cascade");
        const l0 = ThreadId.make("thread:arch-l0");
        const l1 = ThreadId.make("thread:arch-l1");
        const l2 = ThreadId.make("thread:arch-l2");
        const sideChat = ThreadId.make("thread:arch-sidechat");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:arch:create-l0"),
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
          commandId: CommandId.make("cmd:arch:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:arch:l0-r1"),
          text: "Start L0",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run1 = (yield* orchestrator.getThreadProjection(l0)).runs[0]!;
        yield* completeRun({ threadId: l0, runId: l0Run1.id, replyText: "L0 ready." });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:arch:fork-l1"),
          sourceThreadId: l0,
          targetThreadId: l1,
          subtask: true,
          title: "L1",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:arch:fork-sidechat"),
          sourceThreadId: l0,
          targetThreadId: sideChat,
          sideChat: true,
          title: "Side Chat",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // Start a running turn on L1.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:arch:l1-r1"),
          threadId: l1,
          messageId: MessageId.make("msg:arch:l1-r1"),
          text: "Running subtask work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // Archiving L0 while L1 is running must fail cleanly.
        const blockedArchive = yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("cmd:arch:blocked"),
            threadId: l0,
          }),
        );
        assert.isTrue(Exit.isFailure(blockedArchive));

        // Finish L1, create L2 under L1, attach a pending merge_back from L1 to L0.
        const l1Run1 = (yield* orchestrator.getThreadProjection(l1)).runs[0]!;
        yield* completeRun({ threadId: l1, runId: l1Run1.id, replyText: "L1 done." });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:arch:fork-l2"),
          sourceThreadId: l1,
          targetThreadId: l2,
          subtask: true,
          title: "L2",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:arch:mb-l1"),
          sourceThreadId: l1,
          targetThreadId: l0,
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // Now archiving L0 cascades to L1, L2, and sideChat and supersedes the pending merge_back.
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd:arch:archive-l0"),
          threadId: l0,
        });

        assert.isNotNull((yield* orchestrator.getThreadProjection(l0)).thread.archivedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(l1)).thread.archivedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(l2)).thread.archivedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(sideChat)).thread.archivedAt);

        const mb = (yield* orchestrator.getThreadProjection(l0)).contextTransfers.find(
          (transfer) => transfer.type === "merge_back" && transfer.sourceThreadId === l1,
        );
        assert.equal(mb?.status, "superseded");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "rejects cyclic cross-thread auto-wake when target threadId is already in causationChain",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeControlledLayer({ capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("project:causation-loop");
        const threadA = ThreadId.make("thread:loop-a");
        const threadB = ThreadId.make("thread:loop-b");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:loop:create-a"),
          threadId: threadA,
          projectId,
          title: "Thread A",
          modelSelection: env.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        const cyclic = yield* Effect.exit(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("cmd:loop:cyclic"),
            threadId: threadA,
            messageId: MessageId.make("msg:loop:cyclic"),
            senderThreadId: threadB,
            causationChain: [threadA, threadB],
            text: "Auto-forwarded ping-pong",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "mcp",
          }),
        );
        assert.isTrue(Exit.isFailure(cyclic));
        assert.equal(capturedTurns.length, 0);
        assert.equal((yield* orchestrator.getThreadProjection(threadA)).runs.length, 0);
      }).pipe(Effect.provide(env.layer));
    },
  );
});

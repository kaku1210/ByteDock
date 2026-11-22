import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpSubtaskEscalateResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpWorktreeCoordinateResult,
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SharedWorktreeCoordinationService from "../orchestration-v2/SharedWorktreeCoordinationService.ts";
import * as SubtaskEscalationStore from "../orchestration-v2/SubtaskEscalationStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeSubtaskEscalateResult = Schema.decodeUnknownEffect(
  OrchestratorMcpSubtaskEscalateResult,
);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeWorktreeCoordinateResult = Schema.decodeUnknownEffect(
  OrchestratorMcpWorktreeCoordinateResult,
);

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "subtask-mcp-guards-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "subtask-mcp-guards-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

function scopeFor(threadId: ThreadId): McpInvocationContext.McpInvocationScope {
  return {
    environmentId: EnvironmentId.make("env:subtask-mcp-guards"),
    requestNamespace: `ns:${threadId}`,
    thread: {
      threadId,
      providerSessionId: `session:${threadId}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
  };
}

function makeMcpHarness(input: {
  readonly projectId: ProjectId;
  readonly capturedTurns: Array<CapturedTurn>;
  readonly workspaceRoot?: string;
  readonly supportsActiveSteering?: boolean;
}) {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "model-alpha" };
  const capabilities =
    input.supportsActiveSteering === undefined
      ? CodexProviderCapabilitiesV2
      : {
          ...CodexProviderCapabilitiesV2,
          turns: {
            ...CodexProviderCapabilitiesV2.turns,
            supportsActiveSteering: input.supportsActiveSteering,
          },
        };
  let nativeThreadSeq = 0;

  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
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
            capabilities,
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

  const layerAdapters = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "subtask-mcp-guards" },
    layerAdapters,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerThreads = ThreadManagementService.layer.pipe(
    Layer.provideMerge(layerOrchestrator),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerSharedWorktree = SharedWorktreeCoordinationService.layer.pipe(
    Layer.provide(Layer.merge(ProjectionStore.layer, ProjectStore.layer)),
    Layer.provide(layerDatabase),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
  );
  const layerToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(layerThreads),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        layerAdapters,
        layerSharedWorktree,
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId,
              driver,
              enabled: true,
              installed: true,
              version: "test",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-10-18T00:00:00.000Z",
              models: [
                {
                  slug: modelSelection.model,
                  name: modelSelection.model,
                  isCustom: false,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ]),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(PeerForwarding.PeerForwarding)({}),
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
        Layer.mock(PeerLinks.PeerLinks)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            projectId === input.projectId
              ? Effect.succeedSome({
                  id: projectId,
                  title: "MCP Guard Project",
                  workspaceRoot: input.workspaceRoot ?? process.cwd(),
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-10-18T00:00:00.000Z",
                  updatedAt: "2026-10-18T00:00:00.000Z",
                  deletedAt: null,
                })
              : Effect.succeedNone,
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

  return { modelSelection, layer: layerToolkit };
}

function callTool(callerThreadId: ThreadId, name: string, args: Record<string, unknown>) {
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(callerThreadId)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });
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

function deliverDelegatedCompletionWake(input: {
  readonly parentThreadId: ThreadId;
  readonly parentRunId: RunId;
  readonly modelSelection: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly commandId: string;
}) {
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const deliveryEvent = yield* orchestrator
      .streamStoredEventsFrom({
        threadId: input.parentThreadId,
        eventType: "run.updated",
      })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === input.parentRunId &&
            event.payload.delegatedCompletion?.delivery != null,
        ),
        Stream.runHead,
      );
    const delivery =
      Option.isSome(deliveryEvent) && deliveryEvent.value.event.type === "run.updated"
        ? (deliveryEvent.value.event.payload.delegatedCompletion?.delivery ?? null)
        : null;
    assert.isNotNull(
      delivery,
      `Expected non-null delegatedCompletion.delivery on ${input.parentRunId}`,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(input.commandId),
      threadId: input.parentThreadId,
      messageId: delivery!.messageId,
      text: `Delegated task ${delivery!.taskIds.join(", ")} [completed]`,
      attachments: [],
      modelSelection: input.modelSelection,
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: {
        parentRunId: input.parentRunId,
        generation: delivery!.generation,
        taskIds: delivery!.taskIds,
      },
    });
    yield* worker.drain();
  });
}

describe("Subtask MCP guards, children scope, privilege-safe inbox, and causation loop protection", () => {
  it.effect(
    "t3_thread_list(scope: 'children') returns only direct children with accurate pagination and awaitingInitialSend on draft subtasks",
    () => {
      const projectId = ProjectId.make("project:mcp-children-scope");
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeMcpHarness({ projectId, capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const l0 = ThreadId.make("thread:mcp-scope-l0");
        const l1Active = ThreadId.make("thread:mcp-scope-l1-active");
        const l1Draft = ThreadId.make("thread:mcp-scope-l1-draft");
        const l2 = ThreadId.make("thread:mcp-scope-l2");
        const sideChat = ThreadId.make("thread:mcp-scope-sidechat");
        const unrelated = ThreadId.make("thread:mcp-scope-unrelated");

        for (const [id, title] of [
          [l0, "Root L0"],
          [unrelated, "Unrelated Sibling"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd:scope:create-${id}`),
            threadId: id,
            projectId,
            title,
            modelSelection: env.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:scope:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:scope:l0-r1"),
          text: "Kick off L0",
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
          commandId: CommandId.make("cmd:scope:fork-l1-active"),
          sourceThreadId: l0,
          targetThreadId: l1Active,
          subtask: true,
          title: "L1 Active",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:scope:l1-active-r1"),
          threadId: l1Active,
          messageId: MessageId.make("msg:scope:l1-active-r1"),
          text: "Do L1 work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l1Run1 = (yield* orchestrator.getThreadProjection(l1Active)).runs[0]!;
        yield* completeRun({ threadId: l1Active, runId: l1Run1.id, replyText: "L1 done." });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:scope:fork-l1-draft"),
          sourceThreadId: l0,
          targetThreadId: l1Draft,
          subtask: true,
          title: "L1 Draft",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:scope:fork-l2"),
          sourceThreadId: l1Active,
          targetThreadId: l2,
          subtask: true,
          title: "L2 Grandchild",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:scope:fork-sidechat"),
          sourceThreadId: l0,
          targetThreadId: sideChat,
          sideChat: true,
          title: "Root Side Chat",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // Page 1 of direct children of L0: total must be 2 (l1Active + l1Draft), excluding l2, sideChat, unrelated.
        const page1Raw = yield* callTool(l0, "t3_thread_list", { scope: "children", limit: 1 });
        assert.notEqual(page1Raw.isError, true);
        const page1 = yield* decodeThreadListResult(page1Raw.structuredContent);
        assert.equal(page1.total, 2);
        assert.equal(page1.threads.length, 1);
        assert.equal(page1.nextCursor, 1);

        const page2Raw = yield* callTool(l0, "t3_thread_list", {
          scope: "children",
          limit: 1,
          cursor: page1.nextCursor!,
        });
        assert.notEqual(page2Raw.isError, true);
        const page2 = yield* decodeThreadListResult(page2Raw.structuredContent);
        assert.equal(page2.total, 2);
        assert.equal(page2.threads.length, 1);
        assert.isNull(page2.nextCursor);

        const listed = [...page1.threads, ...page2.threads];
        assert.deepEqual(
          listed.map((item) => item.threadId).toSorted(),
          [l1Active, l1Draft].toSorted(),
        );
        const draftListItem = listed.find((item) => item.threadId === l1Draft)!;
        const activeListItem = listed.find((item) => item.threadId === l1Active)!;
        assert.equal(draftListItem.awaitingInitialSend, true);
        assert.isUndefined(activeListItem.awaitingInitialSend);

        // Explicit parentThreadId queries L1-active's direct children -> only L2.
        const l1ChildrenRaw = yield* callTool(l0, "t3_thread_list", {
          scope: "children",
          parentThreadId: l1Active,
        });
        assert.notEqual(l1ChildrenRaw.isError, true);
        const l1Children = yield* decodeThreadListResult(l1ChildrenRaw.structuredContent);
        assert.deepEqual(
          l1Children.threads.map((item) => item.threadId),
          [l2],
        );
        assert.equal(l1Children.threads[0]?.awaitingInitialSend, true);

        // t3_thread_read reflects awaitingInitialSend on the draft, then clears it after initial send.
        const draftReadBeforeRaw = yield* callTool(l0, "t3_thread_read", { threadId: l1Draft });
        assert.notEqual(draftReadBeforeRaw.isError, true);
        const draftReadBefore = yield* decodeThreadReadResult(draftReadBeforeRaw.structuredContent);
        assert.equal(draftReadBefore.thread.awaitingInitialSend, true);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:scope:l1-draft-first"),
          threadId: l1Draft,
          messageId: MessageId.make("msg:scope:l1-draft-first"),
          text: "First real prompt",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const draftReadAfterRaw = yield* callTool(l0, "t3_thread_read", { threadId: l1Draft });
        assert.notEqual(draftReadAfterRaw.isError, true);
        const draftReadAfter = yield* decodeThreadReadResult(draftReadAfterRaw.structuredContent);
        assert.isUndefined(draftReadAfter.thread.awaitingInitialSend);
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "low-privilege direct subtask can report into a higher-privilege parent's held inbox without waking it, while steer and unrelated escalation stay denied",
    () => {
      const projectId = ProjectId.make("project:mcp-privilege-inbox");
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeMcpHarness({ projectId, capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const l0 = ThreadId.make("thread:priv-l0");
        const l1LowPriv = ThreadId.make("thread:priv-l1-low");
        const peerLowPriv = ThreadId.make("thread:priv-peer-low");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:priv:create-l0"),
          threadId: l0,
          projectId,
          title: "Full-Access Parent",
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
          commandId: CommandId.make("cmd:priv:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:priv:l0-r1"),
          text: "Bootstrap L0",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run1 = (yield* orchestrator.getThreadProjection(l0)).runs[0]!;
        yield* completeRun({ threadId: l0, runId: l0Run1.id, replyText: "L0 idle." });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:priv:fork-l1"),
          sourceThreadId: l0,
          targetThreadId: l1LowPriv,
          subtask: true,
          title: "Low-Priv Subtask",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd:priv:l1-runtime"),
          threadId: l1LowPriv,
          runtimeMode: "approval-required",
        });
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd:priv:l1-interaction"),
          threadId: l1LowPriv,
          interactionMode: "plan",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:priv:create-peer"),
          threadId: peerLowPriv,
          projectId,
          title: "Unrelated Low-Priv Peer",
          modelSelection: env.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });

        // Start active turns on the low-privilege callers (MCP cross-thread tools require a live caller run).
        for (const [label, tid] of [
          ["l1-low", l1LowPriv],
          ["peer-low", peerLowPriv],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`cmd:priv:start-${label}`),
            threadId: tid,
            messageId: MessageId.make(`msg:priv:start-${label}`),
            text: `Run ${label}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* worker.drain();

        const parentTurnsBeforeReport = capturedTurns.filter((turn) => turn.threadId === l0).length;

        // 1. Direct task child reports to higher-privilege parent -> allowed ONLY into held inbox (no wake!).
        const inboxRaw = yield* callTool(l1LowPriv, "t3_thread_send", {
          threadId: l0,
          message: "Subtask summary awaiting parent review",
          mode: "queue",
        });
        assert.notEqual(inboxRaw.isError, true);
        const inbox = yield* decodeThreadSendResult(inboxRaw.structuredContent);
        assert.equal(inbox.delivery, "queued");
        assert.equal(inbox.parentQueueHeld, true);
        yield* worker.drain();
        assert.equal(
          capturedTurns.filter((turn) => turn.threadId === l0).length,
          parentTurnsBeforeReport,
          "Held inbox report must not start a parent turn automatically",
        );

        const parentAfterInbox = yield* orchestrator.getThreadProjection(l0);
        const heldRun = parentAfterInbox.runs.find((run) => run.id === inbox.runId);
        assert.equal(heldRun?.status, "queued");
        assert.equal(heldRun?.queueHeld, true);

        // 2. Direct task child attempting steer against higher-privilege parent -> strictly denied.
        const steerDenied = yield* callTool(l1LowPriv, "t3_thread_send", {
          threadId: l0,
          message: "Trying to steer parent",
          mode: "steer",
        });
        assert.equal(steerDenied.isError, true);
        assert.equal(declaredFailure(steerDenied)?.code, "runtime_mode_escalation_denied");

        // 3. Unrelated low-privilege peer trying to queue into full-access thread -> strictly denied.
        const peerDenied = yield* callTool(peerLowPriv, "t3_thread_send", {
          threadId: l0,
          message: "Unrelated peer trying to queue",
          mode: "queue",
        });
        assert.equal(peerDenied.isError, true);
        assert.equal(declaredFailure(peerDenied)?.code, "runtime_mode_escalation_denied");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "t3_thread_send propagates causationChain to block peer ping-pong loops while allowing a single parent->child->parent report hop",
    () => {
      const projectId = ProjectId.make("project:mcp-causation-chain");
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeMcpHarness({ projectId, capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const peerA = ThreadId.make("thread:chain-peer-a");
        const peerB = ThreadId.make("thread:chain-peer-b");
        const l0 = ThreadId.make("thread:chain-l0");
        const l1 = ThreadId.make("thread:chain-l1");

        for (const [id, title] of [
          [peerA, "Peer A"],
          [peerB, "Peer B"],
          [l0, "Parent L0"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd:chain:create-${id}`),
            threadId: id,
            projectId,
            title,
            modelSelection: env.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        }

        // Start user-initiated run on Peer A, then Peer A sends to Peer B.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:chain:a-r1"),
          threadId: peerA,
          messageId: MessageId.make("msg:chain:a-r1"),
          text: "Ask Peer B",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const aToBRaw = yield* callTool(peerA, "t3_thread_send", {
          threadId: peerB,
          message: "Ping from A",
        });
        assert.notEqual(aToBRaw.isError, true);
        yield* worker.drain();

        // Now Peer B's latest run carries causationChain: [peerA]. Sending back to Peer A must be rejected!
        const bToARaw = yield* callTool(peerB, "t3_thread_send", {
          threadId: peerA,
          message: "Pong back to A",
        });
        assert.equal(bToARaw.isError, true);
        assert.include(String(declaredFailure(bToARaw)?.message ?? ""), "causationChain");

        // Contrast: L0 -> L1 -> L0 (1-hop child report return) is allowed, then L0 -> L1 auto-bounce is rejected.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:chain:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:chain:l0-r1"),
          text: "Bootstrap L0",
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
          commandId: CommandId.make("cmd:chain:fork-l1"),
          sourceThreadId: l0,
          targetThreadId: l1,
          subtask: true,
          title: "Child L1",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // Start a live turn on L0, send work to L1 (causationChain: [l0]), then finish L0 so L1's report wakes L0.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:chain:l0-r2"),
          threadId: l0,
          messageId: MessageId.make("msg:chain:l0-r2"),
          text: "Coordinate L1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run2 = (yield* orchestrator.getThreadProjection(l0)).runs.at(-1)!;

        // L0 sends a task to L1 (causationChain: [l0]).
        const l0ToL1Raw = yield* callTool(l0, "t3_thread_send", {
          threadId: l1,
          message: "Investigate bug #42",
        });
        assert.notEqual(l0ToL1Raw.isError, true);
        yield* worker.drain();
        yield* completeRun({ threadId: l0, runId: l0Run2.id, replyText: "Waiting for L1." });

        // L1 reports its result back to L0 (single return hop -> causationChain: [l1]).
        const l1ToL0Raw = yield* callTool(l1, "t3_thread_send", {
          threadId: l0,
          message: "Bug #42 root cause found",
        });
        assert.notEqual(l1ToL0Raw.isError, true);
        yield* worker.drain();

        // L0's newly woken run now carries causationChain: [l1], so bouncing straight back to L1 is blocked.
        const l0BounceRaw = yield* callTool(l0, "t3_thread_send", {
          threadId: l1,
          message: "Auto-bounce back to L1",
        });
        assert.equal(l0BounceRaw.isError, true);
        assert.include(String(declaredFailure(l0BounceRaw)?.message ?? ""), "causationChain");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "t3_subtask_escalate enforces L1-only guard, holds low-privilege escalations in L0 inbox without auto-wake, and L0 fulfills idempotently via delegate_task(escalationRequestId)",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const projectId = ProjectId.make("project:mcp-escalate");
      const env = makeMcpHarness({ projectId, capturedTurns });
      const l0 = ThreadId.make("thread:mcp-esc:l0");
      const l1Low = ThreadId.make("thread:mcp-esc:l1-low");
      const l1Same = ThreadId.make("thread:mcp-esc:l1-same");
      const l2 = ThreadId.make("thread:mcp-esc:l2");
      const sideChat = ThreadId.make("thread:mcp-esc:side");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:mesc:create-l0"),
          threadId: l0,
          projectId,
          title: "Root L0 (full-access)",
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
          commandId: CommandId.make("cmd:mesc:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:mesc:l0-r1"),
          text: "Root bootstrap",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0Run1 = (yield* orchestrator.getThreadProjection(l0)).runs[0]!;
        yield* completeRun({ threadId: l0, runId: l0Run1.id, replyText: "Root ready." });

        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:mesc:fork-l1-low"),
          sourceThreadId: l0,
          targetThreadId: l1Low,
          subtask: true,
          title: "Low-priv L1",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd:mesc:l1-low-mode"),
          threadId: l1Low,
          runtimeMode: "approval-required",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:mesc:fork-l1-same"),
          sourceThreadId: l0,
          targetThreadId: l1Same,
          subtask: true,
          title: "Same-priv L1",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:mesc:fork-l2"),
          sourceThreadId: l1Same,
          targetThreadId: l2,
          subtask: true,
          title: "L2 Child",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:mesc:fork-side"),
          sourceThreadId: l0,
          targetThreadId: sideChat,
          sideChat: true,
          temporary: false,
          title: "Root Side Chat",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });

        // 1. L0, L2, and Side Chat calling t3_subtask_escalate (with live active runs) must be rejected with invalid_request.
        for (const forbidden of [l0, l2, sideChat]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`cmd:mesc:start-forbidden:${forbidden}`),
            threadId: forbidden,
            messageId: MessageId.make(`msg:mesc:start-forbidden:${forbidden}`),
            text: `Start ${forbidden}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* worker.drain();
        for (const forbidden of [l0, l2, sideChat]) {
          const forbiddenRaw = yield* callTool(forbidden, "t3_subtask_escalate", {
            task: "Try forbidden escalate",
          });
          assert.equal(forbiddenRaw.isError, true);
          assert.equal(declaredFailure(forbiddenRaw)?.code, "invalid_request");
        }
        // Complete L0's run so L0 is idle before testing low-privilege held inbox (zero auto-wake).
        const l0Active = (yield* orchestrator.getThreadProjection(l0)).runs.find(
          (run) => run.status === "running",
        );
        assert.isDefined(l0Active);
        yield* completeRun({ threadId: l0, runId: l0Active.id, replyText: "L0 idle again." });

        // Start active run on low-privilege L1.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:mesc:l1-low-r1"),
          threadId: l1Low,
          messageId: MessageId.make("msg:mesc:l1-low-r1"),
          text: "Start low-priv L1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // 2. Low-privilege L1 escalates to higher-privilege L0 -> held inbox (parentQueueHeld: true, zero auto-wake!).
        const turnsBeforeLowEscalate = capturedTurns.filter((turn) => turn.threadId === l0).length;
        const lowReqId = SubtaskEscalationRequestId.make("esc:mcp:low-priv-1");
        const lowEscRaw = yield* callTool(l1Low, "t3_subtask_escalate", {
          requestId: lowReqId,
          title: "Auth sibling",
          task: "Spawn sibling L1 for auth service",
        });
        assert.notEqual(lowEscRaw.isError, true);
        const lowEsc = yield* decodeSubtaskEscalateResult(lowEscRaw.structuredContent);
        assert.equal(lowEsc.request.requestId, lowReqId);
        assert.equal(lowEsc.rootThreadId, l0);
        assert.equal(lowEsc.request.sourceThreadId, l1Low);
        assert.equal(lowEsc.status, "pending");
        assert.isTrue(lowEsc.parentQueueHeld);
        assert.isFalse(lowEsc.replayed);

        yield* worker.drain();
        // L0 must NOT have auto-woken!
        assert.equal(
          capturedTurns.filter((turn) => turn.threadId === l0).length,
          turnsBeforeLowEscalate,
        );
        const l0AfterLow = yield* orchestrator.getThreadProjection(l0);
        const heldRun = l0AfterLow.runs.find((run) => run.queueHeld === true);
        assert.isDefined(heldRun);
        assert.equal(heldRun.status, "queued");
        const heldMsg = l0AfterLow.messages.find((msg) => msg.id === heldRun.userMessageId);
        assert.isDefined(heldMsg);
        assert.notInclude(heldMsg.text, "[阶段性进度]");
        assert.include(heldMsg.text, lowReqId);

        // Retrying t3_subtask_escalate with the same requestId is strictly idempotent.
        const lowEscReplayRaw = yield* callTool(l1Low, "t3_subtask_escalate", {
          requestId: lowReqId,
          task: "Retry duplicate escalation",
        });
        assert.notEqual(lowEscReplayRaw.isError, true);
        const lowEscReplay = yield* decodeSubtaskEscalateResult(lowEscReplayRaw.structuredContent);
        assert.isTrue(lowEscReplay.replayed);
        assert.equal(lowEscReplay.request.requestId, lowReqId);
        assert.equal(
          (yield* orchestrator.getThreadProjection(l0)).runs.filter((run) => run.queueHeld === true)
            .length,
          1,
        );

        // 3. Same-privilege L1 escalates to L0 -> parentQueueHeld: false (normal queue).
        // First clear the held run by starting a fresh turn on L0 via user action so L0 has an active run for delegate_task.
        yield* orchestrator.dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("cmd:mesc:start-held"),
          threadId: l0,
          runId: heldRun.id,
        });
        yield* worker.drain();

        // Wrong caller (l1Same) trying to fulfill l0's escalation via delegate_task is rejected.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:mesc:l1-same-r1"),
          threadId: l1Same,
          messageId: MessageId.make("msg:mesc:l1-same-r1"),
          text: "Run L1 same",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const wrongCallerRaw = yield* callTool(l1Same, "delegate_task", {
          task: "Try hijacking escalation",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
          escalationRequestId: lowReqId,
        });
        assert.equal(wrongCallerRaw.isError, true);
        assert.equal(declaredFailure(wrongCallerRaw)?.code, "capability_denied");

        // 4. L0 fulfills lowReqId via delegate_task({ escalationRequestId }) -> creates sibling L1 with sourceAnchor pointing to l1Low.
        const fulfillRaw1 = yield* callTool(l0, "delegate_task", {
          task: "Handle auth service audit",
          title: "Sibling Auth L1",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
          escalationRequestId: lowReqId,
        });
        assert.notEqual(fulfillRaw1.isError, true);
        const fulfilled1 = yield* decodeDelegateTaskResult(fulfillRaw1.structuredContent);
        if (fulfilled1.childThreadId === null) {
          assert.fail("Expected fulfilled1.childThreadId to be non-null");
        }
        const siblingProj = yield* orchestrator.getThreadProjection(fulfilled1.childThreadId);
        assert.equal(siblingProj.thread.lineage.parentThreadId, l0);
        assert.equal(siblingProj.thread.lineage.rootThreadId, l0);
        assert.equal(siblingProj.thread.sourceAnchor?.sourceThreadId, l1Low);

        // 5. Repeating delegate_task with the same escalationRequestId returns the EXACT same taskId & childThreadId (no duplicate sibling).
        const fulfillRaw2 = yield* callTool(l0, "delegate_task", {
          task: "Handle auth service audit (retry)",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
          escalationRequestId: lowReqId,
        });
        assert.notEqual(fulfillRaw2.isError, true);
        const fulfilled2 = yield* decodeDelegateTaskResult(fulfillRaw2.structuredContent);
        assert.equal(fulfilled2.taskId, fulfilled1.taskId);
        assert.equal(fulfilled2.childThreadId, fulfilled1.childThreadId);

        // Verify same-privilege L1 escalation submits with parentQueueHeld: false.
        const sameReqId = SubtaskEscalationRequestId.make("esc:mcp:same-priv-1");
        const sameEscRaw = yield* callTool(l1Same, "t3_subtask_escalate", {
          requestId: sameReqId,
          task: "Same privilege sibling request",
        });
        assert.notEqual(sameEscRaw.isError, true);
        const sameEsc = yield* decodeSubtaskEscalateResult(sameEscRaw.structuredContent);
        assert.isFalse(sameEsc.parentQueueHeld);
        assert.equal(sameEsc.status, "pending");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "causationChain blocks empty-array spoofing, send->delegate->send cycles, and infinite horizontal escalation loops while allowing L0->L1->L2->L1->L0 reporting",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const projectId = ProjectId.make("project:mcp-causation-hardening");
      const env = makeMcpHarness({ projectId, capturedTurns });
      const peerA = ThreadId.make("thread:ch:peer-a");
      const peerB = ThreadId.make("thread:ch:peer-b");
      const l0 = ThreadId.make("thread:ch:l0");
      const l1 = ThreadId.make("thread:ch:l1");
      const l2 = ThreadId.make("thread:ch:l2");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

        for (const [id, title] of [
          [peerA, "Peer A"],
          [peerB, "Peer B"],
          [l0, "Tree Root L0"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd:ch:create:${id}`),
            threadId: id,
            projectId,
            title,
            modelSelection: env.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        }

        // 1. Empty-array spoofing & send -> delegate -> send cycle:
        // Peer A starts a run and sends to Peer B (B's run carries causationChain: [peerA]).
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:ch:a-r1"),
          threadId: peerA,
          messageId: MessageId.make("msg:ch:a-r1"),
          text: "Start A",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const aToB = yield* callTool(peerA, "t3_thread_send", {
          threadId: peerB,
          message: "Ask B to do work",
        });
        assert.notEqual(aToB.isError, true);
        yield* worker.drain();

        // Peer B tries spoofing causationChain: [] to send back to Peer A -> MUST be rejected!
        const spoofRaw = yield* callTool(peerB, "t3_thread_send", {
          threadId: peerA,
          message: "Spoofed empty chain bounce",
          causationChain: [],
        });
        assert.equal(spoofRaw.isError, true);
        assert.include(String(declaredFailure(spoofRaw)?.message ?? ""), "causationChain");

        // Peer B delegates to Child C -> C's run inherits causationChain: [peerA, peerB].
        // C trying to send back to Peer A must be rejected!
        const bDelegatesCRaw = yield* callTool(peerB, "delegate_task", {
          task: "Work delegated from B",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(bDelegatesCRaw.isError, true);
        const bDelegatesC = yield* decodeDelegateTaskResult(bDelegatesCRaw.structuredContent);
        yield* worker.drain();
        const childC = bDelegatesC.childThreadId;
        if (childC === null) {
          assert.fail("Expected bDelegatesC.childThreadId to be non-null");
        }
        const cToARaw = yield* callTool(childC, "t3_thread_send", {
          threadId: peerA,
          message: "Cycle back to A via delegation",
        });
        assert.equal(cToARaw.isError, true);
        assert.include(String(declaredFailure(cToARaw)?.message ?? ""), "causationChain");

        // 2. Infinite horizontal escalation loop: L1-A -> escalate L0 -> L0 delegates L1-B -> L1-B tries to escalate L0 again -> REJECTED!
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:ch:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:ch:l0-r1"),
          text: "Bootstrap L0",
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
          commandId: CommandId.make("cmd:ch:fork-l1"),
          sourceThreadId: l0,
          targetThreadId: l1,
          subtask: true,
          title: "L1-A",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:ch:l1-r1"),
          threadId: l1,
          messageId: MessageId.make("msg:ch:l1-r1"),
          text: "Run L1-A",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // L1-A escalates to L0 (first hop allowed; L0's inbox run carries causationChain: [l1]).
        const loopReq1 = SubtaskEscalationRequestId.make("esc:ch:loop-1");
        const esc1Raw = yield* callTool(l1, "t3_subtask_escalate", {
          requestId: loopReq1,
          task: "Need sibling L1-B",
        });
        assert.notEqual(esc1Raw.isError, true);
        yield* worker.drain();

        // L0 (now running from the escalation inbox run) fulfills loopReq1 by delegating sibling L1-B.
        // L1-B's run carries causationChain: [l1, l0].
        const delSiblingRaw = yield* callTool(l0, "delegate_task", {
          task: "Run sibling L1-B",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
          escalationRequestId: loopReq1,
        });
        assert.notEqual(delSiblingRaw.isError, true);
        const delSibling = yield* decodeDelegateTaskResult(delSiblingRaw.structuredContent);
        if (delSibling.childThreadId === null) {
          assert.fail("Expected delSibling.childThreadId to be non-null");
        }
        yield* worker.drain();

        // Sibling L1-B tries to escalate back to L0 again -> infinite escalation loop MUST be rejected!
        const loopReq2 = SubtaskEscalationRequestId.make("esc:ch:loop-2");
        const esc2Raw = yield* callTool(delSibling.childThreadId, "t3_subtask_escalate", {
          requestId: loopReq2,
          task: "Recursive escalation loop back to L0",
        });
        assert.equal(esc2Raw.isError, true);
        assert.include(String(declaredFailure(esc2Raw)?.message ?? ""), "causationChain");

        // 3. Legitimate L0 -> L1 -> L2 -> report L1 -> report L0 still works cleanly!
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("cmd:ch:fork-l2"),
          sourceThreadId: l1,
          targetThreadId: l2,
          subtask: true,
          title: "L2 Leaf",
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        // Finish L1's active run and L0's active run so downward->upward flow is clean.
        const l1Run1 = (yield* orchestrator.getThreadProjection(l1)).runs[0]!;
        yield* completeRun({ threadId: l1, runId: l1Run1.id, replyText: "L1-A paused." });
        const l0ActiveRun = (yield* orchestrator.getThreadProjection(l0)).runs.at(-1)!;
        yield* completeRun({
          threadId: l0,
          runId: l0ActiveRun.id,
          replyText: "L0 ready for L1->L2.",
        });

        // Fresh user turn on L0 sends down to L1 -> L1 sends down to L2 -> L2 reports to L1 -> L1 reports to L0.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:ch:l0-r3"),
          threadId: l0,
          messageId: MessageId.make("msg:ch:l0-r3"),
          text: "Kick off L0->L1->L2",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const l0DownToL1 = yield* callTool(l0, "t3_thread_send", {
          threadId: l1,
          message: "Go inspect L2",
        });
        assert.notEqual(l0DownToL1.isError, true);
        yield* worker.drain();
        const l0Run3 = (yield* orchestrator.getThreadProjection(l0)).runs.at(-1)!;
        yield* completeRun({ threadId: l0, runId: l0Run3.id, replyText: "Waiting for L1." });

        const l1DownToL2 = yield* callTool(l1, "t3_thread_send", {
          threadId: l2,
          message: "Run leaf check",
        });
        assert.notEqual(l1DownToL2.isError, true);
        yield* worker.drain();
        const l1Run2 = (yield* orchestrator.getThreadProjection(l1)).runs.at(-1)!;
        yield* completeRun({ threadId: l1, runId: l1Run2.id, replyText: "Waiting for L2." });

        // L2 reports back to L1 -> MUST succeed!
        const l2ReportL1 = yield* callTool(l2, "t3_thread_send", {
          threadId: l1,
          message: "L2 check passed",
        });
        assert.notEqual(l2ReportL1.isError, true);
        yield* worker.drain();

        // L1 (woken by L2's report) reports up to L0 -> MUST succeed!
        const l1ReportL0 = yield* callTool(l1, "t3_thread_send", {
          threadId: l0,
          message: "L1 aggregated L2 result",
        });
        assert.notEqual(l1ReportL0.isError, true);
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "records delegate_task plannedPaths, coordinates shared worktree writes via t3_worktree_coordinate, and refuses write_file in plan mode",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-shared-wt-" });
          yield* fs.makeDirectory(path.join(tmpDir, "src"), { recursive: true });
          yield* fs.writeFileString(path.join(tmpDir, "src", "shared.ts"), "base\n");

          const projectId = ProjectId.make("project:mcp-shared-wt");
          const capturedTurns: Array<CapturedTurn> = [];
          const env = makeMcpHarness({ projectId, capturedTurns, workspaceRoot: tmpDir });

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const rootId = ThreadId.make("thread:mcp-sw-l0");
            const planChildId = ThreadId.make("thread:mcp-sw-plan");

            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("cmd:sw:root"),
              projectId,
              threadId: rootId,
              title: "L0 Coordinator",
              modelSelection: env.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              worktreePath: tmpDir,
              branch: "develop",
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("cmd:sw:root-run"),
              threadId: rootId,
              messageId: MessageId.make("msg:sw:root-run"),
              text: "Delegate two siblings on shared.ts",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();

            // Delegate L1-A with plannedPaths declared on delegate_task.
            const delARaw = yield* callTool(rootId, "delegate_task", {
              task: "Edit src/shared.ts for task A",
              target: {
                providerInstanceId: env.modelSelection.instanceId,
                model: env.modelSelection.model,
              },
              mode: "async",
              plannedPaths: ["src/shared.ts"],
            });
            assert.notEqual(delARaw.isError, true);
            const delA = yield* decodeDelegateTaskResult(delARaw.structuredContent);
            if (delA.childThreadId === null) {
              assert.fail("Expected childThreadId for L1-A");
            }

            // Delegate L1-B with overlapping plannedPaths.
            const delBRaw = yield* callTool(rootId, "delegate_task", {
              task: "Edit src/shared.ts for task B",
              target: {
                providerInstanceId: env.modelSelection.instanceId,
                model: env.modelSelection.model,
              },
              mode: "async",
              plannedPaths: ["./src/shared.ts"],
            });
            assert.notEqual(delBRaw.isError, true);
            const delB = yield* decodeDelegateTaskResult(delBRaw.structuredContent);
            if (delB.childThreadId === null) {
              assert.fail("Expected childThreadId for L1-B");
            }
            yield* worker.drain();

            // Inspect from L1-A detects planned overlap between L1-A and L1-B.
            const inspectRaw = yield* callTool(delA.childThreadId, "t3_worktree_coordinate", {
              action: "inspect",
            });
            assert.notEqual(inspectRaw.isError, true);
            const inspected = yield* decodeWorktreeCoordinateResult(inspectRaw.structuredContent);
            assert.equal(inspected.snapshot?.overlaps.length, 1);
            assert.equal(inspected.snapshot?.overlaps[0]?.normalizedPath, "src/shared.ts");

            // L1-A reserves, reads latest revision, releases, and performs controlled write_file.
            const reserveRaw = yield* callTool(delA.childThreadId, "t3_worktree_coordinate", {
              action: "reserve_paths",
              paths: ["src/shared.ts"],
            });
            assert.notEqual(reserveRaw.isError, true);
            const reserved = yield* decodeWorktreeCoordinateResult(reserveRaw.structuredContent);
            assert.equal(reserved.latestFiles?.[0]?.contents, "base\n");
            const baseSha = reserved.latestFiles?.[0]?.sha256;
            assert.isNotNull(baseSha);

            const releaseRaw = yield* callTool(delA.childThreadId, "t3_worktree_coordinate", {
              action: "release_paths",
              reservationId: reserved.reservation?.reservationId,
            });
            assert.notEqual(releaseRaw.isError, true);
            const released = yield* decodeWorktreeCoordinateResult(releaseRaw.structuredContent);
            assert.equal(released.releasedCount, 1);

            const writeRaw = yield* callTool(delA.childThreadId, "t3_worktree_coordinate", {
              action: "write_file",
              path: "src/shared.ts",
              contents: "base\nwritten-by-A\n",
              expectedSha256: baseSha!,
            });
            assert.notEqual(writeRaw.isError, true);
            const written = yield* decodeWorktreeCoordinateResult(writeRaw.structuredContent);
            assert.equal(written.writtenFile?.contents, "base\nwritten-by-A\n");

            // A plan-mode thread MUST be refused write_file via t3_worktree_coordinate.
            yield* orchestrator.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("cmd:sw:plan-child"),
              sourceThreadId: rootId,
              targetThreadId: planChildId,
              subtask: true,
              title: "L1 Plan Mode",
              sourcePoint: { type: "latest_stable" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("cmd:sw:plan-child-rt"),
              threadId: planChildId,
              runtimeMode: "approval-required",
            });
            yield* orchestrator.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("cmd:sw:plan-child-mode"),
              threadId: planChildId,
              interactionMode: "plan",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("cmd:sw:plan-child-run"),
              threadId: planChildId,
              messageId: MessageId.make("msg:sw:plan-child-run"),
              text: "Attempt write in plan mode",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            const planWriteRaw = yield* callTool(planChildId, "t3_worktree_coordinate", {
              action: "write_file",
              path: "src/shared.ts",
              contents: "illegal-plan-write\n",
            });
            assert.equal(planWriteRaw.isError, true);
            assert.equal(declaredFailure(planWriteRaw)?.code, "interaction_mode_escalation_denied");
          }).pipe(Effect.provide(env.layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "allows AI-delegated L1 to delegate L2 via MCP delegate_task and hard-rejects L2 -> L3 delegation (Scenario 1)",
    () => {
      const projectId = ProjectId.make("project:mcp-depth-cap");
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeMcpHarness({ projectId, capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const l0 = ThreadId.make("thread:mcp-depth-l0");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:depth:l0"),
          projectId,
          threadId: l0,
          title: "Depth Cap L0",
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
          commandId: CommandId.make("cmd:depth:l0-run"),
          threadId: l0,
          messageId: MessageId.make("msg:depth:l0-run"),
          text: "Delegate AI L1",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // L0 -> AI L1 via delegate_task succeeds.
        const delL1Raw = yield* callTool(l0, "delegate_task", {
          task: "Work on L1",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL1Raw.isError, true);
        const delL1 = yield* decodeDelegateTaskResult(delL1Raw.structuredContent);
        if (delL1.childThreadId === null) {
          assert.fail("Expected AI L1 childThreadId");
        }
        yield* worker.drain();

        // AI L1 -> AI L2 via delegate_task succeeds with parentThreadId=AI L1, rootThreadId=L0.
        const delL2Raw = yield* callTool(delL1.childThreadId, "delegate_task", {
          task: "Work on L2",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL2Raw.isError, true);
        const delL2 = yield* decodeDelegateTaskResult(delL2Raw.structuredContent);
        if (delL2.childThreadId === null) {
          assert.fail("Expected AI L2 childThreadId");
        }
        yield* worker.drain();

        const l2Proj = yield* orchestrator.getThreadProjection(delL2.childThreadId);
        assert.equal(l2Proj.thread.lineage.parentThreadId, delL1.childThreadId);
        assert.equal(l2Proj.thread.lineage.rootThreadId, l0);
        assert.equal(l2Proj.thread.lineage.relationshipToParent, "subagent");

        // AI L2 -> L3 via delegate_task MUST be hard-rejected by server!
        const delL3Raw = yield* callTool(delL2.childThreadId, "delegate_task", {
          task: "Illegal L3 delegation",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.equal(delL3Raw.isError, true);
        const errText = String(declaredFailure(delL3Raw)?.message ?? "");
        assert.isTrue(
          errText.toLowerCase().includes("depth") || errText.includes("L2"),
          `Expected depth cap error message, got: ${errText}`,
        );
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "task_cancel synchronously revokes pending merge_back, cancels pending escalation, disposes delivery, and clears parent wait without deadlock (Scenario 6)",
    () => {
      const projectId = ProjectId.make("project:mcp-cancel-cleanup");
      const capturedTurns: Array<CapturedTurn> = [];
      const env = makeMcpHarness({ projectId, capturedTurns });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const escalationStore = yield* SubtaskEscalationStore.SubtaskEscalationStore;
        const l0 = ThreadId.make("thread:mcp-cancel-l0");

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:cancel:l0"),
          projectId,
          threadId: l0,
          title: "Cancel Cleanup L0",
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
          commandId: CommandId.make("cmd:cancel:l0-run"),
          threadId: l0,
          messageId: MessageId.make("msg:cancel:l0-run"),
          text: "Delegate running child",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // L0 delegates running AI L1.
        const delRaw = yield* callTool(l0, "delegate_task", {
          task: "Long running child task",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delRaw.isError, true);
        const del = yield* decodeDelegateTaskResult(delRaw.structuredContent);
        if (del.childThreadId === null) {
          assert.fail("Expected childThreadId");
        }
        const childId = del.childThreadId;
        yield* worker.drain();

        // Queue a mid-task adjustment (run 2) on the child so the delegation stays open & running
        // after run 1 completes, then stage a pending merge_back from completed run 1 onto L0
        // and raise a pending escalation onto L0.
        const childProjBefore = yield* orchestrator.getThreadProjection(childId);
        const childRun1 = childProjBefore.runs[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cmd:cancel:child-run-2"),
          threadId: childId,
          messageId: MessageId.make("msg:cancel:child-run-2"),
          text: "Continue with step 2",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* completeRun({
          threadId: childId,
          runId: childRun1.id,
          replyText: "Step 1 partial conclusion.",
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("cmd:cancel:stage-merge-back"),
          sourceThreadId: childId,
          targetThreadId: l0,
          sourcePoint: { type: "run", runId: childRun1.id },
          createdBy: "user",
          creationSource: "web",
        });

        const escReqId = SubtaskEscalationRequestId.make("esc:cancel:pending-1");
        const escRaw = yield* callTool(childId, "t3_subtask_escalate", {
          requestId: escReqId,
          task: "Pending sibling request before cancel",
        });
        assert.notEqual(escRaw.isError, true);

        const escBefore = yield* escalationStore.getById(escReqId);
        assert.isTrue(Option.isSome(escBefore) && escBefore.value.status === "pending");
        const l0BeforeCancel = yield* orchestrator.getThreadProjection(l0);
        assert.equal(
          l0BeforeCancel.contextTransfers.filter(
            (t) =>
              t.type === "merge_back" && t.sourceThreadId === childId && t.status === "pending",
          ).length,
          1,
        );

        // Parent cancels the running delegated task via MCP task_cancel.
        const cancelRaw = yield* callTool(l0, "task_cancel", {
          taskId: del.taskId,
          reason: "Parent no longer needs this subtask",
        });
        assert.notEqual(cancelRaw.isError, true);
        yield* worker.drain();

        // 1. Pending escalation from cancelled child is synchronously cancelled.
        const escAfter = yield* escalationStore.getById(escReqId);
        assert.isTrue(Option.isSome(escAfter) && escAfter.value.status === "cancelled");

        // 2. Pending merge_back from cancelled child on L0 is synchronously revoked/superseded.
        const l0AfterCancel = yield* orchestrator.getThreadProjection(l0);
        const remainingPendingMergeBacks = l0AfterCancel.contextTransfers.filter(
          (t) => t.type === "merge_back" && t.sourceThreadId === childId && t.status === "pending",
        );
        assert.equal(remainingPendingMergeBacks.length, 0);

        // 3. Delegated task completionDelivery is disposed so parent does not deadlock/re-wake on it.
        const cancelledTask = l0AfterCancel.subagents.find((s) => s.id === del.taskId);
        assert.isDefined(cancelledTask);
        assert.equal(cancelledTask!.completionDelivery?.state, "disposed");

        // 4. task_status confirms terminal cancellation and parent has no lingering delegated wake wait.
        const statusRaw = yield* callTool(l0, "task_status", {
          taskId: del.taskId,
        });
        assert.notEqual(statusRaw.isError, true);
        const statusText = JSON.stringify(statusRaw.structuredContent ?? statusRaw.content);
        assert.isTrue(
          statusText.includes("cancelled") || statusText.includes("interrupted"),
          `Expected cancelled/interrupted status, got: ${statusText}`,
        );
        assert.isTrue(
          l0AfterCancel.runs.every((r) => r.delegatedCompletion?.delivery == null),
          "Parent should have no pending delegated completion delivery after task_cancel",
        );
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "redundant wake cancellation keeps t3_thread_list and t3_thread_read status/latestRunId consistent and preserves active-run escalation with same-requestId replay",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const projectId = ProjectId.make("project:mcp-redundant-wake-consistency");
      const env = makeMcpHarness({
        projectId,
        capturedTurns,
        supportsActiveSteering: false,
      });
      const l0 = ThreadId.make("thread:rw:l0");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:rw:create-l0"),
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
          commandId: CommandId.make("cmd:rw:l0-r1"),
          threadId: l0,
          messageId: MessageId.make("msg:rw:l0-r1"),
          text: "Start L0",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // L0 delegates L1-A (async).
        const delL1Raw = yield* callTool(l0, "delegate_task", {
          title: "L1-A",
          task: "Delegate L2, read it, then escalate",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL1Raw.isError, true);
        const delL1 = yield* decodeDelegateTaskResult(delL1Raw.structuredContent);
        if (delL1.childThreadId === null) assert.fail("Expected L1-A childThreadId");
        const l1a = delL1.childThreadId;
        yield* worker.drain();

        const l1aRun1 = (yield* orchestrator.getThreadProjection(l1a)).runs[0]!;

        // L1-A (still running ordinal 1) delegates L2 (async).
        const delL2Raw = yield* callTool(l1a, "delegate_task", {
          title: "L2-Probe",
          task: "Finish quickly",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL2Raw.isError, true);
        const delL2 = yield* decodeDelegateTaskResult(delL2Raw.structuredContent);
        if (delL2.childThreadId === null) assert.fail("Expected L2 childThreadId");
        const l2 = delL2.childThreadId;
        yield* worker.drain();

        // L2 completes while L1-A ordinal 1 is still running -> queues a delegated completion wake (ordinal 2) on L1-A.
        const l2Run1 = (yield* orchestrator.getThreadProjection(l2)).runs[0]!;
        yield* completeRun({ threadId: l2, runId: l2Run1.id, replyText: "L2 done." });
        yield* deliverDelegatedCompletionWake({
          parentThreadId: l1a,
          parentRunId: l1aRun1.id,
          modelSelection: env.modelSelection,
          commandId: "cmd:rw:l2-wake",
        });

        const l1aBeforeRead = yield* orchestrator.getThreadProjection(l1a);
        const wakeRun = l1aBeforeRead.runs.find((run) => run.ordinal === 2);
        assert.isDefined(wakeRun);
        assert.equal(wakeRun!.status, "queued");

        // L1-A reads L2 via t3_thread_read -> acknowledges L2 and cancels the redundant unstarted wake run (ordinal 2).
        const readL2Raw = yield* callTool(l1a, "t3_thread_read", { threadId: l2 });
        assert.notEqual(readL2Raw.isError, true);
        yield* worker.drain();

        const l1aAfterRead = yield* orchestrator.getThreadProjection(l1a);
        const cancelledWakeRun = l1aAfterRead.runs.find((run) => run.id === wakeRun!.id);
        assert.isDefined(cancelledWakeRun);
        assert.equal(cancelledWakeRun!.status, "cancelled");
        assert.isNull(cancelledWakeRun!.startedAt);

        // L1-A (still in active ordinal 1) calls t3_subtask_escalate -> must use active run 1, NOT cancelled wake run 2!
        const reqId = SubtaskEscalationRequestId.make("esc:rw:l1a-replay-1");
        const esc1Raw = yield* callTool(l1a, "t3_subtask_escalate", {
          requestId: reqId,
          task: "Create sibling L1 after L2 probe",
        });
        assert.notEqual(esc1Raw.isError, true, JSON.stringify(esc1Raw));
        const esc1 = yield* decodeSubtaskEscalateResult(esc1Raw.structuredContent);
        assert.equal(esc1.replayed, false);
        assert.equal(esc1.request.requestId, reqId);
        assert.equal(esc1.request.status, "pending");
        assert.equal(esc1.request.sourceRunId, l1aRun1.id);

        // Replaying with the exact same requestId must be idempotent (replayed: true, same inbox message, no duplicate run).
        const l0RunCountAfterFirst = (yield* orchestrator.getThreadProjection(l0)).runs.length;
        const esc2Raw = yield* callTool(l1a, "t3_subtask_escalate", {
          requestId: reqId,
          task: "Create sibling L1 after L2 probe",
        });
        assert.notEqual(esc2Raw.isError, true, JSON.stringify(esc2Raw));
        const esc2 = yield* decodeSubtaskEscalateResult(esc2Raw.structuredContent);
        assert.equal(esc2.replayed, true);
        assert.equal(esc2.request.requestId, reqId);
        assert.equal(esc2.request.inboxMessageId, esc1.request.inboxMessageId);
        assert.equal(esc2.request.inboxRunId, esc1.request.inboxRunId);
        assert.equal(
          (yield* orchestrator.getThreadProjection(l0)).runs.length,
          l0RunCountAfterFirst,
        );

        // Complete L1-A ordinal 1 after ordinal 2 was already cancelled before starting.
        yield* completeRun({ threadId: l1a, runId: l1aRun1.id, replyText: "L1-A finished." });
        yield* worker.drain();

        // Both t3_thread_list (children scope & project subagents) and t3_thread_read must agree on status: "completed" and latestRunId: l1aRun1.id.
        const listChildrenRaw = yield* callTool(l0, "t3_thread_list", {
          scope: "children",
          parentThreadId: l0,
        });
        assert.notEqual(listChildrenRaw.isError, true, JSON.stringify(listChildrenRaw));
        const listResult = yield* decodeThreadListResult(listChildrenRaw.structuredContent);
        const listedL1a = listResult.threads.find((thread) => thread.threadId === l1a);
        assert.isDefined(listedL1a);
        assert.equal(listedL1a!.status, "completed");
        assert.equal(listedL1a!.latestRunId, l1aRun1.id);

        const listProjectRaw = yield* callTool(l0, "t3_thread_list", {
          projectId,
          includeSubagents: true,
        });
        assert.notEqual(listProjectRaw.isError, true, JSON.stringify(listProjectRaw));
        const listProjectResult = yield* decodeThreadListResult(listProjectRaw.structuredContent);
        const listedProjectL1a = listProjectResult.threads.find(
          (thread) => thread.threadId === l1a,
        );
        assert.isDefined(listedProjectL1a);
        assert.equal(listedProjectL1a!.status, "completed");
        assert.equal(listedProjectL1a!.latestRunId, l1aRun1.id);

        const readL1aRaw = yield* callTool(l0, "t3_thread_read", { threadId: l1a });
        assert.notEqual(readL1aRaw.isError, true);
        const readL1a = yield* decodeThreadReadResult(readL1aRaw.structuredContent);
        assert.equal(readL1a.thread.status, "completed");
        assert.equal(readL1a.thread.latestRunId, l1aRun1.id);
        assert.equal(readL1a.thread.status, listedL1a!.status);
        assert.equal(readL1a.thread.latestRunId, listedL1a!.latestRunId);
        // Full run history still includes both ordinal 2 (cancelled wake) and ordinal 1 (completed).
        assert.equal(readL1a.recentRuns.length, 2);

        // t3_thread_wait without runId must also resolve to ordinal 1 ("completed"), not cancelled ordinal 2.
        const waitL1aRaw = yield* callTool(l0, "t3_thread_wait", { threadId: l1a });
        assert.notEqual(waitL1aRaw.isError, true, JSON.stringify(waitL1aRaw));
        const waitL1a = yield* decodeThreadWaitResult(waitL1aRaw.structuredContent);
        assert.equal(waitL1a.status, "completed");
        assert.equal(waitL1a.runId, l1aRun1.id);
        assert.equal(waitL1a.timedOut, false);
        assert.equal(waitL1a.status, listedL1a!.status);
        assert.equal(waitL1a.runId, readL1a.thread.latestRunId);
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "horizontal escalation succeeds after L2 completion wake and after prior sibling L1 completion with same-requestId replay, while blocking real recursive escalation loops",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const projectId = ProjectId.make("project:mcp-escalation-false-positive-fix");
      const env = makeMcpHarness({ projectId, capturedTurns });
      const l0a = ThreadId.make("thread:efp:l0a");
      const l0b = ThreadId.make("thread:efp:l0b");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

        for (const [threadId, title] of [
          [l0a, "Root L0-A (L2 wake case)"],
          [l0b, "Root L0-B (Sibling completion case)"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd:efp:create:${threadId}`),
            threadId,
            projectId,
            title,
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
            commandId: CommandId.make(`cmd:efp:start:${threadId}`),
            threadId,
            messageId: MessageId.make(`msg:efp:start:${threadId}`),
            text: `Start ${title}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        yield* worker.drain();

        // Case A2: L1-A delegates L2, finishes run 1, L2 completes and wakes L1-A into run 2 ([l0a, l2]), then L1-A escalates.
        const delL1aRaw = yield* callTool(l0a, "delegate_task", {
          title: "L1-A",
          task: "Run L2 then handle wake",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL1aRaw.isError, true);
        const delL1a = yield* decodeDelegateTaskResult(delL1aRaw.structuredContent);
        if (delL1a.childThreadId === null) assert.fail("Expected L1-A childThreadId");
        const l1a = delL1a.childThreadId;
        yield* worker.drain();

        const delL2Raw = yield* callTool(l1a, "delegate_task", {
          title: "L2-Leaf",
          task: "Return finding to L1-A",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL2Raw.isError, true);
        const delL2 = yield* decodeDelegateTaskResult(delL2Raw.structuredContent);
        if (delL2.childThreadId === null) assert.fail("Expected L2 childThreadId");
        const l2 = delL2.childThreadId;
        yield* worker.drain();

        const l1aRun1 = (yield* orchestrator.getThreadProjection(l1a)).runs[0]!;
        const l2Run1 = (yield* orchestrator.getThreadProjection(l2)).runs[0]!;
        yield* completeRun({ threadId: l1a, runId: l1aRun1.id, replyText: "Waiting on L2." });
        yield* completeRun({ threadId: l2, runId: l2Run1.id, replyText: "L2 result ready." });
        yield* deliverDelegatedCompletionWake({
          parentThreadId: l1a,
          parentRunId: l1aRun1.id,
          modelSelection: env.modelSelection,
          commandId: "cmd:efp:l2-wake",
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const l1aAfterWake = yield* orchestrator.getThreadProjection(l1a);
        const l1aRun2 = l1aAfterWake.runs.find((run) => run.ordinal === 2);
        assert.isDefined(l1aRun2);
        const l1aRun2Message = l1aAfterWake.messages.find((m) => m.id === l1aRun2!.userMessageId);
        assert.deepEqual(l1aRun2Message?.causationChain, [l0a, l2]);

        const reqA2 = SubtaskEscalationRequestId.make("esc:efp:after-l2-wake");
        const escA2FirstRaw = yield* callTool(l1a, "t3_subtask_escalate", {
          requestId: reqA2,
          task: "Escalate after receiving L2 wake",
        });
        assert.notEqual(escA2FirstRaw.isError, true, JSON.stringify(escA2FirstRaw));
        const escA2First = yield* decodeSubtaskEscalateResult(escA2FirstRaw.structuredContent);
        assert.equal(escA2First.replayed, false);
        assert.equal(escA2First.request.status, "pending");

        const escA2ReplayRaw = yield* callTool(l1a, "t3_subtask_escalate", {
          requestId: reqA2,
          task: "Escalate after receiving L2 wake",
        });
        assert.notEqual(escA2ReplayRaw.isError, true, JSON.stringify(escA2ReplayRaw));
        const escA2Replay = yield* decodeSubtaskEscalateResult(escA2ReplayRaw.structuredContent);
        assert.equal(escA2Replay.replayed, true);
        assert.equal(escA2Replay.request.inboxMessageId, escA2First.request.inboxMessageId);

        // Case B: L0-B delegates L1-1 -> L1-1 completes normally -> wakes L0-B ([L1-1]) -> L0-B delegates fresh L1-Esc ([L1-1, L0-B]).
        const delL1FirstRaw = yield* callTool(l0b, "delegate_task", {
          title: "L1-First",
          task: "Complete phase 1",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL1FirstRaw.isError, true);
        const delL1First = yield* decodeDelegateTaskResult(delL1FirstRaw.structuredContent);
        if (delL1First.childThreadId === null) assert.fail("Expected L1-First childThreadId");
        const l1First = delL1First.childThreadId;
        yield* worker.drain();

        const l0bRun1 = (yield* orchestrator.getThreadProjection(l0b)).runs[0]!;
        const l1FirstRun1 = (yield* orchestrator.getThreadProjection(l1First)).runs[0]!;
        yield* completeRun({ threadId: l0b, runId: l0bRun1.id, replyText: "Delegated phase 1." });
        yield* completeRun({
          threadId: l1First,
          runId: l1FirstRun1.id,
          replyText: "Phase 1 complete.",
        });
        yield* deliverDelegatedCompletionWake({
          parentThreadId: l0b,
          parentRunId: l0bRun1.id,
          modelSelection: env.modelSelection,
          commandId: "cmd:efp:l1first-wake",
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        // L0-B is now active on ordinal 2 (delegatedCompletion wake carrying [l1First]). Delegate fresh L1-Esc.
        const delL1EscRaw = yield* callTool(l0b, "delegate_task", {
          title: "L1-Esc",
          task: "Run fresh phase 2 subtask and escalate if needed",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL1EscRaw.isError, true);
        const delL1Esc = yield* decodeDelegateTaskResult(delL1EscRaw.structuredContent);
        if (delL1Esc.childThreadId === null) assert.fail("Expected L1-Esc childThreadId");
        const l1Esc = delL1Esc.childThreadId;
        yield* worker.drain();

        const l1EscProj = yield* orchestrator.getThreadProjection(l1Esc);
        const l1EscMsg = l1EscProj.messages.find((m) => m.id === l1EscProj.runs[0]!.userMessageId);
        assert.deepEqual(l1EscMsg?.causationChain, [l1First, l0b]);

        // L1-Esc's first escalation must succeed (NOT a false-positive loop!), and same-requestId replay must be idempotent.
        const reqB = SubtaskEscalationRequestId.make("esc:efp:fresh-after-sibling-done");
        const escB1Raw = yield* callTool(l1Esc, "t3_subtask_escalate", {
          requestId: reqB,
          task: "Need sibling L1-Peer from L0-B",
        });
        assert.notEqual(escB1Raw.isError, true, JSON.stringify(escB1Raw));
        const escB1 = yield* decodeSubtaskEscalateResult(escB1Raw.structuredContent);
        assert.equal(escB1.replayed, false);
        assert.equal(escB1.request.status, "pending");

        const escB2Raw = yield* callTool(l1Esc, "t3_subtask_escalate", {
          requestId: reqB,
          task: "Need sibling L1-Peer from L0-B",
        });
        assert.notEqual(escB2Raw.isError, true, JSON.stringify(escB2Raw));
        const escB2 = yield* decodeSubtaskEscalateResult(escB2Raw.structuredContent);
        assert.equal(escB2.replayed, true);
        assert.equal(escB2.request.inboxMessageId, escB1.request.inboxMessageId);

        // Explicit causationChain supplied by caller still cannot bypass loop protection.
        const explicitLoopRaw = yield* callTool(l1Esc, "t3_subtask_escalate", {
          requestId: SubtaskEscalationRequestId.make("esc:efp:explicit-chain-loop"),
          task: "Should fail when explicit causationChain includes root",
          causationChain: [l1First, l0b],
        });
        assert.equal(explicitLoopRaw.isError, true);
        assert.include(String(declaredFailure(explicitLoopRaw)?.message ?? ""), "causationChain");

        // Now finish L0-B ordinal 2 so L0-B runs the queued escalation inbox run (ordinal 3).
        const l0bRun2 = (yield* orchestrator.getThreadProjection(l0b)).runs.find(
          (run) => run.ordinal === 2,
        )!;
        yield* completeRun({ threadId: l0b, runId: l0bRun2.id, replyText: "Delegated phase 2." });
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        // Real loop 1: L0-B fulfills reqB via delegate_task({ escalationRequestId: reqB }) -> sibling tries escalating back -> REJECTED!
        const delLoopExplicitRaw = yield* callTool(l0b, "delegate_task", {
          title: "L1-Loop-Explicit",
          task: "Fulfill escalation reqB",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
          escalationRequestId: reqB,
        });
        assert.notEqual(delLoopExplicitRaw.isError, true);
        const delLoopExplicit = yield* decodeDelegateTaskResult(
          delLoopExplicitRaw.structuredContent,
        );
        if (delLoopExplicit.childThreadId === null) assert.fail("Expected explicit loop child");
        yield* worker.drain();

        const loopExplicitEscRaw = yield* callTool(
          delLoopExplicit.childThreadId,
          "t3_subtask_escalate",
          {
            requestId: SubtaskEscalationRequestId.make("esc:efp:recursive-explicit"),
            task: "Recursive escalation back to L0-B",
          },
        );
        assert.equal(loopExplicitEscRaw.isError, true);
        assert.include(
          String(declaredFailure(loopExplicitEscRaw)?.message ?? ""),
          "causationChain",
        );

        // Real loop 2: L0-B (still running the escalation inbox run) delegates another L1 WITHOUT escalationRequestId -> still REJECTED!
        const delLoopImplicitRaw = yield* callTool(l0b, "delegate_task", {
          title: "L1-Loop-Implicit",
          task: "Delegated inside escalation wake without escalationRequestId",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delLoopImplicitRaw.isError, true);
        const delLoopImplicit = yield* decodeDelegateTaskResult(
          delLoopImplicitRaw.structuredContent,
        );
        if (delLoopImplicit.childThreadId === null) assert.fail("Expected implicit loop child");
        yield* worker.drain();

        const loopImplicitEscRaw = yield* callTool(
          delLoopImplicit.childThreadId,
          "t3_subtask_escalate",
          {
            requestId: SubtaskEscalationRequestId.make("esc:efp:recursive-implicit"),
            task: "Implicit recursive escalation back to L0-B",
          },
        );
        assert.equal(loopImplicitEscRaw.isError, true);
        assert.include(
          String(declaredFailure(loopImplicitEscRaw)?.message ?? ""),
          "causationChain",
        );
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "horizontal escalation succeeds after L2 interim report wakes L1 via senderThreadId without delegatedCompletion",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const projectId = ProjectId.make("project:mcp-escalation-after-l2-interim");
      const env = makeMcpHarness({ projectId, capturedTurns });
      const l0 = ThreadId.make("thread:interim-esc:l0");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:interim-esc:create-l0"),
          threadId: l0,
          projectId,
          title: "Root L0 (L2 interim report escalation)",
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
          commandId: CommandId.make("cmd:interim-esc:start-l0"),
          threadId: l0,
          messageId: MessageId.make("msg:interim-esc:start-l0"),
          text: "Start L0",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const delL1Raw = yield* callTool(l0, "delegate_task", {
          title: "L1-Coordinator",
          task: "Delegate L2 and escalate if L2 reports a sibling dependency",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL1Raw.isError, true, JSON.stringify(delL1Raw));
        const delL1 = yield* decodeDelegateTaskResult(delL1Raw.structuredContent);
        if (delL1.childThreadId === null) assert.fail("Expected L1 childThreadId");
        const l1 = delL1.childThreadId;
        yield* worker.drain();

        const delL2Raw = yield* callTool(l1, "delegate_task", {
          title: "L2-Worker",
          task: "Send interim progress back to L1",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delL2Raw.isError, true, JSON.stringify(delL2Raw));
        const delL2 = yield* decodeDelegateTaskResult(delL2Raw.structuredContent);
        if (delL2.childThreadId === null) assert.fail("Expected L2 childThreadId");
        const l2 = delL2.childThreadId;
        yield* worker.drain();

        // L1 finishes ordinal 1 so L2's queued interim report wakes L1 into ordinal 2.
        const l1Run1 = (yield* orchestrator.getThreadProjection(l1)).runs[0]!;
        yield* completeRun({
          threadId: l1,
          runId: l1Run1.id,
          replyText: "Waiting for L2 interim progress.",
        });

        const interimSendRaw = yield* callTool(l2, "t3_thread_send", {
          threadId: l1,
          message: "L2 interim progress: discovered cross-module gap requiring sibling L1",
          mode: "queue",
          reportKind: "interim",
        });
        assert.notEqual(interimSendRaw.isError, true, JSON.stringify(interimSendRaw));
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const l1AfterInterim = yield* orchestrator.getThreadProjection(l1);
        const l1Run2 = l1AfterInterim.runs.find((run) => run.ordinal === 2);
        assert.isDefined(l1Run2);
        assert.equal(l1Run2!.status, "running");
        const l1Run2Message = l1AfterInterim.messages.find((m) => m.id === l1Run2!.userMessageId);
        assert.equal(l1Run2Message?.senderThreadId, l2);
        assert.isUndefined(l1Run2Message?.delegatedCompletion);
        assert.deepEqual(l1Run2Message?.causationChain, [l0, l2]);

        const reqId = SubtaskEscalationRequestId.make("esc:interim-esc:l1-after-l2-interim");
        const escFirstRaw = yield* callTool(l1, "t3_subtask_escalate", {
          requestId: reqId,
          task: "Spawn sibling L1 for gap surfaced by L2 interim report",
        });
        assert.notEqual(escFirstRaw.isError, true, JSON.stringify(escFirstRaw));
        const escFirst = yield* decodeSubtaskEscalateResult(escFirstRaw.structuredContent);
        assert.equal(escFirst.replayed, false);
        assert.equal(escFirst.request.status, "pending");
        assert.equal(escFirst.request.sourceRunId, l1Run2!.id);

        const escReplayRaw = yield* callTool(l1, "t3_subtask_escalate", {
          requestId: reqId,
          task: "Spawn sibling L1 for gap surfaced by L2 interim report",
        });
        assert.notEqual(escReplayRaw.isError, true, JSON.stringify(escReplayRaw));
        const escReplay = yield* decodeSubtaskEscalateResult(escReplayRaw.structuredContent);
        assert.equal(escReplay.replayed, true);
        assert.equal(escReplay.request.inboxMessageId, escFirst.request.inboxMessageId);
        assert.equal(escReplay.request.inboxRunId, escFirst.request.inboxRunId);

        // Explicit caller-supplied causationChain still cannot bypass loop protection.
        const explicitLoopRaw = yield* callTool(l1, "t3_subtask_escalate", {
          requestId: SubtaskEscalationRequestId.make("esc:interim-esc:explicit-loop"),
          task: "Should fail when explicit causationChain includes root",
          causationChain: [l0, l2],
        });
        assert.equal(explicitLoopRaw.isError, true);
        assert.include(String(declaredFailure(explicitLoopRaw)?.message ?? ""), "causationChain");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "t3_thread_list, t3_thread_read, and t3_thread_wait all surface a started second run as interrupted/cancelled after Stop instead of reverting to completed run 1",
    () => {
      const capturedTurns: Array<CapturedTurn> = [];
      const projectId = ProjectId.make("project:mcp-started-run2-stop-consistency");
      const env = makeMcpHarness({ projectId, capturedTurns });
      const l0 = ThreadId.make("thread:stop-run2:l0");

      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd:stop-run2:create-l0"),
          threadId: l0,
          projectId,
          title: "Root L0 (Started Run 2 Stop)",
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
          commandId: CommandId.make("cmd:stop-run2:start-l0"),
          threadId: l0,
          messageId: MessageId.make("msg:stop-run2:start-l0"),
          text: "Start L0",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        // Case A: Started ordinal 2 stopped via real Stop (t3_thread_interrupt { stop: true }) -> interrupted.
        const delStoppedRaw = yield* callTool(l0, "delegate_task", {
          title: "L1-Stopped-Run2",
          task: "Complete round 1",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delStoppedRaw.isError, true, JSON.stringify(delStoppedRaw));
        const delStopped = yield* decodeDelegateTaskResult(delStoppedRaw.structuredContent);
        if (delStopped.childThreadId === null)
          assert.fail("Expected L1-Stopped-Run2 childThreadId");
        const l1Stopped = delStopped.childThreadId;
        yield* worker.drain();

        const l1StoppedRun1 = (yield* orchestrator.getThreadProjection(l1Stopped)).runs[0]!;
        yield* completeRun({
          threadId: l1Stopped,
          runId: l1StoppedRun1.id,
          replyText: "Round 1 completed.",
        });

        const sendRun2Raw = yield* callTool(l0, "t3_thread_send", {
          threadId: l1Stopped,
          message: "Start round 2 work",
          mode: "auto",
        });
        assert.notEqual(sendRun2Raw.isError, true, JSON.stringify(sendRun2Raw));
        yield* worker.drain();

        const l1StoppedBeforeStop = yield* orchestrator.getThreadProjection(l1Stopped);
        const l1StoppedRun2 = l1StoppedBeforeStop.runs.find((run) => run.ordinal === 2);
        assert.isDefined(l1StoppedRun2);
        assert.equal(l1StoppedRun2!.status, "running");
        assert.isNotNull(l1StoppedRun2!.startedAt);

        const stopRaw = yield* callTool(l0, "t3_thread_interrupt", {
          threadId: l1Stopped,
          stop: true,
          reason: "Stop started second run",
          clientRequestId: "stop-run2-started",
        });
        assert.notEqual(stopRaw.isError, true, JSON.stringify(stopRaw));
        const stopRes = yield* decodeThreadInterruptResult(stopRaw.structuredContent);
        assert.equal(stopRes.status, "interrupt_requested");
        assert.equal(stopRes.runId, l1StoppedRun2!.id);
        yield* worker.drain();

        const l1StoppedAfterStop = yield* orchestrator.getThreadProjection(l1Stopped);
        const l1StoppedRun2After = l1StoppedAfterStop.runs.find(
          (run) => run.id === l1StoppedRun2!.id,
        );
        assert.equal(l1StoppedRun2After?.status, "interrupted");
        assert.isNotNull(l1StoppedRun2After?.startedAt);
        assert.isNotNull(l1StoppedRun2After?.completedAt);

        // Case B: Started ordinal 2 settled as status: "cancelled" (startedAt !== null) -> must NOT be skipped by outlivedBeforeStart.
        const delCancelledRaw = yield* callTool(l0, "delegate_task", {
          title: "L1-Started-Cancelled-Run2",
          task: "Complete round 1",
          target: {
            providerInstanceId: env.modelSelection.instanceId,
            model: env.modelSelection.model,
          },
          mode: "async",
        });
        assert.notEqual(delCancelledRaw.isError, true, JSON.stringify(delCancelledRaw));
        const delCancelled = yield* decodeDelegateTaskResult(delCancelledRaw.structuredContent);
        if (delCancelled.childThreadId === null)
          assert.fail("Expected L1-Started-Cancelled-Run2 childThreadId");
        const l1Cancelled = delCancelled.childThreadId;
        yield* worker.drain();

        const l1CancelledRun1 = (yield* orchestrator.getThreadProjection(l1Cancelled)).runs[0]!;
        yield* completeRun({
          threadId: l1Cancelled,
          runId: l1CancelledRun1.id,
          replyText: "Round 1 completed.",
        });

        const sendCancelledRun2Raw = yield* callTool(l0, "t3_thread_send", {
          threadId: l1Cancelled,
          message: "Start round 2 that gets cancelled after start",
          mode: "auto",
        });
        assert.notEqual(sendCancelledRun2Raw.isError, true, JSON.stringify(sendCancelledRun2Raw));
        yield* worker.drain();

        const l1CancelledProj = yield* orchestrator.getThreadProjection(l1Cancelled);
        const l1CancelledRun2 = l1CancelledProj.runs.find((run) => run.ordinal === 2)!;
        assert.equal(l1CancelledRun2.status, "running");
        assert.isNotNull(l1CancelledRun2.startedAt);
        const l1CancelledAttempt2 = l1CancelledProj.attempts.find(
          (a) => a.id === l1CancelledRun2.activeAttemptId,
        )!;
        const l1CancelledNode2 = l1CancelledProj.nodes.find(
          (n) => n.id === l1CancelledRun2.rootNodeId,
        )!;
        const cancelNow = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`ev:${l1CancelledRun2.id}:run-cancelled`),
              type: "run.updated",
              threadId: l1Cancelled,
              runId: l1CancelledRun2.id,
              nodeId: l1CancelledNode2.id,
              providerInstanceId: l1CancelledRun2.providerInstanceId,
              occurredAt: cancelNow,
              payload: {
                ...l1CancelledRun2,
                status: "cancelled",
                completedAt: cancelNow,
              },
            },
            {
              id: EventId.make(`ev:${l1CancelledRun2.id}:attempt-cancelled`),
              type: "run-attempt.updated",
              threadId: l1Cancelled,
              runId: l1CancelledRun2.id,
              nodeId: l1CancelledNode2.id,
              providerInstanceId: l1CancelledRun2.providerInstanceId,
              occurredAt: cancelNow,
              payload: {
                ...l1CancelledAttempt2,
                status: "cancelled",
                completedAt: cancelNow,
              },
            },
            {
              id: EventId.make(`ev:${l1CancelledRun2.id}:node-cancelled`),
              type: "node.updated",
              threadId: l1Cancelled,
              runId: l1CancelledRun2.id,
              nodeId: l1CancelledNode2.id,
              providerInstanceId: l1CancelledRun2.providerInstanceId,
              occurredAt: cancelNow,
              payload: {
                ...l1CancelledNode2,
                status: "cancelled",
                completedAt: cancelNow,
              },
            },
          ],
        });
        yield* worker.drain();

        const listChildrenRaw = yield* callTool(l0, "t3_thread_list", { scope: "children" });
        assert.notEqual(listChildrenRaw.isError, true, JSON.stringify(listChildrenRaw));
        const listChildren = yield* decodeThreadListResult(listChildrenRaw.structuredContent);

        const listAllRaw = yield* callTool(l0, "t3_thread_list", {
          projectId,
          includeSubagents: true,
        });
        assert.notEqual(listAllRaw.isError, true, JSON.stringify(listAllRaw));
        const listAll = yield* decodeThreadListResult(listAllRaw.structuredContent);

        for (const expected of [
          {
            threadId: l1Stopped,
            runId: l1StoppedRun2!.id,
            status: "interrupted" as const,
          },
          {
            threadId: l1Cancelled,
            runId: l1CancelledRun2.id,
            status: "cancelled" as const,
          },
        ]) {
          const childItem = listChildren.threads.find((t) => t.threadId === expected.threadId);
          assert.isDefined(childItem);
          assert.equal(childItem!.status, expected.status);
          assert.equal(childItem!.latestRunId, expected.runId);

          const projectItem = listAll.threads.find((t) => t.threadId === expected.threadId);
          assert.isDefined(projectItem);
          assert.equal(projectItem!.status, expected.status);
          assert.equal(projectItem!.latestRunId, expected.runId);

          const readRaw = yield* callTool(l0, "t3_thread_read", { threadId: expected.threadId });
          assert.notEqual(readRaw.isError, true, JSON.stringify(readRaw));
          const readRes = yield* decodeThreadReadResult(readRaw.structuredContent);
          assert.equal(readRes.thread.status, expected.status);
          assert.equal(readRes.thread.latestRunId, expected.runId);
          assert.equal(readRes.thread.activeRunId, null);
          assert.equal(readRes.recentRuns.length, 2);

          const waitRaw = yield* callTool(l0, "t3_thread_wait", { threadId: expected.threadId });
          assert.notEqual(waitRaw.isError, true, JSON.stringify(waitRaw));
          const waitRes = yield* decodeThreadWaitResult(waitRaw.structuredContent);
          assert.equal(waitRes.status, expected.status);
          assert.equal(waitRes.runId, expected.runId);
          assert.equal(waitRes.timedOut, false);
        }
      }).pipe(Effect.provide(env.layer));
    },
  );
});

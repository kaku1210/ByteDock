import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
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
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
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

const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

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
}) {
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
  const layerToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(layerThreads),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        layerAdapters,
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
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
                  workspaceRoot: process.cwd(),
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
});

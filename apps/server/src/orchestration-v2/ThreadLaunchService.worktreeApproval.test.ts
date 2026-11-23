import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type WorktreeApprovalRequest,
  type WorktreeApprovalStatus,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorktreeApproval from "./WorktreeApprovalService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:wt-gate");
const BASE_COMMIT_SHA = "1111111111111111111111111111111111111111";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Worktree Gate Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(options: { readonly ttlMs?: number } = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "worktree-approval-gate" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest();
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerWorktreeApproval = WorktreeApproval.layerWithConfig({
    defaultTtlMs: options.ttlMs ?? 60_000,
  }).pipe(Layer.provide(layerDatabase));

  let worktreeCounter = 0;
  const createdWorktrees = Queue.unbounded<string>().pipe(Effect.runSync);
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(
    (input) => {
      worktreeCounter += 1;
      const worktreePath = `/repo-worktrees/wt-${worktreeCounter}`;
      Queue.offerUnsafe(createdWorktrees, worktreePath);
      return Effect.succeed({
        worktree: {
          path: worktreePath,
          refName: input.newRefName ?? "main",
          headSha: BASE_COMMIT_SHA,
        },
      } as never);
    },
  );

  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(CheckpointStore.CheckpointStore)({ isGitRepository: () => Effect.succeed(true) }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      workspaceScanDirectory: () => Effect.die("unused"),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      repositoryRoot: () => Effect.succeed(project.workspaceRoot),
      createWorktree,
      renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
      fetchWorktreeBaseCommit: () =>
        Effect.succeed({ commitSha: BASE_COMMIT_SHA, remoteRefName: "origin/main" }),
      hasCommit: () => Effect.succeed(true),
      resolveCommit: () => Effect.succeed({ commitSha: BASE_COMMIT_SHA }),
      currentBranch: () => Effect.succeed("main"),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      listLocalBranchNames: () => Effect.succeed([]),
      removeWorktree: () => Effect.void,
      deleteLocalBranch: () => Effect.void,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Child task" }),
      generateBranchName: () => Effect.succeed({ branch: "child-worktree-branch" }),
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
    Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
  );

  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        layerOrchestrator,
        layerWorktreeApproval,
        IdAllocator.layer,
      ),
    ),
  );

  return {
    createWorktree,
    createdWorktrees,
    layer: Layer.mergeAll(
      layerLaunch,
      layerWorktreeApproval,
      layerThreadManagement,
      layerOrchestrator,
      layerExternalServices,
      layerDatabase,
    ),
  };
}

const awaitApprovalStatus = (
  threadId: ThreadId,
  status: WorktreeApprovalStatus,
): Effect.Effect<WorktreeApprovalRequest, never, WorktreeApproval.WorktreeApprovalService> =>
  Effect.gen(function* () {
    const approvals = yield* WorktreeApproval.WorktreeApprovalService;
    const matched = yield* approvals.streamForThread(threadId).pipe(
      Stream.map((event) => event.requests.find((request) => request.status === status)),
      Stream.filter((request): request is WorktreeApprovalRequest => request !== undefined),
      Stream.runHead,
    );
    if (Option.isNone(matched)) {
      throw new Error(`Worktree approval stream ended before reaching status ${status}.`);
    }
    return matched.value;
  });

const awaitRunStatus = (
  threadId: ThreadId,
  runId: string,
  predicate: (status: string) => boolean,
  afterSequence = 0,
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const current = yield* threads.getThreadRecords(threadId, ["runs"], {
      runIds: [runId as never],
    });
    const existing = current.runs.find((candidate) => candidate.id === runId);
    if (existing !== undefined && predicate(existing.status)) {
      return existing.status;
    }
    const matched = yield* threads.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === runId &&
          predicate(stored.event.payload.status),
      ),
      Stream.map((stored) =>
        stored.event.type === "run.updated" ? stored.event.payload.status : "",
      ),
      Stream.runHead,
    );
    if (Option.isNone(matched)) {
      throw new Error(`Event stream for ${threadId} ended before run ${runId} matched predicate.`);
    }
    return matched.value;
  });

const createParentAndDelegatedWorktreeTask = (suffix: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;

    const parentThreadId = ThreadId.make(`thread:parent-${suffix}`);
    const parentLaunched = yield* launches.launch({
      commandId: CommandId.make(`cmd:create-parent-${suffix}`),
      threadId: parentThreadId,
      projectId,
      title: "Parent thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      createdBy: "user",
      creationSource: "web",
      initialMessage: {
        messageId: MessageId.make(`msg:parent-${suffix}`),
        text: "Delegate a task",
        attachments: [],
      },
    });
    const parentRun = parentLaunched.projection.runs[0];
    if (parentRun === undefined || parentRun.rootNodeId === null) {
      throw new Error("Expected parent run with rootNodeId");
    }

    const delegateCommandId = CommandId.make(`cmd:delegate-${suffix}`);
    const delegated = yield* threads.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: delegateCommandId,
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId,
      task: "Run isolated worktree refactor",
      title: "Isolated child",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: {
        type: "worktree",
        baseRef: BASE_COMMIT_SHA,
        startFromOrigin: false,
      },
    });
    const taskEvent = delegated.storedEvents.find(
      (stored) =>
        stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
    );
    assert.isDefined(taskEvent);
    if (
      taskEvent?.event.type !== "subagent.updated" ||
      taskEvent.event.payload.childThreadId === null
    ) {
      throw new Error("Expected delegated task subagent event");
    }
    const taskId = taskEvent.event.payload.id;
    const childThreadId = taskEvent.event.payload.childThreadId;
    const childRunEvent = delegated.storedEvents.find(
      (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
    );
    assert.isDefined(childRunEvent);
    if (childRunEvent?.event.type !== "run.created") {
      throw new Error("Expected child run.created");
    }
    const childRunId = childRunEvent.event.payload.id;

    yield* launches.prepareRun({
      commandId: delegateCommandId,
      threadId: childThreadId,
      runId: childRunId,
    });

    return {
      parentThreadId,
      parentRunId: parentRun.id,
      taskId,
      childThreadId,
      childRunId,
      delegateCommandId,
    };
  });

it.effect(
  "blocks AI delegated worktree creation until human approval, then provisions exactly once even across replays",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const approvals = yield* WorktreeApproval.WorktreeApprovalService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;

      const ctx = yield* createParentAndDelegatedWorktreeTask("approve");

      const pending = yield* awaitApprovalStatus(ctx.parentThreadId, "pending");
      assert.equal(pending.status, "pending");
      assert.equal(pending.projectId, projectId);
      assert.equal(pending.parentThreadId, ctx.parentThreadId);
      assert.equal(pending.parentRunId, ctx.parentRunId);
      assert.equal(pending.parentTaskId, ctx.taskId);
      assert.equal(pending.childThreadId, ctx.childThreadId);
      assert.equal(pending.childRunId, ctx.childRunId);
      assert.equal(pending.baseCommitSha, BASE_COMMIT_SHA);
      assert.equal(harness.createWorktree.mock.calls.length, 0);

      // Human approves the pending request
      yield* approvals.resolveByHuman({
        requestId: pending.requestId,
        decision: "approve",
      });

      const createdPath = yield* Queue.take(harness.createdWorktrees);
      assert.equal(createdPath, "/repo-worktrees/wt-1");
      const nextStatus = yield* awaitRunStatus(
        ctx.childThreadId,
        ctx.childRunId,
        (status) => status !== "preparing",
      );
      assert.notEqual(nextStatus, "failed");

      const { thread } = yield* threads.getThreadRecords(ctx.childThreadId, ["runs"]);
      assert.equal(harness.createWorktree.mock.calls.length, 1);
      assert.equal(thread.worktreePath, "/repo-worktrees/wt-1");

      const persisted = yield* approvals.getById(pending.requestId);
      assert.equal(Option.getOrThrow(persisted).approvedWorktreePath, "/repo-worktrees/wt-1");

      // Replaying prepareRun must NEVER create a second worktree
      yield* launches.prepareRun({
        commandId: CommandId.make("cmd:delegate-approve-replay"),
        threadId: ctx.childThreadId,
        runId: ctx.childRunId,
      });
      yield* Effect.yieldNow;
      assert.equal(harness.createWorktree.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("keeps createWorktree at 0 on human denial and prevents retry bypass", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const approvals = yield* WorktreeApproval.WorktreeApprovalService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;

    const ctx = yield* createParentAndDelegatedWorktreeTask("deny");

    const pending = yield* awaitApprovalStatus(ctx.childThreadId, "pending");
    assert.equal(pending.status, "pending");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    yield* approvals.resolveByHuman({
      requestId: pending.requestId,
      decision: "deny",
      reason: "Use shared checkout instead",
    });

    const failedStatus = yield* awaitRunStatus(
      ctx.childThreadId,
      ctx.childRunId,
      (status) => status === "failed",
    );
    assert.equal(failedStatus, "failed");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    // Retrying preparation after denial must STILL fail without creating a worktree
    const seqBeforeRetry = yield* threads.getThreadEventSequence(ctx.childThreadId);
    yield* launches.retryPreparation({
      commandId: CommandId.make("cmd:retry-after-deny"),
      threadId: ctx.childThreadId,
      runId: ctx.childRunId,
    });
    const failedAgain = yield* awaitRunStatus(
      ctx.childThreadId,
      ctx.childRunId,
      (status) => status === "failed",
      seqBeforeRetry,
    );
    assert.equal(failedAgain, "failed");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("expires pending worktree approval after TTL with createWorktree === 0", () => {
  const harness = makeHarness({ ttlMs: 30_000 });
  return Effect.gen(function* () {
    const approvals = yield* WorktreeApproval.WorktreeApprovalService;

    const ctx = yield* createParentAndDelegatedWorktreeTask("expire");

    const pending = yield* awaitApprovalStatus(ctx.childThreadId, "pending");
    assert.equal(pending.status, "pending");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    yield* TestClock.adjust(Duration.seconds(31));

    const expired = yield* awaitApprovalStatus(ctx.childThreadId, "expired");
    assert.equal(expired.status, "expired");
    const failedStatus = yield* awaitRunStatus(
      ctx.childThreadId,
      ctx.childRunId,
      (status) => status === "failed",
    );
    assert.equal(failedStatus, "failed");
    assert.equal(harness.createWorktree.mock.calls.length, 0);

    const persisted = yield* approvals.getById(pending.requestId);
    assert.equal(Option.getOrThrow(persisted).status, "expired");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "cancels pending worktree approval when parent task is cancelled with createWorktree === 0",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;

      const ctx = yield* createParentAndDelegatedWorktreeTask("cancel-parent");

      const pending = yield* awaitApprovalStatus(ctx.parentThreadId, "pending");
      assert.equal(pending.status, "pending");
      assert.equal(harness.createWorktree.mock.calls.length, 0);

      // Parent stops / cancels the delegated task
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("cmd:stop-parent-thread"),
        threadId: ctx.parentThreadId,
        stopDelegatedTasks: true,
      });

      const cancelledApproval = yield* awaitApprovalStatus(ctx.parentThreadId, "cancelled");
      assert.equal(cancelledApproval.status, "cancelled");
      assert.equal(harness.createWorktree.mock.calls.length, 0);

      const failedStatus = yield* awaitRunStatus(
        ctx.childThreadId,
        ctx.childRunId,
        (status) => status === "failed",
      );
      assert.equal(failedStatus, "failed");
      assert.equal(harness.createWorktree.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "gates AI-initiated ThreadLaunchService.launch(worktree) while allowing user-initiated worktree launches directly",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const approvals = yield* WorktreeApproval.WorktreeApprovalService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;

      // 1. User-initiated launch creates worktree immediately without approval row
      const userLaunched = yield* launches.launch({
        commandId: CommandId.make("cmd:user-wt-launch"),
        projectId,
        title: "User worktree task",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        initialMessage: {
          messageId: MessageId.make("msg:user-wt-launch"),
          text: "User worktree task",
          attachments: [],
        },
      });
      const userWorktree = yield* Queue.take(harness.createdWorktrees);
      assert.equal(userWorktree, "/repo-worktrees/wt-1");
      const userApprovals = yield* approvals.listForThread(userLaunched.threadId);
      assert.equal(userApprovals.length, 0);

      // 2. AI-initiated launch (e.g. t3_thread_launch via MCP) MUST block before createWorktree
      const aiLaunched = yield* launches.launch({
        commandId: CommandId.make("cmd:ai-wt-launch"),
        projectId,
        title: "AI worktree task",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
        createdBy: "agent",
        creationSource: "mcp",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        initialMessage: {
          messageId: MessageId.make("msg:ai-wt-launch"),
          text: "AI worktree task",
          attachments: [],
        },
      });
      const pendingAi = yield* awaitApprovalStatus(aiLaunched.threadId, "pending");
      assert.equal(pendingAi.status, "pending");
      assert.equal(harness.createWorktree.mock.calls.length, 1);

      // Approving creates exactly one additional worktree (total = 2)
      yield* approvals.resolveByHuman({
        requestId: pendingAi.requestId,
        decision: "approve",
      });
      const aiWorktree = yield* Queue.take(harness.createdWorktrees);
      assert.equal(aiWorktree, "/repo-worktrees/wt-2");
      assert.equal(harness.createWorktree.mock.calls.length, 2);
    }).pipe(Effect.provide(harness.layer));
  },
);

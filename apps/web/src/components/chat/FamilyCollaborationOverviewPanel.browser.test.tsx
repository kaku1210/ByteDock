import "~/index.css";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  IsoDateTime,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type FamilyCollaborationGetOverviewInput,
  type FamilyCollaborationOverview,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadDetailsPreferences } from "./threadDetailsPreferences";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  type FakeDriver,
  type FakeThread,
  dispatchedCommands,
  installFakeEnvironment,
  runningRun,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("~/i18n/runtime"), async () => {
  const english = {
    locale: "en",
    formattingLocale: undefined,
    translations: { en: {} },
  };
  return {
    getI18nSnapshot: () => english,
    subscribeI18n: () => () => {},
    persistGTLocale: () => {},
    startI18n: () => {},
    whenLocaleReady: () => Promise.resolve(),
    getFormattingLocale: () => undefined,
  };
});

function pinThreadDetailsOpen(): Disposable {
  const previous = useThreadDetailsPreferences.getState();
  useThreadDetailsPreferences.setState({ pinned: true, open: true, detailsCollapsed: false });
  return {
    [Symbol.dispose]() {
      useThreadDetailsPreferences.setState(previous);
    },
  };
}

function enableTestSettings() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    confirmThreadDelete: false,
  });
}

it("renders L0 -> L1 -> L2 collaboration overview read-only, navigates nodes, and targets Stop accurately", async () => {
  using _registry = { [Symbol.dispose]: () => appAtomRegistry.reset() };
  using _details = pinThreadDetailsOpen();
  const l0Base = threadWithHistory("collab-ui-l0", 1);
  const l1ActiveBase = threadWithHistory("collab-ui-l1-active", 0);
  const l1Active: FakeThread = {
    ...l1ActiveBase,
    title: "L1 Active Delegated",
    subtaskOf: l0Base.id,
    rootThreadId: l0Base.id,
    runs: [runningRun(l1ActiveBase.id, "run:l1-active:1", 1, "u:l1-active:1")],
  };
  const l1PreRun: FakeThread = {
    ...threadWithHistory("collab-ui-l1-prerun", 0),
    title: "L1 Queued Delegation",
    subtaskOf: l0Base.id,
    rootThreadId: l0Base.id,
  };
  const l0: FakeThread = {
    ...l0Base,
    subagents: [
      {
        id: NodeId.make("node:delegated:l1-prerun"),
        threadId: l0Base.id,
        runId: l0Base.runs[0]!.id,
        parentNodeId: NodeId.make("node:l0:root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        childThreadId: l1PreRun.id,
        nativeTaskRef: null,
        model: "gpt-5.4",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        prompt: "Queued pre-run delegation",
        title: l1PreRun.title,
        completionWake: "always",
        status: "pending",
        result: null,
        startedAt: DateTime.makeUnsafe("2026-10-20T00:00:00.000Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-10-20T00:00:00.000Z"),
      },
    ],
  };
  const l2Leaf: FakeThread = {
    ...threadWithHistory("collab-ui-l2-leaf", 1),
    title: "L2 Leaf Subtask",
    subtaskOf: l1Active.id,
    rootThreadId: l0.id,
  };
  const sideChat: FakeThread = {
    ...threadWithHistory("collab-ui-sidechat", 0),
    title: "Root Side Chat",
    sideChatOf: l0.id,
    rootThreadId: l0.id,
  };

  const overviewCalls: Array<FamilyCollaborationGetOverviewInput> = [];
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const nowIso = IsoDateTime.make("2026-10-20T00:00:00.000Z");

  const makeOverview = (
    input: FamilyCollaborationGetOverviewInput,
  ): FamilyCollaborationOverview => ({
    rootThreadId: l0.id,
    requestedThreadId: input.threadId,
    projectId: ProjectId.make("project-1"),
    generatedAt: nowIso,
    readOnlyGuaranteed: true,
    nodes: [
      {
        threadId: l0.id,
        parentThreadId: null,
        rootThreadId: l0.id,
        depth: 0,
        nodeKind: "root",
        createdBy: "user",
        title: l0.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: "/workspace",
        branch: "main",
        usesSharedWorktree: true,
        isCurrentThread: input.threadId === l0.id,
        isArchived: false,
        settled: false,
        sessionStatus: "running",
        queuedMessageCount: 0,
        taskStatus: "running",
        activeRunId: RunId.make("run:l0:active"),
        delegatedTaskId: null,
        blockingKind: null,
        blockingReason: null,
        canStop: true,
        deliveryStatus: "none",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: null,
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
      {
        threadId: l1Active.id,
        parentThreadId: l0.id,
        rootThreadId: l0.id,
        depth: 1,
        nodeKind: "subtask",
        createdBy: "agent",
        title: l1Active.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: "/workspace",
        branch: "main",
        usesSharedWorktree: true,
        isCurrentThread: input.threadId === l1Active.id,
        isArchived: false,
        settled: false,
        sessionStatus: "running",
        queuedMessageCount: 0,
        taskStatus: "running",
        activeRunId: RunId.make("run:l1-active:1"),
        delegatedTaskId: NodeId.make("node:delegated:l1-active"),
        blockingKind: null,
        blockingReason: null,
        canStop: true,
        deliveryStatus: "none",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: "Running L1 work",
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
      {
        threadId: l2Leaf.id,
        parentThreadId: l1Active.id,
        rootThreadId: l0.id,
        depth: 2,
        nodeKind: "subtask",
        createdBy: "user",
        title: l2Leaf.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: "/workspace",
        branch: "main",
        usesSharedWorktree: true,
        isCurrentThread: input.threadId === l2Leaf.id,
        isArchived: false,
        settled: false,
        sessionStatus: "idle",
        queuedMessageCount: 0,
        taskStatus: "completed",
        activeRunId: null,
        delegatedTaskId: null,
        blockingKind: null,
        blockingReason: null,
        canStop: false,
        deliveryStatus: "pending_merge_back",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 1,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: "L2 leaf finished",
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
      {
        threadId: l1PreRun.id,
        parentThreadId: l0.id,
        rootThreadId: l0.id,
        depth: 1,
        nodeKind: "subtask",
        createdBy: "agent",
        title: l1PreRun.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: "/workspace",
        branch: "main",
        usesSharedWorktree: true,
        isCurrentThread: input.threadId === l1PreRun.id,
        isArchived: false,
        settled: false,
        sessionStatus: "awaiting_initial_send",
        queuedMessageCount: 0,
        taskStatus: "queued",
        activeRunId: null,
        delegatedTaskId: NodeId.make("node:delegated:l1-prerun"),
        blockingKind: null,
        blockingReason: null,
        canStop: true,
        deliveryStatus: "none",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: null,
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
    ],
    sideChats: [
      {
        threadId: sideChat.id,
        title: sideChat.title,
        sessionStatus: "awaiting_initial_send",
        temporary: false,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        updatedAt: nowIso,
      },
    ],
    pendingEscalations: [],
    pendingWorktreeApprovals: [],
    sharedWorktree: null,
    summary: input.includeSummary
      ? {
          l0Count: 1,
          l1Count: 2,
          l2Count: 1,
          sideChatCount: 1,
          remoteCount: 0,
          runningCount: 2,
          blockedCount: 0,
          awaitingInitialSendCount: 1,
          completedCount: 1,
          failedCount: 0,
          pendingDeliveryCount: 0,
          pendingMergeBackCount: 1,
          pendingEscalationCount: 0,
          pendingWorktreeApprovalCount: 0,
          overlapCount: 0,
          observedUnverifiedCount: 0,
          highlights: ["L2 Leaf Subtask has 1 pending Bring back."],
          markdownDigest: "# Dynamic Family Summary\n- Pending merge-back: 1",
        }
      : null,
  });

  using _environment = installFakeEnvironment([l0, l1Active, l1PreRun, l2Leaf, sideChat], {
    acceptCommands: true,
    familyCollaborationOverview: (input) => {
      overviewCalls.push(input);
      return Effect.succeed(makeOverview(input));
    },
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l0.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  // Open Collaboration Overview from Thread details Lineage header.
  const openOverviewBtn = screen.getByTestId("open-collaboration-overview");
  await expect.element(openOverviewBtn).toBeVisible();
  await openOverviewBtn.click();

  await expect.element(screen.getByTestId("family-collaboration-overview")).toBeVisible();
  await expect
    .element(screen.getByTestId("collaboration-topology-counts"))
    .toHaveTextContent("L0: 1 · L1: 2 · L2: 1 · Side chats: 1");
  await expect
    .element(screen.getByTestId("collaboration-readonly-badge"))
    .toHaveTextContent("Read-only · does not acknowledge deliveries");

  // Expand L2 details, click Refresh, and Generate summary -> strictly read-only (0 commands dispatched).
  await screen.getByTestId(`collaboration-node-expand-${l2Leaf.id}`).click();
  await expect.element(screen.getByText("L2 leaf finished")).toBeVisible();
  await screen.getByTestId("collaboration-refresh").click();
  await screen.getByTestId("collaboration-summary-trigger").click();
  await expect.element(screen.getByText("Dynamic Family Summary")).toBeVisible();
  expect(overviewCalls.some((call) => call.includeSummary === true)).toBe(true);
  const writeCommands = () =>
    dispatchedCommands().filter((command) => command.type !== "thread.visit");
  expect(writeCommands()).toHaveLength(0);

  // Stop on active delegated child dispatches stop targeting the child thread itself (never parent).
  await screen.getByTestId(`collaboration-node-stop-${l1Active.id}`).click();
  await vi.waitFor(() => expect(writeCommands()).toHaveLength(1));
  expect(["run.interrupt", "thread.stop"]).toContain(writeCommands()[0]?.type);
  expect(writeCommands()[0]).toMatchObject({
    threadId: l1Active.id,
  });

  // Stop on pre-run delegated child (no activeRunId/queued runs yet) stops parent's subagent record.
  await screen.getByTestId(`collaboration-node-stop-${l1PreRun.id}`).click();
  await vi.waitFor(() => expect(writeCommands()).toHaveLength(2));
  expect(writeCommands()[1]).toMatchObject({
    type: "subagent.stop",
    threadId: l0.id,
    subagentId: NodeId.make("node:delegated:l1-prerun"),
  });

  // Clicking L2 node navigates router to L2 thread route.
  await screen.getByTestId(`collaboration-node-open-${l2Leaf.id}`).click();
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${l2Leaf.id}`);
  });
});

it("displays L0 Coordinator and L1 Sub-Coordinator routing with overrides and quick-toggles L1 Sub-Coordinator mode", async () => {
  using _registry = { [Symbol.dispose]: () => appAtomRegistry.reset() };
  using _details = pinThreadDetailsOpen();
  const l0 = threadWithHistory("collab-coord-l0", 1);
  const l1Lead: FakeThread = {
    ...threadWithHistory("collab-coord-l1-lead", 0),
    title: "Episode 1 Lead",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l1Direct: FakeThread = {
    ...threadWithHistory("collab-coord-l1-direct", 0),
    title: "Episode 2 Direct",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l2Specialist: FakeThread = {
    ...threadWithHistory("collab-coord-l2-specialist", 0),
    title: "Storyboard Specialist",
    subtaskOf: l1Lead.id,
    rootThreadId: l0.id,
  };

  const codexInstance = ProviderInstanceId.make("codex");
  const claudeInstance = ProviderInstanceId.make("claudeAgent");
  const nowIso = IsoDateTime.make("2026-10-20T00:00:00.000Z");

  const makeOverview = (
    input: FamilyCollaborationGetOverviewInput,
  ): FamilyCollaborationOverview => ({
    rootThreadId: l0.id,
    requestedThreadId: input.threadId,
    projectId: ProjectId.make("project-1"),
    generatedAt: nowIso,
    readOnlyGuaranteed: true,
    nodes: [
      {
        threadId: l0.id,
        parentThreadId: null,
        rootThreadId: l0.id,
        depth: 0,
        nodeKind: "root",
        createdBy: "user",
        title: l0.title,
        modelSelection: { instanceId: codexInstance, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        coordinatorMode: {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L1: { instanceId: codexInstance, model: "gpt-5.5" },
          },
        },
        worktreePath: null,
        branch: null,
        usesSharedWorktree: false,
        isCurrentThread: input.threadId === l0.id,
        isArchived: false,
        settled: false,
        sessionStatus: "idle",
        queuedMessageCount: 0,
        taskStatus: "none",
        activeRunId: null,
        delegatedTaskId: null,
        blockingKind: null,
        blockingReason: null,
        canStop: false,
        deliveryStatus: "none",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: null,
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
      {
        threadId: l1Lead.id,
        parentThreadId: l0.id,
        rootThreadId: l0.id,
        depth: 1,
        nodeKind: "subtask",
        createdBy: "agent",
        title: l1Lead.title,
        modelSelection: { instanceId: codexInstance, model: "gpt-5.5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        coordinatorMode: {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L2: { instanceId: claudeInstance, model: "claude-opus-4-6" },
          },
        },
        worktreePath: null,
        branch: null,
        usesSharedWorktree: false,
        isCurrentThread: input.threadId === l1Lead.id,
        isArchived: false,
        settled: false,
        sessionStatus: "idle",
        queuedMessageCount: 0,
        taskStatus: "running",
        activeRunId: null,
        delegatedTaskId: null,
        blockingKind: null,
        blockingReason: null,
        canStop: false,
        deliveryStatus: "none",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: "Drafting episode outline",
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
      {
        threadId: l2Specialist.id,
        parentThreadId: l1Lead.id,
        rootThreadId: l0.id,
        depth: 2,
        nodeKind: "subtask",
        createdBy: "agent",
        title: l2Specialist.title,
        modelSelection: { instanceId: claudeInstance, model: "claude-opus-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: null,
        branch: null,
        usesSharedWorktree: false,
        isCurrentThread: input.threadId === l2Specialist.id,
        isArchived: false,
        settled: false,
        sessionStatus: "idle",
        queuedMessageCount: 0,
        taskStatus: "completed",
        activeRunId: null,
        delegatedTaskId: null,
        blockingKind: null,
        blockingReason: null,
        canStop: false,
        deliveryStatus: "delivered",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: "Storyboard shots ready",
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
      {
        threadId: l1Direct.id,
        parentThreadId: l0.id,
        rootThreadId: l0.id,
        depth: 1,
        nodeKind: "subtask",
        createdBy: "agent",
        title: l1Direct.title,
        modelSelection: { instanceId: codexInstance, model: "gpt-5.5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        coordinatorMode: null,
        worktreePath: null,
        branch: null,
        usesSharedWorktree: false,
        isCurrentThread: input.threadId === l1Direct.id,
        isArchived: false,
        settled: false,
        sessionStatus: "idle",
        queuedMessageCount: 0,
        taskStatus: "running",
        activeRunId: null,
        delegatedTaskId: null,
        blockingKind: null,
        blockingReason: null,
        canStop: false,
        deliveryStatus: "none",
        delegatedDeliveryState: null,
        pendingMergeBackCount: 0,
        boundMergeBackCount: 0,
        deliveredMergeBackCount: 0,
        interimReportCount: 0,
        finalReportCount: 0,
        latestArtifactSummary: null,
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservationPaths: [],
        hasPathOverlap: false,
        remoteChildren: [],
        updatedAt: nowIso,
      },
    ],
    sideChats: [],
    pendingEscalations: [],
    pendingWorktreeApprovals: [],
    sharedWorktree: null,
    summary: null,
  });

  using _environment = installFakeEnvironment([l0, l1Lead, l1Direct, l2Specialist], {
    acceptCommands: true,
    providers: [CODEX_PROVIDER, CLAUDE_PROVIDER],
    familyCollaborationOverview: (input) => Effect.succeed(makeOverview(input)),
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l0.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await screen.getByTestId("open-collaboration-overview").click();
  await expect.element(screen.getByTestId("family-collaboration-overview")).toBeVisible();

  // L0 Coordinator badge shows localized template name, General scene badge, and override chip.
  await expect
    .element(screen.getByTestId(`collaboration-node-coordinator-${l0.id}`))
    .toHaveTextContent("Coordinator: General Batch Collaboration");
  await expect
    .element(screen.getByTestId(`collaboration-node-scene-${l0.id}`))
    .toHaveTextContent("General");
  await expect
    .element(screen.getByTestId(`collaboration-node-overrides-${l0.id}`))
    .toHaveTextContent("L1: GPT-5.5");

  // L1 Sub-Coordinator badge shows Sub-Coordinator role, template name, and L2 override chip.
  await expect
    .element(screen.getByTestId(`collaboration-node-coordinator-${l1Lead.id}`))
    .toHaveTextContent("Sub-Coordinator: General Batch Collaboration");
  await expect
    .element(screen.getByTestId(`collaboration-node-overrides-${l1Lead.id}`))
    .toHaveTextContent("L2: Claude Opus 4.6");

  // Expand L0 & L1 to inspect expanded Coordinator routing details.
  await screen.getByTestId(`collaboration-node-expand-${l0.id}`).click();
  await expect
    .element(screen.getByTestId(`collaboration-node-coordinator-details-${l0.id}`))
    .toBeVisible();
  await expect
    .element(screen.getByTestId(`collaboration-node-coordinator-tier-${l0.id}-L1`))
    .toHaveTextContent("L1 GPT-5.5 (This thread)");
  await expect
    .element(screen.getByTestId(`collaboration-node-coordinator-tier-${l0.id}-L2`))
    .toHaveTextContent("L2 Follows current");

  await screen.getByTestId(`collaboration-node-expand-${l1Lead.id}`).click();
  await expect
    .element(screen.getByTestId(`collaboration-node-coordinator-tier-${l1Lead.id}-L2`))
    .toHaveTextContent("L2 Claude Opus 4.6 (This thread)");

  // Quick-toggle button appears only on L1 subtasks, never on L0 or L2.
  await expect
    .element(screen.getByTestId(`collaboration-node-toggle-subcoordinator-${l0.id}`))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId(`collaboration-node-toggle-subcoordinator-${l2Specialist.id}`))
    .not.toBeInTheDocument();

  const coordinatorCommands = () =>
    dispatchedCommands().filter((command) => command.type === "thread.coordinator-mode.set");
  expect(coordinatorCommands()).toHaveLength(0);

  // Promoting an OFF L1 subtask inherits L0's templateId.
  await screen.getByTestId(`collaboration-node-toggle-subcoordinator-${l1Direct.id}`).click();
  await vi.waitFor(() => expect(coordinatorCommands()).toHaveLength(1));
  expect(coordinatorCommands()[0]).toMatchObject({
    type: "thread.coordinator-mode.set",
    threadId: l1Direct.id,
    coordinatorMode: {
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    },
  });

  // Disabling an ON L1 Sub-Coordinator preserves its templateId and tierModelOverrides.
  await screen.getByTestId(`collaboration-node-toggle-subcoordinator-${l1Lead.id}`).click();
  await vi.waitFor(() => expect(coordinatorCommands()).toHaveLength(2));
  expect(coordinatorCommands()[1]).toMatchObject({
    type: "thread.coordinator-mode.set",
    threadId: l1Lead.id,
    coordinatorMode: {
      enabled: false,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L2: { instanceId: claudeInstance, model: "claude-opus-4-6" },
      },
    },
  });
});

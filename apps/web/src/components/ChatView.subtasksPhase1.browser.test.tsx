import "~/index.css";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import {
  ContextTransferId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { useThreadDetailsPreferences } from "./chat/threadDetailsPreferences";
import {
  ENVIRONMENT_ID,
  type FakeDriver,
  type FakeThread,
  addEnvironmentThread,
  assistantItem,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

const AT = DateTime.makeUnsafe("2026-03-17T19:15:00.000Z");

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("~/i18n/runtime"), async () => {
  const { getClientSettings, subscribeClientSettings } = await import("~/hooks/useSettings");
  const { resolveLanguagePreference } = await import("@t3tools/shared/uiLanguage");
  const zh = (await import("~/i18n/translations/zh.json")).default;
  const english = { locale: "en", translations: { en: {} } };
  const chinese = { locale: "zh", translations: { zh } };
  return {
    getI18nSnapshot: () =>
      resolveLanguagePreference(getClientSettings()).startsWith("zh") ? chinese : english,
    subscribeI18n: subscribeClientSettings,
    persistGTLocale: () => {},
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

it("splits a persistent subtask from assistant text on L0, allows split on L1, and hides split on L2", async () => {
  const l0 = threadWithHistory("subtask-l0", 1);
  const l1Existing: FakeThread = {
    ...threadWithHistory("subtask-l1-existing", 1),
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l2Existing: FakeThread = {
    ...threadWithHistory("subtask-l2-existing", 1),
    subtaskOf: l1Existing.id,
    rootThreadId: l0.id,
  };

  using _environment = installFakeEnvironment([l0, l1Existing, l2Existing], {
    acceptCommands: true,
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l0.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  // 1. On L0: select assistant text and click "Split subtask"
  const l0Text = `Answer 0 for ${l0.id}.`;
  await expect.element(screen.getByText(l0Text, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(l0Text, { exact: true }));
  const splitButton = page.getByRole("button", { name: "Split selection into subtask" });
  await expect.element(splitButton).toBeVisible();
  await splitButton.click();

  await vi.waitFor(() =>
    expect(dispatchedCommands().filter((command) => command.type === "thread.fork")).toHaveLength(
      1,
    ),
  );
  const fork = dispatchedCommands().find((command) => command.type === "thread.fork");
  if (!fork || fork.type !== "thread.fork") throw new Error("Missing subtask fork command");
  expect(fork).toMatchObject({
    sourceThreadId: l0.id,
    subtask: true,
    sourcePoint: { type: "run", runId: RunId.make(`${l0.id}-run-0`) },
    sourceAnchor: {
      sourceThreadId: l0.id,
      sourceRunId: RunId.make(`${l0.id}-run-0`),
      sourceMessageId: `${l0.id}-assistant-0`,
    },
  });
  expect(fork.sourceAnchor?.excerpt).toContain(l0Text);
  // Must NOT auto-send a message into the new subtask.
  expect(
    dispatchedCommands().filter((command) => command.type === "message.dispatch"),
  ).toHaveLength(0);

  // Server delivers the created subtask shell -> client navigates to it with citation draft prefilled.
  const createdL1: FakeThread = {
    ...threadWithHistory(fork.targetThreadId, 0),
    title: "Split subtask",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  await addEnvironmentThread(createdL1);

  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${createdL1.id}`);
  });
  const createdRef = scopeThreadRef(ENVIRONMENT_ID, createdL1.id);
  const draftPrompt = useComposerDraftStore.getState().getComposerDraft(createdRef)?.prompt ?? "";
  const citations = collectAssistantCitations(draftPrompt);
  expect(citations).toHaveLength(1);
  expect(citations[0]?.citation.text.trim()).toContain(l0Text);

  // 2. On L1: Split subtask is still offered (depth 1 < MAX_TASK_TREE_DEPTH 2).
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${l1Existing.id}` });
  const l1Text = `Answer 0 for ${l1Existing.id}.`;
  await expect.element(screen.getByText(l1Text, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(l1Text, { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Split selection into subtask" }))
    .toBeVisible();

  // 3. On L2: Cite is still offered, but Split subtask is hidden by depth cap L2.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${l2Existing.id}` });
  const l2Text = `Answer 0 for ${l2Existing.id}.`;
  await expect.element(screen.getByText(l2Text, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(l2Text, { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Cite selection in composer" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Split selection into subtask" }))
    .not.toBeInTheDocument();
});

it("supports active report-to-parent and passive merge-back from an L1 subtask lineage panel", async () => {
  using _details = pinThreadDetailsOpen();
  const l0 = threadWithHistory("report-l0", 1);
  const l1: FakeThread = {
    ...threadWithHistory("report-l1", 1),
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };

  using _environment = installFakeEnvironment([l0, l1], { acceptCommands: true });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l1.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await expect.element(screen.getByText(`Answer 0 for ${l1.id}.`, { exact: true })).toBeVisible();

  // Active report button sends message.dispatch with childReport metadata carrying the real assistant reply text.
  const reportButton = page.getByRole("button", { name: `Send result to ${l0.title}` });
  await expect.element(reportButton).toBeVisible();
  await reportButton.click();

  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "message.dispatch"),
    ).toHaveLength(1),
  );
  const reportCmd = dispatchedCommands().find((command) => command.type === "message.dispatch");
  if (!reportCmd || reportCmd.type !== "message.dispatch") {
    throw new Error("Missing message.dispatch report command");
  }
  expect(reportCmd).toMatchObject({
    threadId: l0.id,
    senderThreadId: l1.id,
    dispatchMode: { type: "queue_after_active" },
    childReport: {
      childThreadId: l1.id,
      childRunId: RunId.make(`${l1.id}-run-0`),
      reportKind: "final",
    },
  });
  expect(reportCmd.text).toContain(`Answer 0 for ${l1.id}.`);
  await expect
    .element(page.getByText("Sent result to parent queue", { exact: true }))
    .toBeVisible();

  // Passive merge-back button sends thread.merge_back targeting L0 and navigates back to L0.
  const mergeButton = page.getByRole("button", { name: `Merge back to ${l0.title}` });
  await expect.element(mergeButton).toBeVisible();
  await mergeButton.click();

  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.merge_back"),
    ).toHaveLength(1),
  );
  const mergeCmd = dispatchedCommands().find((command) => command.type === "thread.merge_back");
  if (!mergeCmd || mergeCmd.type !== "thread.merge_back") {
    throw new Error("Missing thread.merge_back command");
  }
  expect(mergeCmd).toMatchObject({
    sourceThreadId: l1.id,
    targetThreadId: l0.id,
    sourcePoint: { type: "run", runId: RunId.make(`${l1.id}-run-0`) },
  });
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${l0.id}`);
  });
});

it("displays multiple pending merge-backs in the parent composer banner and revokes individual chips", async () => {
  const l1a = threadWithHistory("pool-l1a", 1);
  const l1b = threadWithHistory("pool-l1b", 1);
  const transferA = ContextTransferId.make("transfer-pool-a");
  const transferB = ContextTransferId.make("transfer-pool-b");
  const baseL0 = threadWithHistory("pool-l0", 1);
  const l0: FakeThread = {
    ...baseL0,
    contextTransfers: [
      {
        id: transferA,
        type: "merge_back",
        sourceThreadId: l1a.id,
        targetThreadId: baseL0.id,
        sourcePoint: { threadId: l1a.id, runId: RunId.make(`${l1a.id}-run-0`) },
        basePoint: null,
        sourceProviderInstanceId: null,
        targetProviderInstanceId: null,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "user",
        error: null,
        createdAt: AT,
        updatedAt: AT,
        consumedAt: null,
      },
      {
        id: transferB,
        type: "merge_back",
        sourceThreadId: l1b.id,
        targetThreadId: baseL0.id,
        sourcePoint: { threadId: l1b.id, runId: RunId.make(`${l1b.id}-run-0`) },
        basePoint: null,
        sourceProviderInstanceId: null,
        targetProviderInstanceId: null,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "user",
        error: null,
        createdAt: AT,
        updatedAt: AT,
        consumedAt: null,
      },
    ],
  };

  using _environment = installFakeEnvironment(
    [
      l0,
      { ...l1a, subtaskOf: l0.id, rootThreadId: l0.id },
      { ...l1b, subtaskOf: l0.id, rootThreadId: l0.id },
    ],
    { acceptCommands: true },
  );
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l0.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await expect
    .element(screen.getByText("2 thread conclusions will attach to your next message"))
    .toBeVisible();
  const removeA = screen.getByRole("button", { name: `Remove ${l1a.title} from next message` });
  const removeB = screen.getByRole("button", { name: `Remove ${l1b.title} from next message` });
  await expect.element(removeA).toBeVisible();
  await expect.element(removeB).toBeVisible();

  await removeA.click();
  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.merge_back.revoke"),
    ).toHaveLength(1),
  );
  expect(
    dispatchedCommands().find((command) => command.type === "thread.merge_back.revoke"),
  ).toMatchObject({
    threadId: l0.id,
    transferId: transferA,
  });
});

it("shows L0 root-scoped side chats inside L1 subtask details and brings back to L0", async () => {
  using _details = pinThreadDetailsOpen();
  const l0 = threadWithHistory("side-root-l0", 1);
  const l1: FakeThread = {
    ...threadWithHistory("side-root-l1", 1),
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const rootSideChat: FakeThread = {
    ...threadWithHistory("side-root-chat", 1),
    sideChatOf: l0.id,
    rootThreadId: l0.id,
  };

  using _environment = installFakeEnvironment([l0, l1, rootSideChat], { acceptCommands: true });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l1.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await expect.element(screen.getByText(`Answer 0 for ${l1.id}.`, { exact: true })).toBeVisible();

  // While viewing L1, L0's root-scoped Side Chat must appear in the Side chats panel.
  const sideChatRow = page.getByRole("button", { name: new RegExp(rootSideChat.title) });
  await expect.element(sideChatRow).toBeVisible();
  await sideChatRow.click();

  // Clicking it opens the SideChatPane in L1's right panel.
  await expect
    .element(screen.getByRole("textbox", { name: `Message ${rootSideChat.title}`, exact: true }))
    .toBeVisible();

  // Clicking "Bring back" targets L0 (the root thread), not L1.
  const bringBackButton = screen.getByRole("button", { name: "Bring back", exact: true });
  await expect.element(bringBackButton).toBeVisible();
  await bringBackButton.click();

  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.merge_back"),
    ).toHaveLength(1),
  );
  expect(
    dispatchedCommands().find((command) => command.type === "thread.merge_back"),
  ).toMatchObject({
    sourceThreadId: rootSideChat.id,
    targetThreadId: l0.id,
    sourcePoint: { type: "run", runId: RunId.make(`${rootSideChat.id}-run-0`) },
  });
  useRightPanelStore.getState().close(scopeThreadRef(ENVIRONMENT_ID, l1.id));
});

it("warns about subtasks, side chats, and pending bring-backs before cascade-deleting L0 and clears descendant drafts", async () => {
  const l0 = threadWithHistory("cascade-del-l0", 1);
  const other = threadWithHistory("cascade-del-other", 1);
  const l1: FakeThread = {
    ...threadWithHistory("cascade-del-l1", 1),
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l2: FakeThread = {
    ...threadWithHistory("cascade-del-l2", 1),
    subtaskOf: l1.id,
    rootThreadId: l0.id,
  };
  const sideChat: FakeThread = {
    ...threadWithHistory("cascade-del-side", 1),
    sideChatOf: l0.id,
    rootThreadId: l0.id,
  };

  using _environment = installFakeEnvironment([l0, l1, l2, sideChat, other], {
    acceptCommands: true,
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const l1Ref = scopeThreadRef(ENVIRONMENT_ID, l1.id);
  const l2Ref = scopeThreadRef(ENVIRONMENT_ID, l2.id);
  useComposerDraftStore.getState().setPrompt(l1Ref, "Unsent L1 draft");
  useComposerDraftStore.getState().setPrompt(l2Ref, "Unsent L2 draft");

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l0.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await expect.element(screen.getByText(`Answer 0 for ${l0.id}.`, { exact: true })).toBeVisible();

  // Right-click L0 in the sidebar and choose Delete -> real confirmation dialog must appear even with confirmThreadDelete=false.
  const sidebarItem = screen.getByRole("button", { name: new RegExp(l0.title) }).first();
  await expect.element(sidebarItem).toBeVisible();
  await userEvent.click(sidebarItem, { button: "right" });
  const deleteMenuItem = page.getByRole("menuitem", { name: "Delete", exact: true });
  await expect.element(deleteMenuItem).toBeVisible();
  await deleteMenuItem.click();

  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  const dialogText = dialog.element().textContent ?? "";
  expect(dialogText).toContain("This will also delete 2 subtasks and 1 side chat");
  expect(dialogText).toContain("cancel any pending bring-back items");
  expect(dialogText).toContain(l1.title);
  expect(dialogText).toContain(l2.title);

  // Confirm deletion -> dispatches thread.delete for L0 and clears descendant drafts.
  const confirmButton = dialog.getByRole("button", { name: /Delete|Confirm/i });
  await confirmButton.click();

  await vi.waitFor(() =>
    expect(dispatchedCommands().filter((command) => command.type === "thread.delete")).toHaveLength(
      1,
    ),
  );
  expect(dispatchedCommands().find((command) => command.type === "thread.delete")).toMatchObject({
    threadId: l0.id,
  });
  await vi.waitFor(() => {
    expect(useComposerDraftStore.getState().getComposerDraft(l1Ref)).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(l2Ref)).toBeNull();
  });
});

it("opens L0 root-scoped side chat from an isolated-worktree L2, blocks nesting, and targets Side Chat checkout for terminal and tool diff (Scenario 4)", async () => {
  using _details = pinThreadDetailsOpen();
  const l0: FakeThread = {
    ...threadWithHistory("s4-l0", 1),
    title: "Root Checkout Task",
    worktreePath: null,
  };
  const l1: FakeThread = {
    ...threadWithHistory("s4-l1", 1),
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l2: FakeThread = {
    ...threadWithHistory("s4-l2", 1),
    subtaskOf: l1.id,
    rootThreadId: l0.id,
    worktreePath: "/workspace/wt-l2",
    branch: "feat/l2-isolated",
  };

  const baseSideChat = threadWithHistory("s4-side-chat", 1);
  const sideRunId = RunId.make(`${baseSideChat.id}-run-0`);
  const sideFileChangeId = TurnItemId.make(`${baseSideChat.id}-file-change-0`);
  const sideFileChangeItem: OrchestrationV2TurnItem = {
    id: sideFileChangeId,
    threadId: baseSideChat.id,
    runId: sideRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2,
    status: "completed",
    title: null,
    startedAt: AT,
    completedAt: AT,
    updatedAt: AT,
    type: "file_change",
    fileName: "/workspace/render/src/root-helper.ts",
    additions: 1,
    deletions: 1,
    oldStr: "export const a = 1;\n",
    newStr: "export const a = 2;\n",
    diffStr:
      "diff --git a/src/root-helper.ts b/src/root-helper.ts\n--- a/src/root-helper.ts\n+++ b/src/root-helper.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
  };
  const rootSideChat: FakeThread = {
    ...baseSideChat,
    title: "Root Side Chat",
    sideChatOf: l0.id,
    rootThreadId: l0.id,
    worktreePath: null,
    items: [
      baseSideChat.items[0]!,
      assistantItem(
        baseSideChat.id,
        sideRunId,
        `${baseSideChat.id}-assistant-0`,
        1,
        "Side chat root insight.\n\n```sh\necho side-chat-check\n```",
      ),
      sideFileChangeItem,
    ],
  };

  const terminalOpenCalls: Array<{
    readonly threadId: string;
    readonly cwd: string;
    readonly worktreePath?: string | null;
  }> = [];
  const getTurnItemCalls: Array<{
    readonly threadId: string;
    readonly itemId: string;
  }> = [];

  using _environment = installFakeEnvironment([l0, l1, l2, rootSideChat], {
    acceptCommands: true,
    rpcHandlers: {
      [WS_METHODS.terminalOpen]: (input: {
        readonly threadId: string;
        readonly terminalId: string;
        readonly cwd: string;
        readonly worktreePath?: string | null;
      }) => {
        terminalOpenCalls.push({
          threadId: input.threadId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
        });
        return Effect.succeed({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "running",
          pid: 4242,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Terminal",
          updatedAt: "2026-03-17T19:15:00.000Z",
        });
      },
      [WS_METHODS.terminalWrite]: () => Effect.void,
      [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input: {
        readonly threadId: string;
        readonly itemId: string;
      }) => {
        getTurnItemCalls.push({ threadId: input.threadId, itemId: input.itemId });
        return Effect.succeed({
          item: sideFileChangeItem,
        });
      },
    },
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l2.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await expect.element(screen.getByText(`Answer 0 for ${l2.id}.`, { exact: true })).toBeVisible();

  // 1. From L2, L0's root-scoped Side Chat appears identically to L0/L1 and opens in the right panel.
  const sideChatRow = page.getByRole("button", { name: new RegExp(rootSideChat.title) });
  await expect.element(sideChatRow).toBeVisible();
  await sideChatRow.click();

  const sideChatPane = document.querySelector(`[data-side-chat-pane="${rootSideChat.id}"]`);
  expect(sideChatPane).not.toBeNull();
  await expect.element(screen.getByText("Side chat root insight.", { exact: true })).toBeVisible();

  // 2. Bring back button explicitly indicates targeting L0's next message and dispatches merge_back -> L0.
  const bringBackButton = screen.getByRole("button", { name: "Bring back", exact: true });
  await expect.element(bringBackButton).toBeVisible();
  await userEvent.hover(bringBackButton);
  await expect
    .element(
      page.getByText(`Adds this side chat to "${l0.title}"'s next message.`, { exact: true }),
    )
    .toBeVisible();

  await bringBackButton.click();
  await vi.waitFor(() =>
    expect(
      dispatchedCommands().filter((command) => command.type === "thread.merge_back"),
    ).toHaveLength(1),
  );
  expect(
    dispatchedCommands().find((command) => command.type === "thread.merge_back"),
  ).toMatchObject({
    sourceThreadId: rootSideChat.id,
    targetThreadId: l0.id,
  });

  // 3. Inside Side Chat: cannot split a nested subtask or open a nested Side Chat.
  await userEvent.tripleClick(screen.getByText("Side chat root insight.", { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Cite selection in composer" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Split selection into subtask" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Ask in side chat" }))
    .not.toBeInTheDocument();

  // 4. Running a shell command from inside Side Chat targets Side Chat's checkout (/workspace/render),
  // NOT L2's isolated worktree (/workspace/wt-l2).
  const runTerminalButton = page.getByRole("button", { name: "Run in terminal" }).first();
  await expect.element(runTerminalButton).toBeVisible();
  await runTerminalButton.click();

  await vi.waitFor(() => {
    expect(terminalOpenCalls.length).toBeGreaterThanOrEqual(1);
  });
  expect(terminalOpenCalls[0]).toMatchObject({
    cwd: "/workspace/render",
    worktreePath: null,
  });

  // 5. Opening Side Chat's file_change diff from inside L2 resolves diff paths against Side Chat's checkout
  // (/workspace/render/src/root-helper.ts), NOT L2's isolated worktree (/workspace/wt-l2/...).
  const clipboardSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  try {
    const workGroupToggle = page.getByRole("button", { name: /^Worked for/ }).first();
    await expect.element(workGroupToggle).toBeVisible();
    await workGroupToggle.click();

    const fileChangeTrigger = page.getByRole("button", { name: /Changed 1 file/ }).first();
    await expect.element(fileChangeTrigger).toBeVisible();
    await fileChangeTrigger.click();

    // V2ItemInspector formats against Side Chat's checkout (/workspace/render -> render/src/root-helper.ts),
    // NOT L2's isolated worktree (/workspace/wt-l2).
    await expect
      .element(page.getByText("render/src/root-helper.ts", { exact: true }).first())
      .toBeVisible();

    const openDiffButton = page.getByRole("button", { name: "Open diff", exact: true }).first();
    await expect.element(openDiffButton).toBeVisible();
    await openDiffButton.click();

    await vi.waitFor(() => {
      expect(getTurnItemCalls).toContainEqual({
        threadId: rootSideChat.id,
        itemId: sideFileChangeId,
      });
    });

    const copyPathButton = page.getByRole("button", { name: "Copy file path" }).first();
    await expect.element(copyPathButton).toBeVisible();
    await copyPathButton.click();

    await vi.waitFor(() => {
      expect(clipboardSpy).toHaveBeenCalledWith("src/root-helper.ts");
    });
  } finally {
    clipboardSpy.mockRestore();
    useRightPanelStore.getState().close(scopeThreadRef(ENVIRONMENT_ID, l2.id));
  }
});

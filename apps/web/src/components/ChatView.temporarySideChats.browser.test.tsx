import "~/index.css";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { MessageId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { useClosedViewStore } from "~/closedViewStore";
import { getRouter } from "~/router";
import { useManualThreadTasks } from "./chat/manualThreadTasks";
import { useThreadDetailsPreferences } from "./chat/threadDetailsPreferences";
import {
  type FakeDriver,
  type FakeThread,
  ENVIRONMENT_ID,
  addEnvironmentThread,
  dispatchedCommands,
  installFakeEnvironment,
  rejectPendingCommand,
  threadWithHistory,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

it("lets a click on a long side-chat suggestion focus the empty editor", async () => {
  const parent = threadWithHistory("suggestion-parent", 1);
  const side = {
    ...threadWithHistory("suggestion-side", 1),
    sideChatOf: parent.id,
    olderSettled: true as const,
  };
  const suggestion = "请同步完主分支后，复跑编译检查和全部测试，再验证完整流程。".repeat(4);
  using _environment = installFakeEnvironment([parent, side], {
    suggestPrompt: ({ threadId }) =>
      Effect.succeed({ suggestion: threadId === side.id ? suggestion : null }),
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  useRightPanelStore.getState().openSideChat(scopeThreadRef(ENVIRONMENT_ID, parent.id), side.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
  const preview = screen.getByText(suggestion, { exact: true });
  await expect.element(preview).toBeVisible();
  const bounds = preview.element().getBoundingClientRect();
  const hit = document.elementFromPoint(bounds.left + 12, bounds.top + 8);
  expect(editor.element().contains(hit)).toBe(true);
  await preview.click({ position: { x: 12, y: 8 }, force: true });
  await expect.element(editor).toHaveFocus();
  await userEvent.keyboard("my draft");
  expect(editor.element().textContent).toBe("my draft");
  await editor.fill("");
  await expect.element(preview).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(editor).toHaveTextContent(suggestion);
});

it.each(["empty", "draft", "used", "ordinary", "hidden", "creating"] as const)(
  "temporary chat button reuses only the visible unused temporary chat (%s)",
  async (kind) => {
    const parent = threadWithHistory(`reuse-parent-${kind}`, 1);
    const side = {
      ...threadWithHistory(`reuse-side-${kind}`, kind === "used" ? 1 : 0),
      sideChatOf: parent.id,
      temporary: kind !== "ordinary",
      olderSettled: true as const,
    };
    using _environment = installFakeEnvironment([parent, side], { acceptCommands: true });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    await page.viewport(1400, 900);
    const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
    const sideRef = scopeThreadRef(ENVIRONMENT_ID, side.id);
    if (kind === "draft") useComposerDraftStore.getState().setPrompt(sideRef, "Keep my draft");
    if (kind !== "creating") {
      useRightPanelStore.getState().openSideChat(parentRef, side.id, side.temporary);
      if (kind === "hidden") useRightPanelStore.getState().close(parentRef);
    }
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
    );
    await router.load();
    await using screen = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    const button = screen.getByRole("button", { name: "Open temporary side chat", exact: true });
    if (kind !== "creating" && kind !== "hidden") {
      await expect
        .element(screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true }))
        .toBeVisible();
    }
    await button.click();
    await button.click();
    let target: FakeThread = side;
    if (kind !== "empty") {
      await vi.waitFor(() =>
        expect(
          dispatchedCommands().filter((command) => command.type === "thread.fork"),
        ).toHaveLength(1),
      );
      const fork = dispatchedCommands().find((command) => command.type === "thread.fork");
      if (!fork || fork.type !== "thread.fork") throw new Error("Missing temporary chat fork");
      target = {
        ...threadWithHistory(fork.targetThreadId, 0),
        title: fork.title ?? "Temporary side chat",
        sideChatOf: parent.id,
        temporary: true,
      };
      await addEnvironmentThread(target);
    }
    await expect
      .element(screen.getByRole("textbox", { name: `Message ${target.title}`, exact: true }))
      .toBeVisible();
    await button.click();
    expect(dispatchedCommands().filter((command) => command.type === "thread.fork")).toHaveLength(
      kind === "empty" ? 0 : 1,
    );
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef),
    ).toMatchObject({ kind: "side-chat", threadId: target.id });
    if (kind === "draft")
      expect(useComposerDraftStore.getState().getComposerDraft(sideRef)?.prompt).toBe(
        "Keep my draft",
      );
  },
);

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

it.each(["temporary", "ordinary", "hidden", "other-tab", "none"] as const)(
  "Slid Cite appends to the visible side chat or creates a temporary one (%s)",
  async (panel) => {
    const parent = threadWithHistory(`slid-cite-${panel}`, 1);
    const side = {
      ...threadWithHistory(`slid-cite-side-${panel}`, 1),
      sideChatOf: parent.id,
      temporary: panel !== "ordinary",
      olderSettled: true as const,
    };
    using _environment = installFakeEnvironment([parent, side], { acceptCommands: true });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    await page.viewport(1400, 900);
    const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
    const sideRef = scopeThreadRef(ENVIRONMENT_ID, side.id);
    useComposerDraftStore.getState().setPrompt(parentRef, "Keep the main draft");
    useComposerDraftStore.getState().setPrompt(sideRef, "Existing side draft");
    const panels = useRightPanelStore.getState();
    if (panel !== "none") panels.openSideChat(parentRef, side.id, side.temporary);
    if (panel === "hidden") panels.close(parentRef);
    if (panel === "other-tab") panels.openFile(parentRef, "README.md");
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
    );
    await router.load();
    await using screen = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    const sourceText = `Answer 0 for ${parent.id}.`;
    await expect.element(screen.getByText(sourceText, { exact: true })).toBeVisible();
    const reuse = panel === "temporary" || panel === "ordinary";
    if (reuse) {
      const existingSideEditor = screen.getByRole("textbox", {
        name: `Message ${side.title}`,
        exact: true,
      });
      await expect.element(existingSideEditor).toBeVisible();
      await existingSideEditor.click();
      await userEvent.keyboard("{ControlOrMeta>}{End}{/ControlOrMeta} with unsent edits");
    }
    const sideDraftBefore =
      useComposerDraftStore.getState().getComposerDraft(sideRef)?.prompt ?? "";
    if (reuse) expect(sideDraftBefore).toBe("Existing side draft with unsent edits");
    await userEvent.tripleClick(screen.getByText(sourceText, { exact: true }));
    const slidCite = page.getByRole("button", { name: "Cite selection in side chat" });
    await expect.element(slidCite).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect
      .element(page.getByRole("button", { name: "Cite selection in composer" }))
      .toHaveFocus();
    await userEvent.keyboard("{Tab}");
    await expect.element(slidCite).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    let target: FakeThread = side;
    if (!reuse) {
      await vi.waitFor(() =>
        expect(
          dispatchedCommands().filter((command) => command.type === "thread.fork"),
        ).toHaveLength(1),
      );
      const fork = dispatchedCommands().find((command) => command.type === "thread.fork");
      if (!fork || fork.type !== "thread.fork") throw new Error("Missing side chat fork");
      expect(fork).toMatchObject({ sourceThreadId: parent.id, sideChat: true, temporary: true });
      target = {
        ...threadWithHistory(fork.targetThreadId, 0),
        title: fork.title ?? "Temporary side chat",
        sideChatOf: parent.id,
        temporary: true,
      };
      await addEnvironmentThread(target);
    }
    const targetRef = scopeThreadRef(ENVIRONMENT_ID, target.id);
    const sideEditor = screen.getByRole("textbox", {
      name: `Message ${target.title}`,
      exact: true,
    });
    await vi.waitFor(() => expect(sideEditor.element().textContent).toContain(sourceText));
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, parentRef),
    ).toMatchObject({
      kind: "side-chat",
      threadId: target.id,
    });
    await expect
      .element(screen.getByRole("textbox", { name: `Message ${parent.title}`, exact: true }))
      .toHaveTextContent("Keep the main draft");
    if (reuse) expect(sideEditor.element().textContent).toContain("Existing side draft");
    else
      expect(useComposerDraftStore.getState().getComposerDraft(sideRef)?.prompt).toBe(
        "Existing side draft",
      );

    const firstPrompt = useComposerDraftStore.getState().getComposerDraft(targetRef)?.prompt ?? "";
    const firstCitations = collectAssistantCitations(firstPrompt);
    expect(firstCitations).toHaveLength(1);
    expect(firstPrompt.slice(0, firstCitations[0]!.start).trimEnd()).toBe(
      reuse ? sideDraftBefore : "",
    );

    await sideEditor.click();
    await userEvent.keyboard("{ControlOrMeta>}{End}{/ControlOrMeta} Keep this follow-up draft.");
    const draftBeforeSecond =
      useComposerDraftStore.getState().getComposerDraft(targetRef)?.prompt ?? "";
    expect(draftBeforeSecond).toContain("Keep this follow-up draft.");
    expect(collectAssistantCitations(draftBeforeSecond)).toHaveLength(1);

    await userEvent.tripleClick(screen.getByText(sourceText, { exact: true }).first());
    await slidCite.click();
    await vi.waitFor(() => {
      const prompt = useComposerDraftStore.getState().getComposerDraft(targetRef)?.prompt ?? "";
      const citations = collectAssistantCitations(prompt);
      expect(citations).toHaveLength(2);
      expect(prompt.slice(0, draftBeforeSecond.length)).toBe(draftBeforeSecond);
      expect(citations[0]).toEqual(firstCitations[0]);
      expect(
        citations.map(({ citation }) => ({ ...citation, text: citation.text.trim() })),
      ).toEqual([
        expect.objectContaining({
          environmentId: ENVIRONMENT_ID,
          threadId: parent.id,
          text: sourceText,
        }),
        expect.objectContaining({
          environmentId: ENVIRONMENT_ID,
          threadId: parent.id,
          text: sourceText,
        }),
      ]);
    });
    await vi.waitFor(() =>
      expect(sideEditor.element().textContent).toContain("Keep this follow-up draft."),
    );
    expect(useComposerDraftStore.getState().getComposerDraft(parentRef)?.prompt).toBe(
      "Keep the main draft",
    );
    if (!reuse)
      expect(useComposerDraftStore.getState().getComposerDraft(sideRef)?.prompt).toBe(
        sideDraftBefore,
      );
    expect(dispatchedCommands().filter((command) => command.type === "thread.fork")).toHaveLength(
      reuse ? 0 : 1,
    );
    expect(
      dispatchedCommands().filter((command) => command.type === "message.dispatch"),
    ).toHaveLength(0);
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// These fixtures set preferences before mounting; the app's locale bootstrap runs outside AppRoot.
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

it.each(["pane", "tab", "panel"] as const)(
  "hiding a temporary side chat from %s preserves it until confirmed close from details",
  async (closeFrom) => {
    const detailsPreferences = useThreadDetailsPreferences.getState();
    useThreadDetailsPreferences.setState({ pinned: true, open: true, detailsCollapsed: false });
    using _details = {
      [Symbol.dispose]() {
        useThreadDetailsPreferences.setState(detailsPreferences);
      },
    };
    const parent = threadWithHistory("temporary-close-parent", 1);
    const side = {
      ...threadWithHistory("temporary-close-side", 1),
      sideChatOf: parent.id,
      temporary: true,
      olderSettled: true as const,
    };
    let rejectClose = true;
    using _environment = installFakeEnvironment([parent, side], {
      acceptCommands: true,
      holdCommand: (command) => rejectClose && command.type === "thread.delete",
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      confirmThreadDelete: true,
    });
    await page.viewport(1400, 900);
    const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
    const sideRef = scopeThreadRef(ENVIRONMENT_ID, side.id);
    useManualThreadTasks.setState({ tasks: [] });
    using _tasks = {
      [Symbol.dispose]() {
        useManualThreadTasks.setState({ tasks: [] });
      },
    };
    for (const ref of [parentRef, sideRef]) {
      useManualThreadTasks.getState().save({
        threadKey: scopedThreadKey(ref),
        title: "Manual task",
        source: { messageId: MessageId.make("anchor"), runId: null, preview: "Private content" },
        execution: null,
      });
    }
    useComposerDraftStore.getState().setPrompt(parentRef, "Keep working on the main task");
    useComposerDraftStore.getState().setPrompt(sideRef, "A private side question");
    useRightPanelStore.getState().openSideChat(parentRef, side.id, true);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
    );
    await router.load();
    await using screen = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    const mainEditor = screen.getByRole("textbox", {
      name: `Message ${parent.title}`,
      exact: true,
    });
    const sideEditor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
    await expect
      .element(screen.getByRole("button", { name: "Open temporary side chat", exact: true }))
      .toBeVisible();
    await expect.element(sideEditor).toHaveTextContent("A private side question");
    await expect
      .element(screen.getByRole("button", { name: "Bring back", exact: true }))
      .not.toBeInTheDocument();
    const close = screen.getByRole("button", {
      name:
        closeFrom === "pane"
          ? "Hide temporary side chat"
          : closeFrom === "tab"
            ? `Close ${side.title}`
            : "Toggle right panel",
      exact: true,
    });
    await close.click();
    await expect.element(sideEditor).not.toBeInTheDocument();
    expect(dispatchedCommands().filter((command) => command.type === "thread.delete")).toEqual([]);
    expect(useManualThreadTasks.getState().tasks).toHaveLength(2);
    await screen.getByRole("button", { name: new RegExp(`^${side.title}`) }).click();
    await expect.element(sideEditor).toHaveTextContent("A private side question");
    await screen
      .getByRole("button", { name: "Toggle thread details panel", exact: true })
      .first()
      .click();
    const closeFromDetails = page.getByRole("button", {
      name: `Close temporary side chat: ${side.title}`,
      exact: true,
    });
    await closeFromDetails.click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(dispatchedCommands().filter((command) => command.type === "thread.delete")).toEqual([]);
    await closeFromDetails.click();
    await page.getByRole("button", { name: "Confirm close", exact: true }).click();
    await vi.waitFor(() =>
      expect(dispatchedCommands().some((command) => command.type === "thread.delete")).toBe(true),
    );
    await rejectPendingCommand("Could not reach the environment");
    await expect
      .element(page.getByRole("alert").filter({ hasText: "Could not reach the environment" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(sideEditor).toBeVisible();
    await expect.element(sideEditor).toHaveTextContent("A private side question");
    await expect.element(mainEditor).toHaveTextContent("Keep working on the main task");
    expect(useManualThreadTasks.getState().tasks).toHaveLength(2);
    rejectClose = false;
    await closeFromDetails.click();
    await page.getByRole("button", { name: "Confirm close", exact: true }).click();
    await expect.element(sideEditor).not.toBeInTheDocument();
    await expect.element(mainEditor).toHaveTextContent("Keep working on the main task");
    expect(useComposerDraftStore.getState().getComposerDraft(sideRef)).toBeNull();
    expect(useManualThreadTasks.getState().tasks.map((task) => task.threadKey)).toEqual([
      scopedThreadKey(parentRef),
    ]);
    await useManualThreadTasks.persist.rehydrate();
    expect(useManualThreadTasks.getState().tasks.map((task) => task.threadKey)).toEqual([
      scopedThreadKey(parentRef),
    ]);
    expect(
      useClosedViewStore
        .getState()
        .entries.some(
          (entry) => entry.kind === "panel-tab" && entry.surface.id === `side-chat:${side.id}`,
        ),
    ).toBe(false);
    expect(dispatchedCommands().filter((command) => command.type === "thread.delete")).toEqual([
      expect.objectContaining({ threadId: side.id }),
      expect.objectContaining({ threadId: side.id }),
    ]);
    expect(
      dispatchedCommands()
        .filter((command) => command.type === "thread.delete")
        .every(
          (command) =>
            command.type === "thread.delete" &&
            command.threadId === side.id &&
            command.onlyIfUnused === undefined,
        ),
    ).toBe(true);
  },
);

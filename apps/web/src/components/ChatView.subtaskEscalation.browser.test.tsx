import "~/index.css";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { RunId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useThreadDetailsPreferences } from "./chat/threadDetailsPreferences";
import {
  ENVIRONMENT_ID,
  type FakeDriver,
  type FakeThread,
  addEnvironmentThread,
  dispatchedCommands,
  dispatchedEscalations,
  installFakeEnvironment,
  threadWithHistory,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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
  const english = {
    locale: "en",
    formattingLocale: undefined,
    translations: { en: {} },
  };
  const chinese = {
    locale: "zh",
    formattingLocale: undefined,
    translations: { zh },
  } as unknown as typeof english;
  return {
    getI18nSnapshot: () =>
      resolveLanguagePreference(getClientSettings()).startsWith("zh") ? chinese : english,
    subscribeI18n: subscribeClientSettings,
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

it("shows Escalate to L1 on L1 selection toolbar, creates sibling L1 draft without auto-sending, and hides it on L0 and L2", async () => {
  const l0: FakeThread = {
    ...threadWithHistory("esc-l0", 1),
    title: "Root Coordinator",
  };
  const l1: FakeThread = {
    ...threadWithHistory("esc-l1", 1),
    title: "L1 Worker A",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l2: FakeThread = {
    ...threadWithHistory("esc-l2", 1),
    title: "L2 Leaf",
    subtaskOf: l1.id,
    rootThreadId: l0.id,
  };

  using _environment = installFakeEnvironment([l0, l1, l2], {
    acceptCommands: true,
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l0.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  // 1. On L0: Split subtask is visible, Escalate to L1 MUST be hidden.
  const l0Text = `Answer 0 for ${l0.id}.`;
  await expect.element(screen.getByText(l0Text, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(l0Text, { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Split selection into subtask" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Escalate selection to new L1 under root" }))
    .not.toBeInTheDocument();

  // 2. On L1: both Split subtask AND Escalate to L1 are visible; clicking Escalate creates sibling L1 draft under L0 without auto-sending.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${l1.id}` });
  const l1Text = `Answer 0 for ${l1.id}.`;
  await expect.element(screen.getByText(l1Text, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(l1Text, { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Split selection into subtask" }))
    .toBeVisible();
  const escalateToolbarButton = page.getByRole("button", {
    name: "Escalate selection to new L1 under root",
  });
  await expect.element(escalateToolbarButton).toBeVisible();
  await escalateToolbarButton.click();

  await vi.waitFor(() => expect(dispatchedEscalations()).toHaveLength(1));
  const firstEscalation = dispatchedEscalations()[0]!;
  expect(firstEscalation).toMatchObject({
    sourceThreadId: l1.id,
    sourceRunId: RunId.make(`${l1.id}-run-0`),
    sourceMessageId: `${l1.id}-assistant-0`,
  });
  expect(firstEscalation.excerpt).toContain(l1Text);
  expect(
    dispatchedCommands().filter((command) => command.type === "message.dispatch"),
  ).toHaveLength(0);

  const siblingFromToolbar: FakeThread = {
    ...threadWithHistory(firstEscalation.targetThreadId!, 0),
    title: "Sibling L1 from toolbar",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  await addEnvironmentThread(siblingFromToolbar);
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${siblingFromToolbar.id}`);
  });
  const toolbarDraft =
    useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, siblingFromToolbar.id))?.prompt ?? "";
  expect(collectAssistantCitations(toolbarDraft)).toHaveLength(1);
  expect(collectAssistantCitations(toolbarDraft)[0]?.citation.text.trim()).toContain(l1Text);

  // 3. On L2: Escalate MUST be hidden in toolbar.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${l2.id}` });
  const l2Text = `Answer 0 for ${l2.id}.`;
  await expect.element(screen.getByText(l2Text, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(l2Text, { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Cite selection in composer" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Escalate selection to new L1 under root" }))
    .not.toBeInTheDocument();
});

it("offers parent-row horizontal escalation in L1 Lineage panel and hides it on L2 and Side Chat", async () => {
  using _details = pinThreadDetailsOpen();
  const l0: FakeThread = {
    ...threadWithHistory("esc-lin-l0", 1),
    title: "Root Coordinator",
  };
  const l1: FakeThread = {
    ...threadWithHistory("esc-lin-l1", 1),
    title: "L1 Worker A",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  const l2: FakeThread = {
    ...threadWithHistory("esc-lin-l2", 1),
    title: "L2 Leaf",
    subtaskOf: l1.id,
    rootThreadId: l0.id,
  };
  const sideChat: FakeThread = {
    ...threadWithHistory("esc-lin-side", 1),
    title: "Root Side Chat",
    sideChatOf: l0.id,
    rootThreadId: l0.id,
  };

  using _environment = installFakeEnvironment([l0, l1, l2, sideChat], {
    acceptCommands: true,
  });
  enableTestSettings();
  await page.viewport(1400, 900);

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${l1.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, { router: false });

  await expect.element(screen.getByText(`Answer 0 for ${l1.id}.`, { exact: true })).toBeVisible();
  const lineageEscalateButton = page.getByRole("button", {
    name: "Escalate to Root Coordinator as new L1",
  });
  await expect.element(lineageEscalateButton).toBeVisible();
  await lineageEscalateButton.click();

  await vi.waitFor(() => expect(dispatchedEscalations()).toHaveLength(1));
  const escalation = dispatchedEscalations()[0]!;
  expect(escalation.sourceThreadId).toBe(l1.id);
  expect(
    dispatchedCommands().filter((command) => command.type === "message.dispatch"),
  ).toHaveLength(0);

  const siblingFromLineage: FakeThread = {
    ...threadWithHistory(escalation.targetThreadId!, 0),
    title: "Sibling L1 from lineage",
    subtaskOf: l0.id,
    rootThreadId: l0.id,
  };
  await addEnvironmentThread(siblingFromLineage);
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${siblingFromLineage.id}`);
  });

  // On L2: Lineage panel must NOT offer horizontal escalation.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${l2.id}` });
  await expect.element(screen.getByText(`Answer 0 for ${l2.id}.`, { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Escalate to .* as new L1/ }))
    .not.toBeInTheDocument();

  // On Side Chat: Escalate MUST be hidden in both toolbar and Lineage.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${sideChat.id}` });
  const sideText = `Answer 0 for ${sideChat.id}.`;
  await expect.element(screen.getByText(sideText, { exact: true })).toBeVisible();
  await userEvent.tripleClick(screen.getByText(sideText, { exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Escalate selection to new L1 under root" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /Escalate to .* as new L1/ }))
    .not.toBeInTheDocument();
});

import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const SCRATCH_ROOT = "/home/user/.t3/scratch";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  setProjection: (_snapshot: unknown) => {},
}));

vi.mock(import("~/state/entities"), async (importOriginal) => {
  const { create } = await import("zustand");
  const useProjection = create<{ snapshot: unknown }>(() => ({ snapshot: null }));
  state.setProjection = (snapshot) => useProjection.setState({ snapshot });
  return {
    ...(await importOriginal()),
    useProject: ((ref: unknown) =>
      ref === null
        ? null
        : {
            id: "project",
            environmentId: "environment",
            title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
            workspaceRoot: state.workspaceRoot,
            scripts: [],
          }) as never,
    useProjects: (() => []) as never,
    useQuietThreadProjection: ((ref: unknown) => {
      const snapshot = useProjection((value) => value.snapshot);
      return ref === null ? null : snapshot;
    }) as never,
    useQuietThreadShell: ((ref: unknown) =>
      ref === null
        ? null
        : {
            id: "thread",
            environmentId: "environment",
            projectId: "project",
            worktreePath: state.folder,
            branch: null,
            pullRequests: state.pullRequests,
          }) as never,
    useServerConfigs: (() =>
      new Map(
        state.configLoaded
          ? [
              [
                EnvironmentId.make("environment"),
                {
                  scratchWorkspaceRoot: SCRATCH_ROOT,
                  environment: { capabilities: { pullRequests: true } },
                },
              ],
            ]
          : [],
      )) as never,
  };
});
// Neither folder is a repository, which is what the server reports for both.
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => notARepo) as never },
  };
});

import { act, render } from "../../../test/render";
import * as DateTime from "effect/DateTime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useManualThreadTasks } from "./manualThreadTasks";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { useThreadDetailsPreferences } from "./threadDetailsPreferences";
import { GTProvider } from "gt-react";
import type { ComponentProps } from "react";
import { initializeI18n } from "../../i18n/initializeI18n";
import { UiLanguageProvider } from "../../i18n/UiLanguageProvider";
import zh from "../../i18n/translations/zh.json";
import { ThreadDetailsItemsRow } from "../settings/ThreadDetailsItemsRow";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, maxWidth: 640, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
}) {
  useThreadDetailsPreferences.setState({
    pinned: false,
    open: true,
    width: 360,
    detailsCollapsed: false,
    tasksCollapsed: false,
    usageCollapsed: false,
  });
  state.setProjection(null);
  useManualThreadTasks.setState({ tasks: [] });
  state.configLoaded = input.configLoaded ?? true;
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => {
      anchor.remove();
      useManualThreadTasks.setState({ tasks: [] });
    },
  };
}

const machines = (["This Mac", "Server"] as const).map((label, index) => ({
  environmentId: EnvironmentId.make(index === 0 ? "environment" : "other"),
  projectId: ProjectId.make("project"),
  label,
  isPrimary: index === 0,
  machine: "server" as const,
}));

function Panel({
  fixture,
  activeThreadRef = threadRef,
  draftEnvMode,
  onMachines = false,
}: {
  fixture: ReturnType<typeof setup>;
  activeThreadRef?: ScopedThreadRef;
  /** Renders an unsent draft in this mode instead of a started thread. */
  draftEnvMode?: "local" | "worktree";
  onMachines?: boolean;
}) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: noop,
        measureDetailsCard: noop,
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      <ThreadDetailsPanel
        anchor={fixture.anchor}
        handle={fixture.handle}
        environmentId={activeThreadRef.environmentId}
        threadId={activeThreadRef.threadId}
        projectId={ProjectId.make("project")}
        composerDraftTarget={activeThreadRef}
        worktreePath={draftEnvMode === undefined ? state.folder : null}
        isServerThread={draftEnvMode === undefined}
        activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={[]}
        availableEditors={[]}
        showOpenInPicker={false}
        openInShortcutEnabled={false}
        gitCwd={state.folder}
        workspaceMutationId={null}
        isGitRepo={false}
        offersWorkspaceModes={false}
        envLocked={draftEnvMode === undefined}
        availableEnvironments={onMachines ? machines : []}
        {...(onMachines ? { onEnvironmentChange: noop } : {})}
        onEnvModeChange={noop}
        envMode={draftEnvMode ?? "local"}
        startFromOrigin={false}
        onStartFromOriginChange={noop}
        onComposerFocusRequest={noop}
        onRunProjectScript={noop}
        onAddProjectScript={scriptResult}
        onUpdateProjectScript={scriptResult}
        onDeleteProjectScript={scriptResult}
        usage={{ providerInstanceId: null, model: null, providers: [], sources: [] }}
        context={{ usage: null }}
      />
    </ChatCanvasContext>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows Current checkout where no worktree can come from, even when New worktree is the default", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(<Panel fixture={fixture} draftEnvMode="worktree" />);
  await expect.element(page.getByLabelText("Run context: Current checkout")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Run context/ })).not.toBeInTheDocument();
});

it("offers only machines where no worktree can come from and several machines exist", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(
    <Panel fixture={fixture} draftEnvMode="worktree" onMachines />,
  );
  await page.getByRole("button", { name: "Run context: This Mac, Current checkout" }).click();
  await expect.element(page.getByText("Run on")).toBeVisible();
  await expect.element(page.getByText("New worktree")).not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  const snapshot = {
    projection: {
      thread: {
        id: threadRef.threadId,
        createdAt: DateTime.makeUnsafe(0),
        lineage: {
          parentThreadId: null,
          rootThreadId: threadRef.threadId,
          relationshipToParent: null,
        },
      },
      subagents: [],
      contextTransfers: [],
      checkpoints: [],
      providerThreads: [],
      runtimeRequests: [],
      providerSessions: [],
      nodes: [],
      attempts: [],
      checkpointScopes: [],
      contextHandoffs: [],
      visibleTurnItems: [],
      runs: [],
      providerTurns: [],
      plans: [],
      turnItems: [],
      messages: [],
    },
  };
  state.setProjection(snapshot);
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Add task manually" })).toBeVisible();
  await page.getByRole("button", { name: "Add task manually" }).click();
  await expect.element(page.getByRole("textbox", { name: "Task name" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await act(() =>
    useManualThreadTasks.getState().save({
      threadKey: scopedThreadKey(threadRef),
      title: "Manual task",
      source: { messageId: MessageId.make("message"), runId: null, preview: "Source" },
      execution: null,
    }),
  );
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  const usageToggle = page.getByRole("button", { name: "Thread usage", exact: true });
  await expect.element(usageToggle).toHaveAttribute("aria-expanded", "true");
  const usageContent = page.elementLocator(document.querySelector("[data-thread-usage]")!);
  await expect.element(usageContent).toBeVisible();
  await usageToggle.click();
  await expect.element(usageContent).not.toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await usageToggle.click();
  await expect.element(usageContent).toBeVisible();
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add task manually" })).toBeVisible();
  await page.getByRole("button", { name: "Thread details", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Thread details", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(page.getByRole("button", { name: "Initialize Git", includeHidden: true }))
    .not.toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add task manually" })).toBeVisible();
  await expect.element(usageContent).not.toBeVisible();
  await page.getByRole("button", { name: "Task list", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Add task manually", includeHidden: true }))
    .not.toBeVisible();
  await page.getByRole("button", { name: "Thread details", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Task list", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Add task manually" })).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Add task manually" })).toBeVisible();
  await act(() =>
    state.setProjection({
      projection: {
        ...snapshot.projection,
        turnItems: [
          {
            id: "todo",
            runId: null,
            providerThreadId: null,
            type: "todo_list",
            planId: "plan",
            startedAt: DateTime.makeUnsafe(0),
            steps: [{ id: "step", text: "AI task", status: "pending" }],
          },
        ],
      },
    }),
  );
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("AI task", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close details panel" }).click();
  await expect
    .element(page.getByRole("button", { name: "Task list", exact: true }))
    .not.toBeInTheDocument();
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("hides tasks from the Chinese card menu and restores them from appearance settings", async () => {
  using fixture = setup({ workspaceRoot: "/work/plain", folder: "/work/plain" });
  const previousSettings = getClientSettings();
  using _settings = { [Symbol.dispose]: () => __setClientSettingsForTests(previousSettings) };
  __setClientSettingsForTests({ ...previousSettings, threadDetailsItems: {} });
  initializeI18n(() => undefined);
  const translations = { en: {}, zh } as unknown as ComponentProps<
    typeof GTProvider
  >["translations"];
  await using screen = await render(
    <GTProvider locale="zh" translations={translations}>
      <UiLanguageProvider>
        <Panel fixture={fixture} />
        <ThreadDetailsItemsRow />
      </UiLanguageProvider>
    </GTProvider>,
  );
  const addTask = screen.getByRole("button", { name: "手动添加任务" });
  await addTask.click({ button: "right" });
  await expect.element(page.getByRole("menuitemcheckbox", { name: "环境与工作树" })).toBeVisible();
  const tasks = page.getByRole("menuitemcheckbox", { name: "任务列表" });
  await expect.element(tasks).toBeChecked();
  await tasks.click();
  await expect.element(addTask).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: /^会话详情：已启用/ }).click();
  await expect.element(tasks).not.toBeChecked();
  await tasks.click();
  await expect.element(addTask).toBeVisible();
  await screen.rerender(
    <GTProvider locale="en" translations={{ en: {} }}>
      <span />
    </GTProvider>,
  );
});

it("saves each thread's note on leaving it and restores it when the note is shown again", async () => {
  using fixture = setup({ workspaceRoot: "/work/plain", folder: "/work/plain" });
  const first = { ...threadRef, threadId: ThreadId.make("note-first") };
  const second = { ...first, environmentId: EnvironmentId.make("another-environment") };
  const previousSettings = getClientSettings();
  using _cleanup = {
    [Symbol.dispose]() {
      for (const ref of [first, second]) {
        localStorage.removeItem(`t3code:thread-note:v1:${scopedThreadKey(ref)}`);
      }
      __setClientSettingsForTests(previousSettings);
    },
  };
  __setClientSettingsForTests({ ...previousSettings, threadDetailsItems: {} });
  await using screen = await render(<Panel fixture={fixture} activeThreadRef={first} />);
  const note = page.getByRole("button", { name: "Thread note" });
  const editor = page.getByRole("textbox", { name: "Thread note" });
  await note.click();
  await expect.element(editor).toHaveFocus();
  await editor.fill("First environment\nRemember the branch.");

  await screen.rerender(<Panel fixture={fixture} activeThreadRef={second} />);
  await note.click();
  await expect.element(editor).toHaveValue("");
  await editor.fill("Second environment");

  await screen.rerender(<Panel fixture={fixture} activeThreadRef={first} />);
  await note.click();
  await expect.element(editor).toHaveValue("First environment\nRemember the branch.");
  await page.getByRole("button", { name: "Choose what to show" }).click();
  const noteSetting = page.getByRole("menuitemcheckbox", { name: "Thread note" });
  await noteSetting.click();
  await expect.element(note).not.toBeInTheDocument();
  await noteSetting.click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Remember the branch.", { exact: false })).toBeVisible();
  await note.click();
  await expect.element(editor).toHaveValue("First environment\nRemember the branch.");
});

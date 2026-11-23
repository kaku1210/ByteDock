import {
  IsoDateTime,
  RunId,
  SharedWorktreeReservationId,
  ThreadId,
  TurnItemId,
  type SharedWorktreeCoordinationSnapshot,
  type SharedWorktreeSerializationMode,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UiLanguageContext } from "../../i18n/useUiLanguage";
import "../../index.css";

import { SharedWorktreeCoordinationBannerView } from "./SharedWorktreeCoordinationBanner";

function makeSnapshot(
  overrides: Partial<SharedWorktreeCoordinationSnapshot> = {},
): SharedWorktreeCoordinationSnapshot {
  const threadA = ThreadId.make("thread:l1-a");
  const threadB = ThreadId.make("thread:l1-b");
  const threadIdle = ThreadId.make("thread:idle-1");
  const resA = SharedWorktreeReservationId.make("swr:a");
  const resB = SharedWorktreeReservationId.make("swr:b");
  return {
    rootThreadId: ThreadId.make("thread:l0-root"),
    checkoutPath: "/repo/shared-checkout",
    checkoutKey: "/repo/shared-checkout",
    policy: {
      checkoutKey: "/repo/shared-checkout",
      checkoutPath: "/repo/shared-checkout",
      serializationMode: "parallel",
      shellConstraintCoverage: {
        serverEnforcedWorktreeGate: true,
        serverEnforcedWriteReservation: true,
        checkoutWriteSerializationEnabled: false,
        shellGitWorktreeConstraint: "provider_tool_permission",
        summary:
          "Server enforces worktree approval gate and normalized write-path reservations. Direct shell 'git worktree add' relies on provider runtime tool permissions.",
      },
      updatedAt: IsoDateTime.make("2026-06-20T00:00:00.000Z"),
      updatedBy: "system",
    },
    sharedThreadCount: 4,
    threads: [
      {
        threadId: threadA,
        title: "Subtask A",
        depth: 1,
        activeRunId: RunId.make("run:a"),
        status: "running",
        inFamily: true,
        plannedPaths: [
          {
            path: "src/shared.ts",
            normalizedPath: "src/shared.ts",
            runId: RunId.make("run:a"),
            note: "Declared via delegate_task",
            declaredAt: IsoDateTime.make("2026-06-20T00:00:01.000Z"),
          },
        ],
        confirmedWritePaths: [
          {
            path: "src/shared.ts",
            normalizedPath: "src/shared.ts",
            oldPath: null,
            oldNormalizedPath: null,
            operation: "update",
            runId: RunId.make("run:a"),
            turnItemId: TurnItemId.make("item:fc-a-1"),
            source: "turn_item",
            updatedAt: IsoDateTime.make("2026-06-20T00:00:02.000Z"),
          },
          {
            path: "docs/deploy.md",
            normalizedPath: "docs/deploy.md",
            oldPath: null,
            oldNormalizedPath: null,
            operation: "update",
            runId: RunId.make("run:a"),
            turnItemId: TurnItemId.make("item:fc-a-2"),
            source: "turn_item",
            updatedAt: IsoDateTime.make("2026-06-20T00:00:03.000Z"),
          },
          {
            path: "docs/deploy.md",
            normalizedPath: "docs/deploy.md",
            oldPath: null,
            oldNormalizedPath: null,
            operation: "update",
            runId: RunId.make("run:a"),
            turnItemId: TurnItemId.make("item:fc-a-3"),
            source: "turn_item",
            updatedAt: IsoDateTime.make("2026-06-20T00:00:04.000Z"),
          },
          {
            path: "docs/deploy.md",
            normalizedPath: "docs/deploy.md",
            oldPath: null,
            oldNormalizedPath: null,
            operation: "update",
            runId: RunId.make("run:a"),
            turnItemId: TurnItemId.make("item:fc-a-4"),
            source: "turn_item",
            updatedAt: IsoDateTime.make("2026-06-20T00:00:05.000Z"),
          },
        ],
        activeReservations: [
          {
            reservationId: resA,
            checkoutKey: "/repo/shared-checkout",
            threadId: threadA,
            runId: RunId.make("run:a"),
            paths: ["src/shared.ts"],
            canonicalPaths: ["src/shared.ts"],
            status: "active",
            waitingOnReservationIds: [],
            acquiredAt: IsoDateTime.make("2026-06-20T00:00:01.000Z"),
          },
        ],
      },
      {
        threadId: threadB,
        title: "Subtask B",
        depth: 1,
        activeRunId: RunId.make("run:b"),
        status: "running",
        inFamily: true,
        plannedPaths: [
          {
            path: "src/shared.ts",
            normalizedPath: "src/shared.ts",
            runId: RunId.make("run:b"),
            note: null,
            declaredAt: IsoDateTime.make("2026-06-20T00:00:01.000Z"),
          },
        ],
        confirmedWritePaths: [],
        activeReservations: [],
      },
      {
        threadId: threadIdle,
        title: "Idle History Thread",
        depth: 0,
        activeRunId: null,
        status: "idle",
        inFamily: false,
        plannedPaths: [],
        confirmedWritePaths: [],
        activeReservations: [],
      },
    ],
    overlaps: [
      {
        normalizedPath: "src/shared.ts",
        kind: "exact",
        severity: "blocking",
        participants: [
          {
            threadId: threadA,
            threadTitle: "Subtask A",
            runId: RunId.make("run:a"),
            layers: ["planned", "confirmed_write", "reserved"],
            rawPaths: ["src/shared.ts"],
          },
          {
            threadId: threadB,
            threadTitle: "Subtask B",
            runId: RunId.make("run:b"),
            layers: ["planned"],
            rawPaths: ["src/shared.ts"],
          },
        ],
        recommendedAction:
          "Serialize edits through write-path reservation or enable checkout write serialization.",
      },
    ],
    observedUnverifiedPaths: [
      {
        path: "README.local.md",
        normalizedPath: "README.local.md",
        attribution: "observed_unverified",
        reason: "external_or_unattributed",
        insertions: 4,
        deletions: 1,
      },
    ],
    activeReservations: [
      {
        reservationId: resA,
        checkoutKey: "/repo/shared-checkout",
        threadId: threadA,
        runId: RunId.make("run:a"),
        paths: ["src/shared.ts"],
        canonicalPaths: ["src/shared.ts"],
        status: "active",
        waitingOnReservationIds: [],
        acquiredAt: IsoDateTime.make("2026-06-20T00:00:01.000Z"),
      },
    ],
    waitingReservations: [
      {
        reservationId: resB,
        checkoutKey: "/repo/shared-checkout",
        threadId: threadB,
        runId: RunId.make("run:b"),
        paths: ["src/shared.ts"],
        canonicalPaths: ["src/shared.ts"],
        status: "waiting",
        waitingOnReservationIds: [resA],
        acquiredAt: IsoDateTime.make("2026-06-20T00:00:03.000Z"),
      },
    ],
    activeSerializedRun: null,
    waitingSerializedRuns: [],
    restoreSafetyProtected: true,
    generatedAt: IsoDateTime.make("2026-06-20T00:00:05.000Z"),
    ...overrides,
  };
}

describe("SharedWorktreeCoordinationBannerView", () => {
  it("defaults to a compact single-line strip and expands to show deduplicated files, collapsed idle threads, and restore safety", async () => {
    const onSetSerializationMode = vi.fn(async () => null);
    const snapshot = makeSnapshot();

    const view = await render(
      <SharedWorktreeCoordinationBannerView
        snapshot={snapshot}
        onSetSerializationMode={onSetSerializationMode}
      />,
    );
    try {
      const banner = page.getByTestId("shared-worktree-coordination-banner");
      await expect.element(banner).toBeVisible();
      await expect.element(banner).toHaveAttribute("data-expanded", "false");
      const summaryText = page.getByTestId("shared-worktree-summary").element().textContent ?? "";
      expect(summaryText).toContain("2 active threads conflict on");
      expect(summaryText).toContain("src/shared.ts");
      expect(document.querySelector('[data-testid="shared-worktree-scroll-body"]')).toBeNull();

      // Expand details
      await userEvent.click(page.getByTestId("shared-worktree-expand-toggle"));
      await expect.element(banner).toHaveAttribute("data-expanded", "true");

      const overlapText = page.getByTestId("shared-worktree-overlaps").element().textContent ?? "";
      expect(overlapText).toContain("src/shared.ts");
      expect(overlapText).toContain("Subtask A");
      expect(overlapText).toContain("Subtask B");

      // Only the 2 changed threads are rendered; the idle unchanged thread is collapsed into footer count
      const threadRows = Array.from(
        document.querySelectorAll('[data-testid="shared-worktree-thread-row"]'),
      );
      expect(threadRows).toHaveLength(2);
      const threadAText = threadRows[0]?.textContent ?? "";
      expect(threadAText).toContain("Subtask A");
      expect(threadAText).toContain("docs/deploy.md");
      expect(threadAText).toContain("×3");

      await expect
        .element(page.getByTestId("shared-worktree-unchanged-count"))
        .toHaveTextContent("And 2 unchanged threads");

      const observedText =
        page.getByTestId("shared-worktree-observed-unverified").element().textContent ?? "";
      expect(observedText).toContain("README.local.md");

      await page.getByTestId("shared-worktree-shell-coverage").hover();
      const coverageTooltip = page.getByTestId("shared-worktree-shell-coverage-tooltip");
      await expect.element(coverageTooltip).toBeVisible();
      expect(coverageTooltip.element().textContent ?? "").toContain("git worktree add");

      await expect
        .element(page.getByTestId("shared-worktree-restore-safety"))
        .toHaveTextContent("Restore safety active");
    } finally {
      await view.unmount();
    }
  });

  it("toggles checkout write serialization mode and prevents duplicate submissions while in flight", async () => {
    const deferred: { resolve: ((value: string | null) => void) | null } = { resolve: null };
    const onSetSerializationMode = vi.fn(
      (_mode: SharedWorktreeSerializationMode) =>
        new Promise<string | null>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const view = await render(
      <SharedWorktreeCoordinationBannerView
        snapshot={makeSnapshot()}
        onSetSerializationMode={onSetSerializationMode}
      />,
    );
    try {
      const toggle = page.getByTestId("shared-worktree-serialize-toggle");
      await expect.element(toggle).toBeEnabled();
      await userEvent.click(toggle);
      await expect.element(toggle).toBeDisabled();
      expect(onSetSerializationMode).toHaveBeenCalledTimes(1);
      expect(onSetSerializationMode).toHaveBeenCalledWith("serialize_checkout_writes");

      deferred.resolve?.(null);
      await expect.element(toggle).toBeEnabled();
    } finally {
      await view.unmount();
    }
  });

  it("displays an error alert when updating serialization policy fails", async () => {
    const onSetSerializationMode = vi.fn(async () => "Failed to persist checkout policy.");

    const view = await render(
      <SharedWorktreeCoordinationBannerView
        snapshot={makeSnapshot()}
        onSetSerializationMode={onSetSerializationMode}
      />,
    );
    try {
      await userEvent.click(page.getByTestId("shared-worktree-serialize-toggle"));
      const alert = page.getByRole("alert");
      await expect.element(alert).toBeVisible();
      await expect.element(alert).toHaveTextContent("Failed to persist checkout policy.");
    } finally {
      await view.unmount();
    }
  });

  it("stays hidden when no active conflict exists, including historical idle-only overlaps", async () => {
    const idleA = ThreadId.make("thread:hist-a");
    const idleB = ThreadId.make("thread:hist-b");
    const historicalOnly = makeSnapshot({
      sharedThreadCount: 2,
      threads: [
        {
          threadId: idleA,
          title: "Old Thread A",
          depth: 0,
          activeRunId: null,
          status: "idle",
          inFamily: false,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
        {
          threadId: idleB,
          title: "Old Thread B",
          depth: 0,
          activeRunId: null,
          status: "idle",
          inFamily: false,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
      ],
      overlaps: [
        {
          normalizedPath: ".gitignore",
          kind: "exact",
          severity: "warning",
          participants: [
            {
              threadId: idleA,
              threadTitle: "Old Thread A",
              runId: null,
              layers: ["confirmed_write"],
              rawPaths: [".gitignore"],
            },
            {
              threadId: idleB,
              threadTitle: "Old Thread B",
              runId: null,
              layers: ["confirmed_write"],
              rawPaths: [".gitignore"],
            },
          ],
          recommendedAction: "Historical overlap",
        },
      ],
      observedUnverifiedPaths: [
        {
          path: "README.local.md",
          normalizedPath: "README.local.md",
          attribution: "observed_unverified",
          reason: "external_or_unattributed",
          insertions: 1,
          deletions: 0,
        },
      ],
      activeReservations: [],
      waitingReservations: [],
      activeSerializedRun: null,
      waitingSerializedRuns: [],
    });

    const view = await render(
      <SharedWorktreeCoordinationBannerView
        snapshot={historicalOnly}
        onSetSerializationMode={vi.fn(async () => null)}
      />,
    );
    try {
      expect(
        document.querySelector('[data-testid="shared-worktree-coordination-banner"]'),
      ).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("caps expanded body height and enables scrolling when many changed threads are listed", async () => {
    const manyChangedThreads = Array.from({ length: 12 }, (_, index) => ({
      threadId: ThreadId.make(`thread:many-${index}`),
      title: `Shared thread ${index + 1}`,
      depth: index === 0 ? 0 : 1,
      activeRunId: RunId.make(`run:many-${index}`),
      status: "running" as const,
      inFamily: true,
      plannedPaths: [],
      confirmedWritePaths: [
        {
          path: `src/module-${index}.ts`,
          normalizedPath: `src/module-${index}.ts`,
          oldPath: null,
          oldNormalizedPath: null,
          operation: "update" as const,
          runId: RunId.make(`run:many-${index}`),
          turnItemId: TurnItemId.make(`item:many-${index}`),
          source: "turn_item" as const,
          updatedAt: IsoDateTime.make("2026-06-20T00:00:02.000Z"),
        },
      ],
      activeReservations: [],
    }));
    const snapshot = makeSnapshot({
      sharedThreadCount: manyChangedThreads.length,
      threads: manyChangedThreads,
    });

    const view = await render(
      <SharedWorktreeCoordinationBannerView
        snapshot={snapshot}
        onSetSerializationMode={vi.fn(async () => null)}
      />,
    );
    try {
      await userEvent.click(page.getByTestId("shared-worktree-expand-toggle"));
      const scrollBody = page.getByTestId("shared-worktree-scroll-body").element();
      expect(getComputedStyle(scrollBody).overflowY).toBe("auto");
      expect(scrollBody.scrollHeight).toBeGreaterThan(scrollBody.clientHeight);
      expect(scrollBody.getBoundingClientRect().height).toBeLessThanOrEqual(300);
    } finally {
      await view.unmount();
    }
  });

  it("renders concise Chinese copy in zh-CN mode", async () => {
    const view = await render(
      <UiLanguageContext.Provider value="zh-CN">
        <SharedWorktreeCoordinationBannerView
          snapshot={makeSnapshot()}
          onSetSerializationMode={vi.fn(async () => null)}
        />
      </UiLanguageContext.Provider>,
    );
    try {
      const collapsedSummary =
        page.getByTestId("shared-worktree-summary").element().textContent ?? "";
      expect(collapsedSummary).toContain("2 个活跃会话冲突");
      await expect
        .element(page.getByTestId("shared-worktree-serialize-toggle"))
        .toHaveTextContent("排队写入");
      await expect
        .element(page.getByTestId("shared-worktree-expand-toggle"))
        .toHaveTextContent("详情");

      await userEvent.click(page.getByTestId("shared-worktree-expand-toggle"));
      await expect
        .element(page.getByTestId("shared-worktree-unchanged-count"))
        .toHaveTextContent("另有 2 个无改动会话");
      const expandedSummary =
        page.getByTestId("shared-worktree-summary").element().textContent ?? "";
      expect(expandedSummary).toContain("共享目录协作");
      expect(expandedSummary).toContain("1 处文件冲突");
      await expect
        .element(page.getByTestId("shared-worktree-restore-safety"))
        .toHaveTextContent("回滚防误伤已启用");
    } finally {
      await view.unmount();
    }
  });
});

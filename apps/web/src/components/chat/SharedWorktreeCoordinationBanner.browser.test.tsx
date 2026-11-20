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
import "../../index.css";

import { SharedWorktreeCoordinationBannerView } from "./SharedWorktreeCoordinationBanner";

function makeSnapshot(
  overrides: Partial<SharedWorktreeCoordinationSnapshot> = {},
): SharedWorktreeCoordinationSnapshot {
  const threadA = ThreadId.make("thread:l1-a");
  const threadB = ThreadId.make("thread:l1-b");
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
    sharedThreadCount: 3,
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
            turnItemId: TurnItemId.make("item:fc-a"),
            source: "turn_item",
            updatedAt: IsoDateTime.make("2026-06-20T00:00:02.000Z"),
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
  it("renders three-layer attribution, overlap alerts, observed_unverified edits, and shell coverage disclosure", async () => {
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
      await expect
        .element(page.getByTestId("shared-worktree-status-badge"))
        .toHaveTextContent("Blocking overlap");
      await expect
        .element(page.getByTestId("shared-worktree-count-planned"))
        .toHaveTextContent("Planned: 2");
      await expect
        .element(page.getByTestId("shared-worktree-count-confirmed"))
        .toHaveTextContent("Confirmed writes: 1");
      await expect
        .element(page.getByTestId("shared-worktree-count-observed"))
        .toHaveTextContent("Observed (unverified): 1");

      const overlapText = page.getByTestId("shared-worktree-overlaps").element().textContent ?? "";
      expect(overlapText).toContain("src/shared.ts");
      expect(overlapText).toContain("Subtask A");
      expect(overlapText).toContain("Subtask B");

      const observedText =
        page.getByTestId("shared-worktree-observed-unverified").element().textContent ?? "";
      expect(observedText).toContain("README.local.md");
      expect(observedText).toContain("Not attributed to any subtask");

      const coverageText =
        page.getByTestId("shared-worktree-shell-coverage").element().textContent ?? "";
      expect(coverageText).toContain("git worktree add");
      const restoreText =
        page.getByTestId("shared-worktree-restore-safety").element().textContent ?? "";
      expect(restoreText).toContain("Shared checkout restore safety active");
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

  it("stays hidden in default ChatView mode when no coordination activity exists", async () => {
    const quiet = makeSnapshot({
      sharedThreadCount: 1,
      overlaps: [],
      observedUnverifiedPaths: [],
      activeReservations: [],
      waitingReservations: [],
      activeSerializedRun: null,
      waitingSerializedRuns: [],
    });

    const view = await render(
      <SharedWorktreeCoordinationBannerView
        snapshot={quiet}
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
});

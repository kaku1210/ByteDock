import {
  CommandId,
  IsoDateTime,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  WorktreeApprovalRequestId,
  type WorktreeApprovalRequest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { WorktreeApprovalBannerView } from "./WorktreeApprovalBanner";

function makeRequest(overrides: Partial<WorktreeApprovalRequest> = {}): WorktreeApprovalRequest {
  return {
    requestId: WorktreeApprovalRequestId.make("worktree-approval:cmd-browser-1"),
    commandId: CommandId.make("cmd-browser-1"),
    projectId: ProjectId.make("project:browser"),
    parentThreadId: ThreadId.make("thread:parent"),
    parentRunId: RunId.make("run:parent"),
    parentTaskId: NodeId.make("task:browser-1"),
    childThreadId: ThreadId.make("thread:child"),
    childRunId: RunId.make("run:child"),
    baseRef: "main",
    baseCommitSha: "abcdef1234567890abcdef1234567890abcdef12",
    branch: "feature/isolated-task",
    startFromOrigin: false,
    requestedBy: "agent",
    creationSource: "mcp",
    status: "pending",
    approvedWorktreePath: null,
    approvedBranch: null,
    createdAt: IsoDateTime.make("2026-06-20T00:00:00.000Z"),
    expiresAt: IsoDateTime.make("2026-06-20T00:15:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    ...overrides,
  };
}

describe("WorktreeApprovalBannerView", () => {
  it("renders bound metadata, scope disclosure, and prevents duplicate submission on rapid approve clicks", async () => {
    const deferred: { resolve: ((value: string | null) => void) | null } = { resolve: null };
    const onResolve = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    const request = makeRequest();
    const view = await render(
      <WorktreeApprovalBannerView requests={[request]} onResolve={onResolve} />,
    );
    try {
      const banner = page.getByTestId("worktree-approval-banner");
      await expect.element(banner).toBeVisible();
      const text = banner.element().textContent ?? "";
      expect(text).toContain("AI requested an isolated worktree");
      expect(text).toContain("main");
      expect(text).toContain("abcdef123456");
      expect(text).toContain("feature/isolated-task");
      expect(text).toContain(request.requestId);
      expect(text).toContain("git worktree add");

      const approveButton = page.getByTestId("worktree-approval-approve");
      const denyButton = page.getByTestId("worktree-approval-deny");
      await expect.element(approveButton).toBeEnabled();
      await expect.element(denyButton).toBeEnabled();

      await userEvent.click(approveButton);
      await expect.element(approveButton).toBeDisabled();
      await expect.element(denyButton).toBeDisabled();
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(request.requestId, "approve");

      deferred.resolve?.(null);
      await expect.element(approveButton).toBeEnabled();
    } finally {
      await view.unmount();
    }
  });

  it("submits deny and renders server error alerts cleanly", async () => {
    const onResolve = vi.fn(async () => "Worktree approval request has already expired.");
    const request = makeRequest({
      requestId: WorktreeApprovalRequestId.make("worktree-approval:cmd-browser-deny"),
    });

    const view = await render(
      <WorktreeApprovalBannerView requests={[request]} onResolve={onResolve} />,
    );
    try {
      await userEvent.click(page.getByTestId("worktree-approval-deny"));
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(request.requestId, "deny");

      const alert = page.getByRole("alert");
      await expect.element(alert).toBeVisible();
      await expect
        .element(alert)
        .toHaveTextContent("Worktree approval request has already expired.");
    } finally {
      await view.unmount();
    }
  });

  it("renders resolved states without action buttons", async () => {
    const onResolve = vi.fn(async () => null);
    const approved = makeRequest({
      requestId: WorktreeApprovalRequestId.make("worktree-approval:approved"),
      status: "approved",
      approvedWorktreePath: "/repo-worktrees/wt-1",
      approvedBranch: "feature/isolated-task",
      resolvedAt: IsoDateTime.make("2026-06-20T00:01:00.000Z"),
      resolvedBy: "user",
      resolutionReason: "Approved by user.",
    });
    const denied = makeRequest({
      requestId: WorktreeApprovalRequestId.make("worktree-approval:denied"),
      status: "denied",
      resolvedAt: IsoDateTime.make("2026-06-20T00:02:00.000Z"),
      resolvedBy: "user",
      resolutionReason: "Denied by user.",
    });
    const expired = makeRequest({
      requestId: WorktreeApprovalRequestId.make("worktree-approval:expired"),
      status: "expired",
      resolvedAt: IsoDateTime.make("2026-06-20T00:15:00.000Z"),
      resolutionReason: "Worktree approval request expired.",
    });

    const view = await render(
      <WorktreeApprovalBannerView requests={[approved, denied, expired]} onResolve={onResolve} />,
    );
    try {
      const banner = page.getByTestId("worktree-approval-banner");
      await expect.element(banner).toBeVisible();
      const text = banner.element().textContent ?? "";
      expect(text).toContain("Approved");
      expect(text).toContain("/repo-worktrees/wt-1");
      expect(text).toContain("Denied");
      expect(text).toContain("Expired");
      expect(document.querySelector('[data-testid="worktree-approval-approve"]')).toBeNull();
      expect(document.querySelector('[data-testid="worktree-approval-deny"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

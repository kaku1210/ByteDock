import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ScopedThreadRef,
  WorktreeApprovalDecision,
  WorktreeApprovalRequest,
  WorktreeApprovalRequestId,
} from "@t3tools/contracts";
import { CheckIcon, ClockIcon, GitBranchIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";

function shortSha(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 12 ? trimmed.slice(0, 12) : trimmed;
}

function statusBadge(status: WorktreeApprovalRequest["status"]) {
  switch (status) {
    case "pending":
      return {
        label: "Pending approval",
        className: "bg-warning/15 text-warning-foreground border-warning/30",
      };
    case "approved":
      return {
        label: "Approved",
        className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
      };
    case "denied":
      return {
        label: "Denied",
        className: "bg-destructive/15 text-destructive border-destructive/30",
      };
    case "expired":
      return {
        label: "Expired",
        className: "bg-muted text-muted-foreground border-border",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className: "bg-muted text-muted-foreground border-border",
      };
  }
}

function formatFailureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return "Failed to update worktree approval request.";
}

export interface WorktreeApprovalBannerViewProps {
  readonly requests: ReadonlyArray<WorktreeApprovalRequest>;
  readonly onResolve: (
    requestId: WorktreeApprovalRequestId,
    decision: WorktreeApprovalDecision,
  ) => Promise<string | null>;
}

export function WorktreeApprovalBannerView({
  requests,
  onResolve,
}: WorktreeApprovalBannerViewProps) {
  const { text: uiText } = useUiLanguage();
  const [submittingId, setSubmittingId] = useState<WorktreeApprovalRequestId | null>(null);
  const [errorsById, setErrorsById] = useState<Readonly<Record<string, string>>>({});
  const inFlight = useRef(new Set<WorktreeApprovalRequestId>());

  if (requests.length === 0) return null;

  const handleDecision = async (
    requestId: WorktreeApprovalRequestId,
    decision: WorktreeApprovalDecision,
  ) => {
    if (inFlight.current.has(requestId)) return;
    inFlight.current.add(requestId);
    setSubmittingId(requestId);
    setErrorsById((current) => {
      if (!(requestId in current)) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
    try {
      const error = await onResolve(requestId, decision);
      if (error !== null) {
        setErrorsById((current) => ({ ...current, [requestId]: error }));
      }
    } finally {
      inFlight.current.delete(requestId);
      setSubmittingId((current) => (current === requestId ? null : current));
    }
  };

  return (
    <div
      data-testid="worktree-approval-banner"
      className="mb-2 flex flex-col gap-2"
      aria-live="polite"
    >
      {requests.map((request) => {
        const badge = statusBadge(request.status);
        const isPending = request.status === "pending";
        const isBusy = submittingId === request.requestId;
        const sha = shortSha(request.baseCommitSha);
        const error = errorsById[request.requestId] ?? null;
        return (
          <div
            key={request.requestId}
            data-testid="worktree-approval-card"
            data-worktree-approval-id={request.requestId}
            data-worktree-approval-status={request.status}
            className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/95 p-3 shadow-xs backdrop-blur-xs"
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm font-medium text-foreground">
                  {uiText("AI requested an isolated worktree")}
                </span>
              </div>
              <span
                data-testid="worktree-approval-status-badge"
                className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}
              >
                {uiText(badge.label)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                {uiText("Base:")}{" "}
                <code className="font-mono text-foreground">{request.baseRef}</code>
                {sha !== null && sha !== request.baseRef ? (
                  <>
                    {" "}
                    (<code className="font-mono text-foreground">{sha}</code>)
                  </>
                ) : null}
              </span>
              {request.branch !== null ? (
                <span>
                  {uiText("Branch:")}{" "}
                  <code className="font-mono text-foreground">{request.branch}</code>
                </span>
              ) : null}
              <span>
                {uiText("Request:")}{" "}
                <code className="font-mono text-foreground">{request.requestId}</code>
              </span>
              {isPending ? (
                <span className="inline-flex items-center gap-1">
                  <ClockIcon className="size-3" aria-hidden />
                  {uiText("Expires")} {new Date(request.expiresAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            {request.approvedWorktreePath !== null ? (
              <p className="truncate text-xs text-muted-foreground">
                {uiText("Worktree path:")}{" "}
                <code className="font-mono text-foreground">{request.approvedWorktreePath}</code>
              </p>
            ) : null}

            {request.resolutionReason !== null && !isPending ? (
              <p className="text-xs text-muted-foreground">{request.resolutionReason}</p>
            ) : null}

            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                <ShieldAlertIcon className="size-3.5 shrink-0" aria-hidden />
                <span>
                  {uiText(
                    "Covers T3-managed worktree creation (delegate_task, thread launch, retries). Direct shell git worktree add relies on provider runtime tool approval.",
                  )}
                </span>
              </p>
              {isPending ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    data-testid="worktree-approval-deny"
                    disabled={isBusy}
                    onClick={() => void handleDecision(request.requestId, "deny")}
                  >
                    <XIcon className="size-3.5" aria-hidden />
                    {uiText("Deny")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    data-testid="worktree-approval-approve"
                    disabled={isBusy}
                    onClick={() => void handleDecision(request.requestId, "approve")}
                  >
                    <CheckIcon className="size-3.5" aria-hidden />
                    {uiText("Approve worktree")}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WorktreeApprovalBanner({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const [interactedIds, setInteractedIds] = useState<ReadonlySet<WorktreeApprovalRequestId>>(
    () => new Set(),
  );
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : vcsEnvironment.worktreeApprovals({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const resolveApproval = useAtomCommand(vcsEnvironment.resolveWorktreeApproval, {
    label: "resolve worktree approval",
    reportFailure: false,
    reportDefect: false,
  });

  const allRequests = query.data?.requests ?? [];
  const visibleRequests = allRequests.filter(
    (request) => request.status === "pending" || interactedIds.has(request.requestId),
  );
  if (threadRef === null || visibleRequests.length === 0) return null;

  return (
    <WorktreeApprovalBannerView
      requests={visibleRequests}
      onResolve={async (requestId, decision) => {
        setInteractedIds((current) => {
          if (current.has(requestId)) return current;
          const next = new Set(current);
          next.add(requestId);
          return next;
        });
        const result = await resolveApproval({
          environmentId: threadRef.environmentId,
          input: { requestId, decision },
        });
        if (result._tag === "Success") return null;
        if (isAtomCommandInterrupted(result)) return null;
        return formatFailureMessage(squashAtomCommandFailure(result));
      }}
    />
  );
}

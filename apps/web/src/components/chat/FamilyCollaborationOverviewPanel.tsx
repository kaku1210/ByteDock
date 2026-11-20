import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FamilyCollaborationDeliveryStatus,
  FamilyCollaborationNode,
  FamilyCollaborationOverview,
  FamilyCollaborationSessionStatus,
  FamilyCollaborationSideChatSummary,
  FamilyCollaborationTaskStatus,
  ScopedThreadRef,
  SharedWorktreeSerializationMode,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeIcon,
  FileCode2Icon,
  FileTextIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  LockIcon,
  MessagesSquareIcon,
  NetworkIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SquareIcon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useRightPanelStore } from "../../rightPanelStore";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SharedWorktreeCoordinationBannerView } from "./SharedWorktreeCoordinationBanner";

type ToneClass = {
  readonly label: string;
  readonly className: string;
};

function sessionStatusBadge(status: FamilyCollaborationSessionStatus): ToneClass {
  switch (status) {
    case "running":
      return {
        label: "Running",
        className: "bg-info/15 text-info border-info/30",
      };
    case "waiting_approval":
      return {
        label: "Waiting approval",
        className: "bg-warning/15 text-warning-foreground border-warning/30",
      };
    case "waiting_input":
      return {
        label: "Waiting input",
        className: "bg-warning/15 text-warning-foreground border-warning/30",
      };
    case "queue_paused":
      return {
        label: "Queue paused",
        className: "bg-warning/15 text-warning-foreground border-warning/30",
      };
    case "awaiting_initial_send":
      return {
        label: "Awaiting first send",
        className: "bg-primary/10 text-primary border-primary/25",
      };
    case "error":
      return {
        label: "Error",
        className: "bg-destructive/15 text-destructive border-destructive/30",
      };
    case "archived":
      return {
        label: "Archived",
        className: "bg-muted text-muted-foreground border-border",
      };
    case "idle":
      return {
        label: "Idle",
        className: "bg-muted/70 text-muted-foreground border-border",
      };
  }
}

function taskStatusBadge(status: FamilyCollaborationTaskStatus): ToneClass {
  switch (status) {
    case "running":
      return {
        label: "Running",
        className: "bg-info/15 text-info border-info/30",
      };
    case "queued":
      return {
        label: "Queued",
        className: "bg-info/10 text-info border-info/25",
      };
    case "blocked":
      return {
        label: "Blocked",
        className: "bg-destructive/15 text-destructive border-destructive/30",
      };
    case "completed":
      return {
        label: "Completed",
        className: "bg-success/15 text-success border-success/30",
      };
    case "failed":
      return {
        label: "Failed",
        className: "bg-destructive/15 text-destructive border-destructive/30",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        className: "bg-muted text-muted-foreground border-border",
      };
    case "interrupted":
      return {
        label: "Interrupted",
        className: "bg-warning/15 text-warning-foreground border-warning/30",
      };
    case "draft":
      return {
        label: "Draft",
        className: "bg-primary/10 text-primary border-primary/25",
      };
    case "none":
      return {
        label: "None",
        className: "bg-muted/60 text-muted-foreground border-border",
      };
  }
}

function deliveryStatusBadge(status: FamilyCollaborationDeliveryStatus): ToneClass {
  switch (status) {
    case "awaiting_delivery":
      return {
        label: "Awaiting delivery",
        className: "bg-warning/15 text-warning-foreground border-warning/30",
      };
    case "pending_merge_back":
      return {
        label: "Pending Bring back",
        className: "bg-primary/10 text-primary border-primary/25",
      };
    case "bound_merge_back":
      return {
        label: "Bound to next parent turn",
        className: "bg-info/15 text-info border-info/30",
      };
    case "interim_reported":
      return {
        label: "Interim reported",
        className: "bg-info/15 text-info border-info/30",
      };
    case "delivered":
      return {
        label: "Delivered",
        className: "bg-success/15 text-success border-success/30",
      };
    case "acknowledged":
      return {
        label: "Acknowledged",
        className: "bg-success/15 text-success border-success/30",
      };
    case "superseded":
      return {
        label: "Superseded",
        className: "bg-muted text-muted-foreground border-border",
      };
    case "none":
      return {
        label: "None",
        className: "bg-muted/60 text-muted-foreground border-border",
      };
  }
}

function formatFailureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

interface FamilyCollaborationOverviewViewProps {
  readonly overview: FamilyCollaborationOverview;
  readonly isRefreshing?: boolean;
  readonly summaryRequested?: boolean;
  readonly stoppingThreadId?: ThreadId | null;
  readonly onRefresh: () => void;
  readonly onRequestSummary: () => void;
  readonly onHideSummary?: () => void;
  readonly onSelectThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onSelectSideChat: (sideChat: FamilyCollaborationSideChatSummary) => void;
  readonly onStopNode: (node: FamilyCollaborationNode) => Promise<void> | void;
  readonly onSetSerializationMode: (
    mode: SharedWorktreeSerializationMode,
  ) => Promise<string | null>;
}

function FamilyCollaborationOverviewView({
  overview,
  isRefreshing = false,
  summaryRequested = false,
  stoppingThreadId = null,
  onRefresh,
  onRequestSummary,
  onHideSummary,
  onSelectThread,
  onSelectSideChat,
  onStopNode,
  onSetSerializationMode,
}: FamilyCollaborationOverviewViewProps) {
  const { text: uiText } = useUiLanguage();
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<ThreadId>>(() => new Set());
  const [showMarkdownDigest, setShowMarkdownDigest] = useState(false);
  const [copiedDigest, setCopiedDigest] = useState(false);

  const toggleNodeExpanded = (threadId: ThreadId) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const handleCopyMarkdown = async () => {
    if (overview.summary === null) return;
    try {
      await navigator.clipboard.writeText(overview.summary.markdownDigest);
      setCopiedDigest(true);
      window.setTimeout(() => setCopiedDigest(false), 1800);
    } catch {
      toastManager.add({ type: "error", title: uiText("Could not copy markdown summary") });
    }
  };

  const l0Count = overview.nodes.filter((n) => n.depth === 0).length;
  const l1Count = overview.nodes.filter((n) => n.depth === 1).length;
  const l2Count = overview.nodes.filter((n) => n.depth >= 2).length;
  const remoteCount = overview.nodes.reduce((sum, n) => sum + n.remoteChildren.length, 0);

  return (
    <div
      data-testid="family-collaboration-overview"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      {/* Header */}
      <div className="shrink-0 border-b border-border/70 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <NetworkIcon className="size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">
                {uiText("Multi-Agent Collaboration Tree")}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span data-testid="collaboration-topology-counts">
                  L0: {l0Count} · L1: {l1Count} · L2: {l2Count}
                  {overview.sideChats.length > 0
                    ? ` · ${uiText("Side chats")}: ${overview.sideChats.length}`
                    : ""}
                  {remoteCount > 0 ? ` · ${uiText("Remote")}: ${remoteCount}` : ""}
                </span>
                <span
                  data-testid="collaboration-readonly-badge"
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-2xs font-medium text-muted-foreground"
                >
                  <EyeIcon className="size-3" aria-hidden />
                  {uiText("Read-only · does not acknowledge deliveries")}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant={overview.summary !== null ? "secondary" : "outline"}
              data-testid="collaboration-summary-trigger"
              onClick={onRequestSummary}
              disabled={isRefreshing && summaryRequested}
            >
              {isRefreshing && summaryRequested ? (
                <Spinner aria-hidden size="xs" />
              ) : (
                <FileTextIcon className="size-3" aria-hidden />
              )}
              {overview.summary !== null ? uiText("Refresh summary") : uiText("Generate summary")}
            </Button>
            {overview.summary !== null && onHideSummary !== undefined ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                data-testid="collaboration-summary-hide"
                onClick={onHideSummary}
              >
                {uiText("Hide")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={uiText("Refresh collaboration tree")}
              data-testid="collaboration-refresh"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCwIcon
                className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                aria-hidden
              />
            </Button>
          </div>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {/* On-Demand Dynamic Summary */}
        {overview.summary !== null ? (
          <section
            data-testid="collaboration-summary-card"
            className="rounded-lg border border-primary/25 bg-card p-3 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <FileTextIcon className="size-3.5 text-primary" aria-hidden />
                <span>{uiText("Dynamic Family Summary")}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="collaboration-summary-toggle-md"
                  onClick={() => setShowMarkdownDigest((prev) => !prev)}
                >
                  {showMarkdownDigest ? uiText("Hide Markdown") : uiText("View Markdown")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  data-testid="collaboration-summary-copy-md"
                  onClick={() => void handleCopyMarkdown()}
                >
                  {copiedDigest ? (
                    <CheckIcon className="size-3 text-success" aria-hidden />
                  ) : (
                    <CopyIcon className="size-3" aria-hidden />
                  )}
                  {copiedDigest ? uiText("Copied") : uiText("Copy Markdown")}
                </Button>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1.5 text-2xs">
              <span className="rounded-md border border-info/30 bg-info/10 px-2 py-0.5 text-info">
                {uiText("Running")}: {overview.summary.runningCount}
              </span>
              <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-destructive">
                {uiText("Blocked")}: {overview.summary.blockedCount}
              </span>
              <span className="rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-primary">
                {uiText("Draft")}: {overview.summary.awaitingInitialSendCount}
              </span>
              <span className="rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-success">
                {uiText("Completed")}: {overview.summary.completedCount}
              </span>
              {overview.summary.failedCount > 0 ? (
                <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-destructive">
                  {uiText("Failed")}: {overview.summary.failedCount}
                </span>
              ) : null}
              <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-warning-foreground">
                {uiText("Pending delivery")}: {overview.summary.pendingDeliveryCount}
              </span>
              <span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-muted-foreground">
                {uiText("Merge-back pool")}: {overview.summary.pendingMergeBackCount}
              </span>
              {overview.summary.overlapCount > 0 ? (
                <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-destructive">
                  {uiText("Path overlaps")}: {overview.summary.overlapCount}
                </span>
              ) : null}
              {overview.summary.observedUnverifiedCount > 0 ? (
                <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-warning-foreground">
                  {uiText("Unverified edits")}: {overview.summary.observedUnverifiedCount}
                </span>
              ) : null}
            </div>

            {overview.summary.highlights.length > 0 ? (
              <ul
                data-testid="collaboration-summary-highlights"
                className="mt-2.5 space-y-1 text-xs text-muted-foreground"
              >
                {overview.summary.highlights.map((highlight) => (
                  <li key={highlight} className="flex items-start gap-1.5">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {uiText("No active blockers, overlaps, or pending governance requests.")}
              </p>
            )}

            {showMarkdownDigest ? (
              <pre
                data-testid="collaboration-summary-markdown"
                className="mt-2.5 max-h-64 overflow-auto rounded-md border border-border bg-muted/50 p-2.5 font-mono text-2xs whitespace-pre-wrap text-foreground"
              >
                {overview.summary.markdownDigest}
              </pre>
            ) : null}
          </section>
        ) : null}

        {/* Shared Worktree Coordination (Three-layer attribution + overlaps + unverified + policy toggle) */}
        {overview.sharedWorktree !== null ? (
          <section data-testid="collaboration-shared-worktree-section">
            <SharedWorktreeCoordinationBannerView
              snapshot={overview.sharedWorktree}
              alwaysShow={true}
              onRefresh={onRefresh}
              onSetSerializationMode={onSetSerializationMode}
            />
          </section>
        ) : null}

        {/* Pending Escalations & Worktree Approvals */}
        {overview.pendingEscalations.length > 0 || overview.pendingWorktreeApprovals.length > 0 ? (
          <section
            data-testid="collaboration-governance-section"
            className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3"
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold text-warning-foreground">
              <ShieldAlertIcon className="size-3.5 shrink-0" aria-hidden />
              <span>{uiText("Pending Coordination Approvals & Escalations")}</span>
            </div>

            {overview.pendingEscalations.length > 0 ? (
              <div data-testid="collaboration-pending-escalations" className="space-y-1.5">
                <div className="text-2xs font-medium text-muted-foreground">
                  {uiText("L1 Horizontal Escalations")} ({overview.pendingEscalations.length})
                </div>
                {overview.pendingEscalations.map((esc) => (
                  <div
                    key={esc.requestId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        {esc.title ?? uiText("Sibling L1 escalation request")}
                      </div>
                      <div className="truncate text-2xs text-muted-foreground">
                        {uiText("From")}: {esc.sourceTitle}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onSelectThread(overview.rootThreadId)}
                    >
                      {uiText("Review in L0")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            {overview.pendingWorktreeApprovals.length > 0 ? (
              <div data-testid="collaboration-pending-worktree-approvals" className="space-y-1.5">
                <div className="text-2xs font-medium text-muted-foreground">
                  {uiText("AI Isolated Worktree Approvals")} (
                  {overview.pendingWorktreeApprovals.length})
                </div>
                {overview.pendingWorktreeApprovals.map((req) => (
                  <div
                    key={req.requestId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/80 bg-card px-2.5 py-1.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 truncate font-medium text-foreground">
                        <FolderGit2Icon className="size-3.5 shrink-0 text-warning-foreground" />
                        <span className="truncate">
                          {req.branch ?? uiText("Isolated worktree request")}
                        </span>
                      </div>
                      <div className="truncate text-2xs text-muted-foreground">
                        {uiText("Child thread")}: {req.childThreadId}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onSelectThread(req.parentThreadId ?? req.childThreadId)}
                    >
                      {uiText("Inspect")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Hierarchical Task Tree (L0 -> L1 -> L2) */}
        <section data-testid="collaboration-tree-section" className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {uiText("Task Tree")} ({overview.nodes.length})
            </h3>
            <div className="text-2xs text-muted-foreground">
              {uiText("Session · Task · Delivery")}
            </div>
          </div>

          <div className="space-y-2">
            {overview.nodes.map((node) => {
              const sessionTone = sessionStatusBadge(node.sessionStatus);
              const taskTone = taskStatusBadge(node.taskStatus);
              const deliveryTone = deliveryStatusBadge(node.deliveryStatus);
              const isExpanded = expandedNodeIds.has(node.threadId);
              const isStopping = stoppingThreadId === node.threadId;
              const indentRem = Math.min(node.depth, 3) * 1.25;
              const modelLabel = `${node.modelSelection.provider}/${node.modelSelection.model}`;

              return (
                <div
                  key={node.threadId}
                  data-testid={`collaboration-node-${node.threadId}`}
                  data-depth={node.depth}
                  style={{ marginLeft: `${indentRem}rem` }}
                  className={`rounded-lg border transition-colors ${
                    node.isCurrentThread
                      ? "border-primary/50 bg-primary/5"
                      : "border-border/80 bg-card"
                  }`}
                >
                  <div className="p-2.5">
                    {/* Top row: Level + Title + Actions */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-1.5">
                        <button
                          type="button"
                          data-testid={`collaboration-node-expand-${node.threadId}`}
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? uiText("Collapse node details")
                              : uiText("Expand node details")
                          }
                          onClick={() => toggleNodeExpanded(node.threadId)}
                          className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {isExpanded ? (
                            <ChevronDownIcon className="size-3.5" />
                          ) : (
                            <ChevronRightIcon className="size-3.5" />
                          )}
                        </button>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-3xs font-semibold text-foreground">
                              L{node.depth}
                            </span>
                            {node.createdBy === "agent" ? (
                              <BotIcon
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-label={uiText("AI created")}
                              />
                            ) : (
                              <UserIcon
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-label={uiText("Human created")}
                              />
                            )}
                            <button
                              type="button"
                              data-testid={`collaboration-node-open-${node.threadId}`}
                              onClick={() => onSelectThread(node.threadId)}
                              className="truncate text-left text-xs font-semibold text-foreground hover:text-primary hover:underline"
                            >
                              {node.title}
                            </button>
                            {node.isCurrentThread ? (
                              <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-3xs font-medium text-primary">
                                {uiText("Current")}
                              </span>
                            ) : null}
                            {node.nodeKind === "fork" ? (
                              <span className="inline-flex items-center gap-0.5 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-3xs text-muted-foreground">
                                <GitForkIcon className="size-2.5" aria-hidden />
                                {uiText("Fork")}
                              </span>
                            ) : null}
                          </div>

                          {/* Metadata row: model + worktree mode */}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                            <span
                              data-testid={`collaboration-node-model-${node.threadId}`}
                              className="font-mono"
                            >
                              {modelLabel}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <GitBranchIcon className="size-3" aria-hidden />
                              {node.usesSharedWorktree
                                ? uiText("Shared worktree")
                                : (node.branch ?? uiText("Isolated checkout"))}
                            </span>
                            {node.queuedMessageCount > 0 ? (
                              <span>
                                {uiText("Queued")}: {node.queuedMessageCount}
                              </span>
                            ) : null}
                            {node.hasPathOverlap ? (
                              <span
                                data-testid={`collaboration-node-overlap-${node.threadId}`}
                                className="inline-flex items-center gap-1 font-medium text-destructive"
                              >
                                <AlertTriangleIcon className="size-3" aria-hidden />
                                {uiText("Path overlap")}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      {/* Node Actions */}
                      <div className="flex shrink-0 items-center gap-1">
                        {node.canStop ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="destructive-outline"
                            data-testid={`collaboration-node-stop-${node.threadId}`}
                            disabled={isStopping}
                            onClick={() => void onStopNode(node)}
                          >
                            {isStopping ? (
                              <Spinner aria-hidden size="xs" />
                            ) : (
                              <SquareIcon className="size-2.5 fill-current" aria-hidden />
                            )}
                            {uiText("Stop")}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={uiText("Open thread")}
                          onClick={() => onSelectThread(node.threadId)}
                        >
                          <ArrowUpRightIcon className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>

                    {/* Three Distinct Status Badges: Session / Task / Delivery */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
                      <span
                        data-testid={`collaboration-node-session-${node.threadId}`}
                        className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium ${sessionTone.className}`}
                      >
                        <span className="opacity-75">{uiText("Session")}:</span>
                        <span>{uiText(sessionTone.label)}</span>
                      </span>
                      <span
                        data-testid={`collaboration-node-task-${node.threadId}`}
                        className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium ${taskTone.className}`}
                      >
                        <span className="opacity-75">{uiText("Task")}:</span>
                        <span>{uiText(taskTone.label)}</span>
                      </span>
                      <span
                        data-testid={`collaboration-node-delivery-${node.threadId}`}
                        className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium ${deliveryTone.className}`}
                      >
                        <span className="opacity-75">{uiText("Delivery")}:</span>
                        <span>{uiText(deliveryTone.label)}</span>
                      </span>
                    </div>

                    {/* Blocking reason callout */}
                    {node.blockingReason !== null ? (
                      <div
                        data-testid={`collaboration-node-blocker-${node.threadId}`}
                        className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                      >
                        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>{node.blockingReason}</span>
                      </div>
                    ) : null}
                  </div>

                  {/* On-Demand Expanded Node Details */}
                  {isExpanded ? (
                    <div
                      data-testid={`collaboration-node-details-${node.threadId}`}
                      className="space-y-2.5 border-t border-border/70 bg-muted/25 px-3 py-2.5 text-xs"
                    >
                      {/* Latest artifact summary */}
                      <div>
                        <div className="font-medium text-muted-foreground">
                          {uiText("Latest artifact / output")}
                        </div>
                        <p
                          data-testid={`collaboration-node-artifact-${node.threadId}`}
                          className="mt-0.5 text-foreground"
                        >
                          {node.latestArtifactSummary ?? uiText("No assistant output yet.")}
                        </p>
                      </div>

                      {/* Delivery breakdown */}
                      <div className="flex flex-wrap gap-3 text-2xs text-muted-foreground">
                        <span>
                          {uiText("Delegated delivery")}:{" "}
                          <strong className="font-medium text-foreground">
                            {node.delegatedDeliveryState ?? "-"}
                          </strong>
                        </span>
                        <span>
                          {uiText("Merge-back pending/bound/delivered")}:{" "}
                          <strong className="font-medium text-foreground">
                            {node.pendingMergeBackCount}/{node.boundMergeBackCount}/
                            {node.deliveredMergeBackCount}
                          </strong>
                        </span>
                        <span>
                          {uiText("Reports interim/final")}:{" "}
                          <strong className="font-medium text-foreground">
                            {node.interimReportCount}/{node.finalReportCount}
                          </strong>
                        </span>
                      </div>

                      {/* Three-layer path attribution for this node */}
                      {node.plannedPaths.length > 0 ||
                      node.confirmedWritePaths.length > 0 ||
                      node.activeReservationPaths.length > 0 ? (
                        <div className="space-y-1.5">
                          <div className="font-medium text-muted-foreground">
                            {uiText("Shared worktree path attribution")}
                          </div>
                          {node.plannedPaths.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="text-2xs text-muted-foreground">
                                {uiText("Planned")}:
                              </span>
                              {node.plannedPaths.map((p) => (
                                <span
                                  key={`planned:${p}`}
                                  className="inline-flex items-center gap-1 rounded border border-info/30 bg-info/10 px-1.5 py-0.5 font-mono text-2xs text-info"
                                >
                                  <FileCode2Icon className="size-3" aria-hidden />
                                  {p}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {node.confirmedWritePaths.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="text-2xs text-muted-foreground">
                                {uiText("Confirmed writes")}:
                              </span>
                              {node.confirmedWritePaths.map((p) => (
                                <span
                                  key={`write:${p}`}
                                  className="inline-flex items-center gap-1 rounded border border-success/30 bg-success/10 px-1.5 py-0.5 font-mono text-2xs text-success"
                                >
                                  <FileCode2Icon className="size-3" aria-hidden />
                                  {p}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {node.activeReservationPaths.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="text-2xs text-muted-foreground">
                                {uiText("Active write locks")}:
                              </span>
                              {node.activeReservationPaths.map((p) => (
                                <span
                                  key={`lock:${p}`}
                                  className="inline-flex items-center gap-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-2xs text-warning-foreground"
                                >
                                  <LockIcon className="size-3" aria-hidden />
                                  {p}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Remote subagents */}
                      {node.remoteChildren.length > 0 ? (
                        <div className="space-y-1">
                          <div className="font-medium text-muted-foreground">
                            {uiText("Remote subagents")} ({node.remoteChildren.length})
                          </div>
                          {node.remoteChildren.map((remote) => (
                            <div
                              key={remote.subagentId}
                              className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1 text-2xs"
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
                                <span className="truncate font-medium text-foreground">
                                  {remote.title}
                                </span>
                                <span className="text-muted-foreground">({remote.status})</span>
                              </div>
                              {remote.remoteThreadId !== null ? (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  onClick={() =>
                                    onSelectThread(
                                      remote.remoteThreadId!,
                                      remote.targetEnvironmentId,
                                    )
                                  }
                                >
                                  {uiText("Open remote")}
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* Root-Level Side Chats */}
        {overview.sideChats.length > 0 ? (
          <section data-testid="collaboration-side-chats-section" className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {uiText("Root-Level Side Chats")} ({overview.sideChats.length})
              </h3>
              <span className="text-2xs text-muted-foreground">
                {uiText("Owned by L0 · shared across L0/L1/L2")}
              </span>
            </div>
            <div className="space-y-1.5">
              {overview.sideChats.map((sideChat) => {
                const tone = sessionStatusBadge(sideChat.sessionStatus);
                return (
                  <button
                    key={sideChat.threadId}
                    type="button"
                    data-testid={`collaboration-side-chat-${sideChat.threadId}`}
                    onClick={() => onSelectSideChat(sideChat)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/80 bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <MessagesSquareIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="truncate text-xs font-medium text-foreground">
                        {sideChat.title}
                      </span>
                      {sideChat.temporary ? (
                        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                          {uiText("Temporary")}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 text-2xs">
                      {sideChat.pendingMergeBackCount + sideChat.boundMergeBackCount > 0 ? (
                        <span className="rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-primary">
                          {uiText("Bring back")}:{" "}
                          {sideChat.pendingMergeBackCount + sideChat.boundMergeBackCount}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-md border px-1.5 py-0.5 font-medium ${tone.className}`}
                      >
                        {uiText(tone.label)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function FamilyCollaborationOverviewPanel({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef;
}) {
  const { text: uiText } = useUiLanguage();
  const navigate = useNavigate();
  const [includeSummary, setIncludeSummary] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);

  const query = useEnvironmentQuery(
    orchestrationEnvironment.familyCollaborationOverview({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        ...(includeSummary ? { includeSummary: true } : {}),
      },
    }),
  );

  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    label: "stop thread in collaboration overview",
    reportFailure: false,
    reportDefect: false,
  });

  const setPolicy = useAtomCommand(vcsEnvironment.setSharedWorktreePolicy, {
    label: "set shared worktree serialization policy",
    reportFailure: false,
    reportDefect: false,
  });

  const handleSelectThread = (targetThreadId: ThreadId, targetEnvId?: EnvironmentId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(targetEnvId ?? threadRef.environmentId, targetThreadId),
      ),
    });
  };

  const handleSelectSideChat = (sideChat: FamilyCollaborationSideChatSummary) => {
    useRightPanelStore
      .getState()
      .openSideChat(threadRef, sideChat.threadId, sideChat.temporary || undefined);
  };

  const handleStopNode = async (node: FamilyCollaborationNode) => {
    if (stoppingThreadId !== null) return;
    setStoppingThreadId(node.threadId);
    const input =
      node.activeRunId !== null
        ? { threadId: node.threadId, runId: node.activeRunId }
        : node.delegatedTaskId !== null && node.parentThreadId !== null
          ? { threadId: node.parentThreadId, subagentId: node.delegatedTaskId }
          : { threadId: node.threadId };
    const result = await interruptTurn({
      environmentId: threadRef.environmentId,
      input,
    });
    setStoppingThreadId(null);
    if (result._tag === "Success") {
      query.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: formatFailureMessage(
          squashAtomCommandFailure(result),
          uiText("Could not stop thread"),
        ),
      });
    }
  };

  const handleSetSerializationMode = async (
    serializationMode: SharedWorktreeSerializationMode,
  ): Promise<string | null> => {
    const result = await setPolicy({
      environmentId: threadRef.environmentId,
      input: {
        threadId: query.data?.rootThreadId ?? threadRef.threadId,
        serializationMode,
      },
    });
    if (result._tag === "Success") {
      query.refresh();
      return null;
    }
    if (isAtomCommandInterrupted(result)) {
      return null;
    }
    return formatFailureMessage(
      squashAtomCommandFailure(result),
      uiText("Failed to update shared worktree serialization policy."),
    );
  };

  if (query.data === null && query.isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Spinner size="sm" />
        <span>{uiText("Loading collaboration tree...")}</span>
      </div>
    );
  }

  if (query.data === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangleIcon className="size-5 text-destructive" aria-hidden />
        <p className="text-xs text-muted-foreground">
          {query.error ?? uiText("Could not load multi-agent collaboration overview.")}
        </p>
        <Button type="button" size="xs" variant="outline" onClick={query.refresh}>
          <RefreshCwIcon className="size-3" aria-hidden />
          {uiText("Retry")}
        </Button>
      </div>
    );
  }

  return (
    <FamilyCollaborationOverviewView
      overview={query.data}
      isRefreshing={query.isPending}
      summaryRequested={includeSummary}
      stoppingThreadId={stoppingThreadId}
      onRefresh={query.refresh}
      onRequestSummary={() => {
        if (includeSummary) {
          query.refresh();
        } else {
          setIncludeSummary(true);
        }
      }}
      onHideSummary={() => setIncludeSummary(false)}
      onSelectThread={handleSelectThread}
      onSelectSideChat={handleSelectSideChat}
      onStopNode={handleStopNode}
      onSetSerializationMode={handleSetSerializationMode}
    />
  );
}

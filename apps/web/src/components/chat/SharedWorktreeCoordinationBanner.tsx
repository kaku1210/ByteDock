import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ScopedThreadRef,
  SharedWorktreeCoordinationSnapshot,
  SharedWorktreePathOverlap,
  SharedWorktreeSerializationMode,
  SharedWorktreeThreadAttribution,
  ThreadId,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  FolderGit2Icon,
  InfoIcon,
  LockIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";

interface DeduplicatedThreadFile {
  readonly key: string;
  readonly label: string;
  readonly normalizedPath: string;
  readonly count: number;
  readonly isConflict: boolean;
  readonly isPlannedOnly: boolean;
}

function formatFailureMessage(cause: unknown, uiText: (source: string) => string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return uiText("Failed to update shared worktree coordination policy.");
}

function isThreadActive(thread: SharedWorktreeThreadAttribution): boolean {
  return (
    thread.activeRunId !== null ||
    thread.status === "running" ||
    thread.status === "waiting" ||
    thread.status === "queued" ||
    thread.activeReservations.length > 0
  );
}

function getActiveOverlaps(
  snapshot: SharedWorktreeCoordinationSnapshot,
): ReadonlyArray<SharedWorktreePathOverlap> {
  if (snapshot.overlaps.length === 0) return [];
  const threadById = new Map<ThreadId, SharedWorktreeThreadAttribution>(
    snapshot.threads.map((thread) => [thread.threadId, thread]),
  );
  return snapshot.overlaps.filter((overlap) => {
    if (overlap.severity === "blocking") return true;
    return overlap.participants.some((participant) => {
      if (participant.runId !== null) return true;
      if (participant.layers.includes("reserved")) return true;
      const thread = threadById.get(participant.threadId);
      return thread !== undefined && isThreadActive(thread);
    });
  });
}

function hasVisibleActivity(snapshot: SharedWorktreeCoordinationSnapshot): boolean {
  const isSerialized = snapshot.policy.serializationMode === "serialize_checkout_writes";
  if (isSerialized) return true;
  if (getActiveOverlaps(snapshot).length > 0) return true;
  if (snapshot.activeReservations.length > 0 || snapshot.waitingReservations.length > 0) {
    return true;
  }
  if (snapshot.activeSerializedRun !== null || snapshot.waitingSerializedRuns.length > 0) {
    return true;
  }
  const activeThreadCount = snapshot.threads.filter(isThreadActive).length;
  if (activeThreadCount >= 2 && snapshot.observedUnverifiedPaths.length > 0) {
    return true;
  }
  return false;
}

function deduplicateThreadFiles(
  thread: SharedWorktreeThreadAttribution,
  overlapPaths: ReadonlySet<string>,
): ReadonlyArray<DeduplicatedThreadFile> {
  const byKey = new Map<string, DeduplicatedThreadFile>();

  for (const entry of thread.confirmedWritePaths) {
    const label =
      entry.oldNormalizedPath !== null
        ? `${entry.oldNormalizedPath} -> ${entry.normalizedPath}`
        : entry.normalizedPath;
    const isConflict =
      overlapPaths.has(entry.normalizedPath) ||
      (entry.oldNormalizedPath !== null && overlapPaths.has(entry.oldNormalizedPath));
    const existing = byKey.get(label);
    if (existing) {
      byKey.set(label, {
        ...existing,
        count: existing.count + 1,
        isConflict: existing.isConflict || isConflict,
        isPlannedOnly: false,
      });
    } else {
      byKey.set(label, {
        key: label,
        label,
        normalizedPath: entry.normalizedPath,
        count: 1,
        isConflict,
        isPlannedOnly: false,
      });
    }
  }

  for (const entry of thread.plannedPaths) {
    const label = entry.normalizedPath;
    const isConflict = overlapPaths.has(entry.normalizedPath);
    const existing = byKey.get(label);
    if (existing) {
      if (isConflict && !existing.isConflict) {
        byKey.set(label, { ...existing, isConflict: true });
      }
    } else {
      byKey.set(label, {
        key: label,
        label,
        normalizedPath: entry.normalizedPath,
        count: 1,
        isConflict,
        isPlannedOnly: true,
      });
    }
  }

  return Array.from(byKey.values()).sort((left, right) => {
    if (left.isConflict !== right.isConflict) {
      return left.isConflict ? -1 : 1;
    }
    if (left.isPlannedOnly !== right.isPlannedOnly) {
      return left.isPlannedOnly ? 1 : -1;
    }
    return left.label.localeCompare(right.label);
  });
}

export interface SharedWorktreeCoordinationBannerViewProps {
  readonly snapshot: SharedWorktreeCoordinationSnapshot;
  readonly onSetSerializationMode: (
    mode: SharedWorktreeSerializationMode,
  ) => Promise<string | null>;
  readonly onRefresh?: () => void;
  readonly alwaysShow?: boolean;
  readonly detached?: boolean | undefined;
}

export function SharedWorktreeCoordinationBannerView({
  snapshot,
  onSetSerializationMode,
  onRefresh,
  alwaysShow = false,
  detached,
}: SharedWorktreeCoordinationBannerViewProps) {
  const { text: uiText } = useUiLanguage();
  const [expanded, setExpanded] = useState(() => alwaysShow);
  const [updatingPolicy, setUpdatingPolicy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (!alwaysShow && !hasVisibleActivity(snapshot)) {
    return null;
  }

  const isDetached = detached ?? alwaysShow;
  const isSerialized = snapshot.policy.serializationMode === "serialize_checkout_writes";
  const displayedOverlaps = alwaysShow ? snapshot.overlaps : getActiveOverlaps(snapshot);
  const overlapPathSet = new Set(displayedOverlaps.map((overlap) => overlap.normalizedPath));
  const totalLocks = snapshot.activeReservations.length + snapshot.waitingReservations.length;
  const totalObserved = snapshot.observedUnverifiedPaths.length;

  const threadRows = snapshot.threads.map((thread) => ({
    thread,
    active: isThreadActive(thread),
    files: deduplicateThreadFiles(thread, overlapPathSet),
  }));
  const changedThreads = threadRows.filter(
    (row) => row.files.length > 0 || row.thread.activeReservations.length > 0,
  );
  const unchangedThreadCount =
    threadRows.length -
    changedThreads.length +
    Math.max(0, snapshot.sharedThreadCount - snapshot.threads.length);

  const bannerVariant: ComposerBannerVariant =
    displayedOverlaps.length > 0
      ? "warning"
      : isSerialized
        ? "info"
        : totalLocks > 0 || totalObserved > 0
          ? "warning"
          : "default";

  const handleToggleSerialization = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setUpdatingPolicy(true);
    setError(null);
    const nextMode: SharedWorktreeSerializationMode = isSerialized
      ? "parallel"
      : "serialize_checkout_writes";
    try {
      const failure = await onSetSerializationMode(nextMode);
      if (failure !== null) {
        setError(failure);
      }
    } finally {
      inFlight.current = false;
      setUpdatingPolicy(false);
    }
  };

  const renderLeadingIcon = () => {
    if (displayedOverlaps.length > 0 || (totalObserved > 0 && !isSerialized)) {
      return <AlertTriangleIcon className="text-warning" aria-hidden />;
    }
    if (isSerialized || totalLocks > 0) {
      return <LockIcon className="text-info" aria-hidden />;
    }
    return <FolderGit2Icon className="text-muted-foreground" aria-hidden />;
  };

  const renderHeadline = () => {
    if (expanded) {
      return (
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className="truncate font-medium text-foreground">{uiText("Shared checkout")}</span>
          <ComposerBanner.Separator />
          {displayedOverlaps.length > 0 ? (
            <strong className="shrink-0 font-semibold text-foreground">
              {uiText(
                displayedOverlaps.length === 1
                  ? "{value0} file conflict"
                  : "{value0} file conflicts",
                { value0: displayedOverlaps.length },
              )}
            </strong>
          ) : isSerialized ? (
            <span className="shrink-0 font-medium text-info">
              {uiText("Serialized writes enabled")}
            </span>
          ) : totalLocks > 0 ? (
            <span className="shrink-0 text-muted-foreground">
              {uiText(
                totalLocks === 1 ? "{value0} active write lock" : "{value0} active write locks",
                {
                  value0: totalLocks,
                },
              )}
            </span>
          ) : totalObserved > 0 ? (
            <span className="shrink-0 text-muted-foreground">
              {uiText(
                totalObserved === 1
                  ? "{value0} unverified checkout edit"
                  : "{value0} unverified checkout edits",
                { value0: totalObserved },
              )}
            </span>
          ) : (
            <span className="shrink-0 text-muted-foreground">
              {uiText("Shared checkout coordinated")}
            </span>
          )}
        </span>
      );
    }

    if (displayedOverlaps.length === 1) {
      const firstOverlap = displayedOverlaps[0]!;
      return (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground">
          <span className="shrink-0">
            {uiText("{value0} active threads conflict on", {
              value0: Math.max(firstOverlap.participants.length, 2),
            })}
          </span>
          <code className="truncate rounded bg-foreground/6 px-1.5 py-0.5 font-mono text-2xs text-foreground">
            {firstOverlap.normalizedPath}
          </code>
        </span>
      );
    }

    if (displayedOverlaps.length > 1) {
      const firstOverlap = displayedOverlaps[0]!;
      return (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground">
          <span className="shrink-0">
            {uiText("{value0} file conflicts in shared checkout", {
              value0: displayedOverlaps.length,
            })}
          </span>
          <code className="truncate rounded bg-foreground/6 px-1.5 py-0.5 font-mono text-2xs text-foreground">
            {firstOverlap.normalizedPath}
          </code>
        </span>
      );
    }

    if (isSerialized) {
      const activeCount = snapshot.activeSerializedRun !== null ? 1 : 0;
      const waitingCount = snapshot.waitingSerializedRuns.length;
      return (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground">
          <span className="shrink-0 font-medium">{uiText("Serialized writes enabled")}</span>
          {activeCount > 0 || waitingCount > 0 ? (
            <>
              <ComposerBanner.Separator />
              <span className="truncate text-muted-foreground">
                {uiText("{value0} active · {value1} waiting", {
                  value0: activeCount,
                  value1: waitingCount,
                })}
              </span>
            </>
          ) : null}
        </span>
      );
    }

    if (totalLocks > 0) {
      return (
        <span className="truncate text-foreground">
          {uiText(totalLocks === 1 ? "{value0} active write lock" : "{value0} active write locks", {
            value0: totalLocks,
          })}
        </span>
      );
    }

    if (totalObserved > 0) {
      return (
        <span className="truncate text-foreground">
          {uiText(
            totalObserved === 1
              ? "{value0} unverified checkout edit"
              : "{value0} unverified checkout edits",
            { value0: totalObserved },
          )}
        </span>
      );
    }

    return (
      <span className="truncate text-foreground">{uiText("Shared checkout coordinated")}</span>
    );
  };

  const bannerRoot = (
    <ComposerBanner.Root
      detached={isDetached}
      variant={bannerVariant}
      data-testid="shared-worktree-coordination-banner"
      data-serialization-mode={snapshot.policy.serializationMode}
      data-expanded={expanded ? "true" : "false"}
      aria-live="polite"
    >
      <ComposerBanner.Row>
        <ComposerBanner.Icon>{renderLeadingIcon()}</ComposerBanner.Icon>
        <ComposerBanner.Content data-testid="shared-worktree-summary">
          {renderHeadline()}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant={isSerialized ? "default" : "outline"}
                  data-testid="shared-worktree-serialize-toggle"
                  disabled={updatingPolicy}
                  onClick={() => void handleToggleSerialization()}
                >
                  {isSerialized ? uiText("Serialize writes: ON") : uiText("Serialize writes")}
                </Button>
              }
            />
            <TooltipPopup side="top">
              {uiText(
                "Queue writes from different threads one at a time to prevent overwriting each other",
              )}
            </TooltipPopup>
          </Tooltip>
          {expanded && onRefresh !== undefined ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="shared-worktree-refresh"
              aria-label={uiText("Refresh shared worktree status")}
              onClick={onRefresh}
            >
              <RefreshCwIcon className="size-3" aria-hidden />
            </Button>
          ) : null}
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            data-testid="shared-worktree-expand-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? uiText("Collapse") : uiText("Details")}
            {expanded ? (
              <ChevronUpIcon className="size-3" aria-hidden />
            ) : (
              <ChevronDownIcon className="size-3" aria-hidden />
            )}
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>

      {error !== null ? (
        <p role="alert" className="px-2 pt-1 text-2xs text-destructive">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <div
          data-testid="shared-worktree-scroll-body"
          className="mt-1 flex max-h-[min(18rem,35dvh)] flex-col gap-1.5 overflow-y-auto overscroll-contain border-t border-border/60 px-2 pt-2 pb-1 [scrollbar-width:thin]"
        >
          {displayedOverlaps.length > 0 ? (
            <div data-testid="shared-worktree-overlaps" className="flex flex-col gap-1">
              {displayedOverlaps.map((overlap) => (
                <div
                  key={`${overlap.kind}:${overlap.normalizedPath}`}
                  data-testid="shared-worktree-overlap-item"
                  data-overlap-severity={overlap.severity}
                  data-overlap-kind={overlap.kind}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-2xs",
                    overlap.severity === "blocking"
                      ? "bg-warning/15 text-foreground"
                      : "bg-warning/10 text-foreground",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 font-medium text-warning-foreground">
                      {uiText("Conflict")}
                    </span>
                    <code className="truncate rounded bg-background/80 px-1 py-0.25 font-mono text-2xs text-foreground">
                      {overlap.normalizedPath}
                    </code>
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {overlap.participants.map((participant) => participant.threadTitle).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {changedThreads.length > 0 ? (
            <div data-testid="shared-worktree-details" className="flex flex-col gap-1.5">
              {changedThreads.map(({ thread, active, files }) => (
                <div
                  key={thread.threadId}
                  data-testid="shared-worktree-thread-row"
                  className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          active ? "bg-success" : "bg-muted-foreground/45",
                        )}
                      />
                      <span className="truncate">{thread.title}</span>
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                      {uiText(files.length === 1 ? "{value0} file" : "{value0} files", {
                        value0: files.length,
                      })}
                    </span>
                  </div>
                  {files.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {files.map((file) => (
                        <code
                          key={file.key}
                          data-testid="shared-worktree-file-chip"
                          className={cn(
                            "inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 font-mono text-3xs",
                            file.isConflict
                              ? "border-warning/40 bg-warning/10 text-foreground"
                              : "border-border/75 bg-background text-foreground",
                          )}
                        >
                          <span className="truncate">{file.label}</span>
                          {file.isPlannedOnly ? (
                            <span className="shrink-0 font-sans text-muted-foreground">
                              {uiText("Planned")}
                            </span>
                          ) : null}
                          {file.count > 1 ? (
                            <span className="shrink-0 font-sans text-muted-foreground">
                              ×{file.count}
                            </span>
                          ) : null}
                        </code>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {snapshot.observedUnverifiedPaths.length > 0 ? (
            <div
              data-testid="shared-worktree-observed-unverified"
              className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5"
            >
              <span className="inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground">
                <EyeIcon className="size-3 shrink-0" aria-hidden />
                {uiText("Unattributed checkout changes")}
              </span>
              <div className="flex flex-wrap gap-1">
                {snapshot.observedUnverifiedPaths.map((entry) => (
                  <code
                    key={entry.normalizedPath}
                    data-testid="shared-worktree-observed-path"
                    className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-3xs text-foreground"
                  >
                    {entry.normalizedPath} (+{entry.insertions}/-{entry.deletions})
                  </code>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-2xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              {unchangedThreadCount > 0 ? (
                <span data-testid="shared-worktree-unchanged-count" className="truncate">
                  {uiText(
                    unchangedThreadCount === 1
                      ? "And {value0} unchanged thread"
                      : "And {value0} unchanged threads",
                    { value0: unchangedThreadCount },
                  )}
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-testid="shared-worktree-shell-coverage"
                      aria-label={uiText("Shell constraint coverage")}
                      className="inline-flex items-center gap-1 text-muted-foreground/80 transition-colors hover:text-foreground"
                    >
                      <InfoIcon className="size-3 shrink-0" aria-hidden />
                    </button>
                  }
                />
                <TooltipPopup
                  side="top"
                  data-testid="shared-worktree-shell-coverage-tooltip"
                  className="max-w-72"
                >
                  {snapshot.policy.shellConstraintCoverage.summary}
                </TooltipPopup>
              </Tooltip>
            </div>

            {snapshot.restoreSafetyProtected ? (
              <span
                data-testid="shared-worktree-restore-safety"
                className="inline-flex shrink-0 items-center gap-1 font-medium text-success"
              >
                <ShieldCheckIcon className="size-3" aria-hidden />
                {uiText("Restore safety active")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </ComposerBanner.Root>
  );

  if (isDetached) {
    return bannerRoot;
  }

  return <ComposerBanner.Attachment>{bannerRoot}</ComposerBanner.Attachment>;
}

export function SharedWorktreeCoordinationBanner({
  threadRef,
  alwaysShow = false,
  detached,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly alwaysShow?: boolean;
  readonly detached?: boolean;
}) {
  const { text: uiText } = useUiLanguage();
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : vcsEnvironment.sharedWorktreeSnapshot({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  const setPolicy = useAtomCommand(vcsEnvironment.setSharedWorktreePolicy, {
    label: "set shared worktree serialization policy",
    reportFailure: false,
    reportDefect: false,
  });

  if (threadRef === null || query.data === null) {
    return null;
  }

  return (
    <SharedWorktreeCoordinationBannerView
      snapshot={query.data}
      alwaysShow={alwaysShow}
      detached={detached}
      onRefresh={query.refresh}
      onSetSerializationMode={async (serializationMode) => {
        const result = await setPolicy({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
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
        return formatFailureMessage(squashAtomCommandFailure(result), uiText);
      }}
    />
  );
}

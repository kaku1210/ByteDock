import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ScopedThreadRef,
  SharedWorktreeCoordinationSnapshot,
  SharedWorktreeOverlapKind,
  SharedWorktreeSerializationMode,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  FolderGit2Icon,
  LockIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { Button } from "../ui/button";

function overlapKindLabel(kind: SharedWorktreeOverlapKind): string {
  switch (kind) {
    case "exact":
      return "Same file";
    case "directory_containment":
      return "Directory overlap";
    case "rename_pair":
      return "Rename pair";
  }
}

function formatFailureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return "Failed to update shared worktree coordination policy.";
}

function hasVisibleActivity(snapshot: SharedWorktreeCoordinationSnapshot): boolean {
  const isSerialized = snapshot.policy.serializationMode === "serialize_checkout_writes";
  if (isSerialized) return true;
  if (snapshot.overlaps.length > 0) return true;
  if (snapshot.activeReservations.length > 0 || snapshot.waitingReservations.length > 0)
    return true;
  if (snapshot.activeSerializedRun !== null || snapshot.waitingSerializedRuns.length > 0) {
    return true;
  }
  if (snapshot.sharedThreadCount > 1 && snapshot.observedUnverifiedPaths.length > 0) return true;
  return false;
}

export interface SharedWorktreeCoordinationBannerViewProps {
  readonly snapshot: SharedWorktreeCoordinationSnapshot;
  readonly onSetSerializationMode: (
    mode: SharedWorktreeSerializationMode,
  ) => Promise<string | null>;
  readonly onRefresh?: () => void;
  readonly alwaysShow?: boolean;
}

export function SharedWorktreeCoordinationBannerView({
  snapshot,
  onSetSerializationMode,
  onRefresh,
  alwaysShow = false,
}: SharedWorktreeCoordinationBannerViewProps) {
  const { text: uiText } = useUiLanguage();
  const [expanded, setExpanded] = useState(
    () => alwaysShow || snapshot.overlaps.length > 0 || snapshot.waitingReservations.length > 0,
  );
  const [updatingPolicy, setUpdatingPolicy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (!alwaysShow && !hasVisibleActivity(snapshot)) {
    return null;
  }

  const isSerialized = snapshot.policy.serializationMode === "serialize_checkout_writes";
  const hasBlockingOverlap = snapshot.overlaps.some((overlap) => overlap.severity === "blocking");
  const totalPlanned = snapshot.threads.reduce(
    (sum, thread) => sum + thread.plannedPaths.length,
    0,
  );
  const totalConfirmed = snapshot.threads.reduce(
    (sum, thread) => sum + thread.confirmedWritePaths.length,
    0,
  );
  const totalObserved = snapshot.observedUnverifiedPaths.length;
  const totalLocks = snapshot.activeReservations.length + snapshot.waitingReservations.length;

  const statusBadge = hasBlockingOverlap
    ? {
        label: "Blocking overlap",
        className: "bg-destructive/15 text-destructive border-destructive/30",
      }
    : snapshot.overlaps.length > 0
      ? {
          label: "Overlap warning",
          className: "bg-warning/15 text-warning-foreground border-warning/30",
        }
      : isSerialized
        ? {
            label: "Checkout serialized",
            className: "bg-info/15 text-info border-info/30",
          }
        : totalObserved > 0
          ? {
              label: "Unverified edits",
              className: "bg-warning/15 text-warning-foreground border-warning/30",
            }
          : {
              label: "Coordinated",
              className: "bg-success/15 text-success border-success/30",
            };

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

  return (
    <div
      data-testid="shared-worktree-coordination-banner"
      data-serialization-mode={snapshot.policy.serializationMode}
      className="mb-2 flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/95 p-3 shadow-xs backdrop-blur-xs"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-medium text-foreground">
            {uiText("Shared worktree coordination")}
          </span>
          <span
            data-testid="shared-worktree-thread-count"
            className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-2xs text-muted-foreground"
          >
            {snapshot.sharedThreadCount} {uiText("threads")}
          </span>
          <span
            data-testid="shared-worktree-status-badge"
            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge.className}`}
          >
            {uiText(statusBadge.label)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant={isSerialized ? "default" : "outline"}
            data-testid="shared-worktree-serialize-toggle"
            disabled={updatingPolicy}
            onClick={() => void handleToggleSerialization()}
          >
            <LockIcon className="size-3" aria-hidden />
            {isSerialized
              ? uiText("Serialized checkout writes: ON")
              : uiText("Serialize checkout writes")}
          </Button>
          {onRefresh !== undefined ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="shared-worktree-refresh"
              aria-label={uiText("Refresh shared worktree status")}
              onClick={onRefresh}
            >
              <RefreshCwIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="shared-worktree-expand-toggle"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? (
              <ChevronUpIcon className="size-3.5" aria-hidden />
            ) : (
              <ChevronDownIcon className="size-3.5" aria-hidden />
            )}
            {expanded ? uiText("Hide") : uiText("Details")}
          </Button>
        </div>
      </div>

      <div
        data-testid="shared-worktree-attribution-summary"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        <span data-testid="shared-worktree-count-planned">
          {uiText("Planned:")} <strong className="text-foreground">{totalPlanned}</strong>
        </span>
        <span data-testid="shared-worktree-count-confirmed">
          {uiText("Confirmed writes:")}{" "}
          <strong className="text-foreground">{totalConfirmed}</strong>
        </span>
        <span data-testid="shared-worktree-count-observed">
          {uiText("Observed (unverified):")}{" "}
          <strong className="text-foreground">{totalObserved}</strong>
        </span>
        <span data-testid="shared-worktree-count-locks">
          {uiText("Write locks:")} <strong className="text-foreground">{totalLocks}</strong>
          {snapshot.waitingReservations.length > 0
            ? ` (${snapshot.waitingReservations.length} ${uiText("waiting")})`
            : ""}
        </span>
        {isSerialized &&
        (snapshot.activeSerializedRun !== null || snapshot.waitingSerializedRuns.length > 0) ? (
          <span data-testid="shared-worktree-serialized-queue">
            {uiText("Serialized queue:")}{" "}
            <strong className="text-foreground">
              {snapshot.activeSerializedRun !== null ? 1 : 0} {uiText("active")} /{" "}
              {snapshot.waitingSerializedRuns.length} {uiText("waiting")}
            </strong>
          </span>
        ) : null}
      </div>

      {snapshot.overlaps.length > 0 ? (
        <div data-testid="shared-worktree-overlaps" className="flex flex-col gap-1.5">
          {snapshot.overlaps.map((overlap) => (
            <div
              key={`${overlap.kind}:${overlap.normalizedPath}`}
              data-testid="shared-worktree-overlap-item"
              data-overlap-severity={overlap.severity}
              data-overlap-kind={overlap.kind}
              className={`flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-xs ${
                overlap.severity === "blocking"
                  ? "border-destructive/35 bg-destructive/5"
                  : "border-warning/35 bg-warning/5"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                  <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden />
                  <code className="truncate font-mono">{overlap.normalizedPath}</code>
                </span>
                <span className="text-2xs text-muted-foreground">
                  {uiText(overlapKindLabel(overlap.kind))} · {overlap.severity}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                {overlap.participants.map((participant) => (
                  <span
                    key={participant.threadId}
                    className="rounded border border-border/70 bg-background/80 px-1.5 py-0.5"
                  >
                    <strong className="text-foreground">{participant.threadTitle}</strong> (
                    {participant.layers.join(", ")})
                  </span>
                ))}
              </div>
              <p className="text-2xs text-muted-foreground">{overlap.recommendedAction}</p>
            </div>
          ))}
        </div>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <div
          data-testid="shared-worktree-details"
          className="flex flex-col gap-2 border-t border-border/60 pt-2 text-xs"
        >
          {snapshot.threads.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-foreground">
                {uiText("Per-thread path attribution")}
              </span>
              {snapshot.threads.map((thread) => (
                <div
                  key={thread.threadId}
                  data-testid="shared-worktree-thread-row"
                  className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      L{thread.depth} · {thread.title}
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      {thread.plannedPaths.length} {uiText("planned")} ·{" "}
                      {thread.confirmedWritePaths.length} {uiText("confirmed")} ·{" "}
                      {thread.activeReservations.length} {uiText("locked")}
                    </span>
                  </div>
                  {thread.plannedPaths.length > 0 ? (
                    <div className="flex flex-wrap gap-1 text-2xs">
                      <span className="text-muted-foreground">{uiText("Planned:")}</span>
                      {thread.plannedPaths.map((entry) => (
                        <code
                          key={entry.normalizedPath}
                          className="rounded bg-background px-1 py-0.5 font-mono text-foreground"
                        >
                          {entry.normalizedPath}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  {thread.confirmedWritePaths.length > 0 ? (
                    <div className="flex flex-wrap gap-1 text-2xs">
                      <span className="text-muted-foreground">{uiText("Confirmed:")}</span>
                      {thread.confirmedWritePaths.map((entry) => (
                        <code
                          key={`${entry.source}:${entry.normalizedPath}:${entry.updatedAt}`}
                          className="rounded bg-success/10 px-1 py-0.5 font-mono text-foreground"
                        >
                          {entry.oldNormalizedPath !== null
                            ? `${entry.oldNormalizedPath} -> ${entry.normalizedPath}`
                            : entry.normalizedPath}
                        </code>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {snapshot.observedUnverifiedPaths.length > 0 ? (
            <div data-testid="shared-worktree-observed-unverified" className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <EyeIcon className="size-3.5 text-muted-foreground" aria-hidden />
                {uiText("Observed (unverified) checkout changes")}
              </span>
              <p className="text-2xs text-muted-foreground">
                {uiText(
                  "Dirty working-tree files not matched to any thread's confirmed file-change record or controlled write. Not attributed to any subtask.",
                )}
              </p>
              <div className="flex flex-wrap gap-1">
                {snapshot.observedUnverifiedPaths.map((entry) => (
                  <code
                    key={entry.normalizedPath}
                    data-testid="shared-worktree-observed-path"
                    className="rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-2xs text-foreground"
                  >
                    {entry.normalizedPath} (+{entry.insertions}/-{entry.deletions})
                  </code>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-2xs text-muted-foreground">
            <p
              data-testid="shared-worktree-shell-coverage"
              className="flex min-w-0 items-center gap-1.5"
            >
              <ShieldAlertIcon className="size-3.5 shrink-0" aria-hidden />
              <span>{snapshot.policy.shellConstraintCoverage.summary}</span>
            </p>
            {snapshot.restoreSafetyProtected ? (
              <span
                data-testid="shared-worktree-restore-safety"
                className="inline-flex shrink-0 items-center gap-1 text-success"
              >
                <ShieldCheckIcon className="size-3.5" aria-hidden />
                {uiText("Shared checkout restore safety active")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SharedWorktreeCoordinationBanner({
  threadRef,
  alwaysShow = false,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly alwaysShow?: boolean;
}) {
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
        return formatFailureMessage(squashAtomCommandFailure(result));
      }}
    />
  );
}

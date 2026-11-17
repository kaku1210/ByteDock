import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, CheckIcon, type LucideIcon } from "lucide-react";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { cn } from "../../lib/utils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function threadRelationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return "Starting";
    case "running":
    case "in_progress":
      return "Running";
    case "pending":
    case "queued":
      return "Queued";
    case "waiting":
    case "blocked":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
    case "error":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "rolled_back":
      return "Reverted";
    case "resolved_native":
      return "Resolved (native)";
    case "resolved_portable":
      return "Resolved (portable)";
    case "consumed":
      return "Consumed";
    case "superseded":
      return "Superseded";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

export function SubagentStatusBadge({ status }: { status: string | null }) {
  const { text, t } = useUiLanguage();
  const label = threadRelationshipStatusLabel(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium leading-none",
        label === "Running" || label === "Starting" || label === "Queued"
          ? "bg-info/10 text-info"
          : label === "Waiting"
            ? "bg-warning/10 text-warning"
            : label === "Failed"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
      )}
    >
      {status === "completed" ? (
        <CheckIcon aria-hidden className="size-3" />
      ) : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      {status === "completed" ? t("thread.status.done") : text(label)}
    </span>
  );
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  providerEntries = [],
  status,
  fallbackIcon: FallbackIcon = BotIcon,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  providerEntries?: ReadonlyArray<ProviderInstanceEntry>;
  status: string | null;
  fallbackIcon?: LucideIcon;
}) {
  const iconClassName = "size-4 shrink-0 text-muted-foreground";
  const entry = driver
    ? providerEntries.find((candidate) => candidate.instanceId === provider?.instanceId)
    : undefined;
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, providerEntries);
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={entry?.displayName ?? provider?.displayName ?? driver}
          accentColor={entry?.accentColor}
          acpRegistryAgentId={entry?.acpRegistryAgentId}
          acpRegistryIconUrl={entry?.acpRegistryIconUrl ?? provider?.iconUrl}
          showBadge={showInstanceBadge}
          size="compact"
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          "absolute size-2 rounded-full border-2 border-card",
          showInstanceBadge ? "-left-1 -top-1" : "-bottom-1 -right-1",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}

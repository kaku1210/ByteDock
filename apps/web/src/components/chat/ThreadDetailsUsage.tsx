import { useUiLanguage } from "../../i18n/useUiLanguage";
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ContextWindowDetails, type ContextWindowDetailsProps } from "./ContextWindowDetails";
import { UNKNOWN_CONTEXT_VALUE } from "./ContextWindowDetails.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
}

type UsageTone = "error" | "warning" | null;

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: ThreadDetailsUsageInput) {
  const { text: uiText } = useUiLanguage();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={uiText("Usage limits")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label={uiText("Limits")}
            fill={null}
            tone={null}
            value="Unavailable"
            details={<span className="text-foreground">{notice}</span>}
          />
        ) : (
          limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext(props: ContextWindowDetailsProps) {
  const { usage } = props;
  const { text: uiText, t } = useUiLanguage();
  const maxTokens = usage?.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage?.usedPercentage != null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage?.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = usage ? formatContextWindowTokens(usage.usedTokens) : UNKNOWN_CONTEXT_VALUE;
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={uiText("Context window")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={uiText("Context")}
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaLabel={t("composer.contextWindowUsed", {
            percentage: `${used ?? UNKNOWN_CONTEXT_VALUE}%`,
          })}
          interactive
          details={<ContextWindowDetails {...props} />}
        />
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const { text: uiText } = useUiLanguage();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaLabel={`${window.label}: ${left}% left`}
      details={
        <>
          <span className="text-foreground">
            {window.label}: {left}
            {uiText("% left")}
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {uiText("Resets in ")}
              {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaLabel = `${label}: ${value}`,
  details,
  interactive = false,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaLabel?: string;
  readonly details: ReactNode;
  readonly interactive?: boolean;
  readonly muted?: boolean;
}) {
  const rowClassName =
    "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]";
  const content = (
    <>
      <span className="max-w-28 truncate text-muted-foreground">{label}</span>
      {fill !== null ? (
        <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
          {fill > 0 ? (
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                tone === "error"
                  ? "bg-error"
                  : tone === "warning"
                    ? "bg-warning"
                    : muted
                      ? "bg-muted-foreground"
                      : "bg-foreground/80",
              )}
              style={{ width: `max(${fill}%, 6px)` }}
            />
          ) : null}
          {tick !== null ? (
            <span
              aria-hidden
              className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
              style={{ left: `${tick}%` }}
            />
          ) : null}
        </span>
      ) : null}
      <span
        className={cn(
          // Text-only rows span the bar column so they never widen the shared value column.
          "text-end font-medium tabular-nums",
          fill === null && "col-span-2",
          tone === "error"
            ? "text-error-foreground"
            : tone === "warning"
              ? "text-warning-foreground"
              : fill === null
                ? "text-muted-foreground"
                : "text-foreground/80",
        )}
      >
        {value}
      </span>
    </>
  );
  if (interactive) {
    return (
      <Popover>
        <PopoverTrigger
          render={<button type="button" className={cn(rowClassName, "cursor-pointer")} />}
          aria-label={ariaLabel}
        >
          {content}
        </PopoverTrigger>
        <PopoverPopup
          side="left"
          sideOffset={16}
          padding="none"
          width="sm"
          tooltipStyle
          aria-label={label}
        >
          {details}
        </PopoverPopup>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div tabIndex={0} aria-label={ariaLabel} className={cn(rowClassName, "cursor-default")} />
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{details}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

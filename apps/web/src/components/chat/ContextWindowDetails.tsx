import { Button } from "../ui/button";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { formatContextWindowCost, UNKNOWN_CONTEXT_VALUE } from "./ContextWindowDetails.logic";
import { Minimize2Icon } from "lucide-react";
import { useUiLanguage } from "~/i18n/useUiLanguage";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** Displays reported context usage; an unknown report or limit is distinct from zero usage. */
export interface ContextWindowDetailsProps {
  usage: ContextWindowSnapshot | null;
  loading?: boolean;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
}

export function ContextWindowDetails(props: ContextWindowDetailsProps) {
  const { text: uiText, language, t } = useUiLanguage();
  const { usage, modelDisplayName, onCompact, compactDisabled } = props;

  const usedPercentage = formatPercentage(usage?.usedPercentage ?? null);
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : normalizedPercentage >= 70
      ? "var(--color-warning)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const fullTokens = (value: number | null | undefined) =>
    value == null ? UNKNOWN_CONTEXT_VALUE : value.toLocaleString(language);
  const displayedPercentage = usedPercentage ?? `${UNKNOWN_CONTEXT_VALUE}%`;

  return (
    <div className="flex flex-col gap-2 p-(--floating-content-inset)">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">
          {t("composer.contextWindow")}
        </div>
        <span className="text-secondary-label text-2xs">{displayedPercentage}</span>
      </div>
      <p className="font-mono text-xs tabular-nums">
        {fullTokens(usage?.usedTokens)} / {fullTokens(usage?.maxTokens)}
        {uiText(" tokens")}
      </p>
      {modelDisplayName ? (
        <p className="text-secondary-label text-2xs">{modelDisplayName}</p>
      ) : null}
      {!usage || usedPercentage === null ? (
        <p className="text-secondary-label text-2xs">
          {t(
            props.loading
              ? "composer.contextLoading"
              : !usage
                ? "composer.contextNotReported"
                : "composer.contextLimitNotReported",
          )}
        </p>
      ) : null}
      {usedPercentage !== null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(normalizedPercentage)}
          aria-label={t("composer.contextWindow")}
        >
          <div
            className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
          />
        </div>
      ) : null}
      {showTotalProcessed ? (
        <div className="flex items-center justify-between gap-3 text-2xs leading-4">
          <span className="text-secondary-label">{t("composer.contextTotalProcessed")}</span>
          <span className="font-medium tabular-nums text-secondary-label">
            {formatContextWindowTokens(totalProcessedTokens)}
          </span>
        </div>
      ) : null}
      {usage?.cost != null ? (
        <div className="flex items-center justify-between gap-3 text-2xs leading-4">
          <span className="text-secondary-label">{t("composer.contextCost")}</span>
          <span className="font-medium tabular-nums text-secondary-label">
            {formatContextWindowCost(usage.cost)}
          </span>
        </div>
      ) : null}
      {usage?.compactsAutomatically ? (
        <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
          {usage.autoCompactThreshold != null && usage.autoCompactThreshold > 0
            ? t("composer.contextAutoCompactThreshold", {
                tokens: fullTokens(usage.autoCompactThreshold),
              })
            : t("composer.contextAutoCompact")}
        </div>
      ) : null}
      {onCompact ? (
        <>
          <Button
            size="xs"
            variant="outline"
            className="mt-1 w-full justify-center"
            disabled={compactDisabled}
            onClick={onCompact}
          >
            <Minimize2Icon aria-hidden="true" />
            {t("composer.contextCompact")}
          </Button>
          {compactDisabled ? (
            <div className="text-pretty text-secondary-label text-2xs">
              {t("composer.compactionUnavailable")}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

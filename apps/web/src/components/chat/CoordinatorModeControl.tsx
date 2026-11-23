import {
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateId,
  type CoordinatorTierResolutionSource,
  type ModelSelection,
  type ProjectId,
  type ResolvedCoordinatorConfiguration,
  type ServerProvider,
  type ThreadCoordinatorMode,
} from "@t3tools/contracts";
import type { CoordinatorResolutionSettingsSlice } from "@t3tools/shared/coordinator";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, LayersIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import {
  COORDINATOR_TIERS,
  coordinatorDelegationStrategyLabel,
  coordinatorDelegationStrategyShortLabel,
  coordinatorTierRoleLabel,
  coordinatorTierShortRoleLabel,
  coordinatorTierShortSourceLabel,
  coordinatorTierSourceLabel,
  formatCoordinatorModelSelectionLabel,
  formatCoordinatorModelShortName,
  resolveCoordinatorControlState,
} from "./coordinatorModeControl.logic";

function sourceBadgeClassName(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "template_configured":
      return "border-primary/30 bg-primary/10 text-primary";
    case "root_thread":
      return "border-info/30 bg-info/10 text-info";
    case "dynamic_available":
      return "border-border bg-muted/70 text-muted-foreground";
    case "fallback_available":
      return "border-warning/40 bg-warning/15 text-warning-foreground";
    case "unavailable":
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}

function compactSourcePillClassName(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "template_configured":
      return "bg-primary/10 text-primary";
    case "root_thread":
      return "bg-primary/10 text-primary";
    case "dynamic_available":
      return "bg-muted text-muted-foreground";
    case "fallback_available":
      return "bg-warning/15 text-warning-foreground";
    case "unavailable":
      return "bg-destructive/10 text-destructive";
  }
}

function formatTemplateDisplayName(
  template: Pick<CoordinatorRoleTemplate, "name" | "builtIn">,
  uiText: (source: string) => string,
): string {
  return template.builtIn ? uiText(template.name) : template.name;
}

export function CoordinatorTierPreviewList({
  resolved,
  providers,
  compact = false,
  variant = "cards",
  testIdPrefix = "coordinator-preview",
}: {
  readonly resolved: ResolvedCoordinatorConfiguration;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly compact?: boolean;
  readonly variant?: "cards" | "compact-table";
  readonly testIdPrefix?: string;
}) {
  const { text: uiText } = useUiLanguage();

  if (variant === "compact-table") {
    return (
      <div className="space-y-1.5" data-testid={`${testIdPrefix}-tiers`}>
        {resolved.templateFallbackUsed && resolved.templateFallbackReason ? (
          <div
            data-testid={`${testIdPrefix}-template-fallback`}
            className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-2xs text-warning-foreground"
          >
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>{resolved.templateFallbackReason}</span>
          </div>
        ) : null}

        <div className="space-y-1.5">
          {COORDINATOR_TIERS.map((tier) => {
            const item = resolved.tiers[tier];
            const shortModelLabel = formatCoordinatorModelShortName(item.modelSelection, providers);
            const fullModelLabel = formatCoordinatorModelSelectionLabel(
              item.modelSelection,
              providers,
            );
            const sourceLabel = coordinatorTierShortSourceLabel(item.source);

            return (
              <div key={tier} data-testid={`${testIdPrefix}-tier-${tier}`} className="space-y-1">
                <div className="grid grid-cols-[minmax(4.25rem,auto)_minmax(0,1fr)_auto] items-center gap-2">
                  <span className="text-2xs font-medium text-muted-foreground">
                    {uiText(coordinatorTierShortRoleLabel(tier))}
                  </span>
                  {item.modelSelection === null ? (
                    <span
                      data-testid={`${testIdPrefix}-model-${tier}`}
                      className="truncate font-mono text-xs font-medium text-foreground"
                    >
                      {uiText("Unavailable")}
                    </span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            data-testid={`${testIdPrefix}-model-${tier}`}
                            className="truncate font-mono text-xs font-medium text-foreground"
                          >
                            {shortModelLabel}
                          </span>
                        }
                      />
                      <TooltipPopup side="top">{fullModelLabel}</TooltipPopup>
                    </Tooltip>
                  )}
                  <span
                    data-testid={`${testIdPrefix}-source-${tier}`}
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-3xs font-medium",
                      compactSourcePillClassName(item.source),
                    )}
                  >
                    {uiText(sourceLabel)}
                  </span>
                </div>
                {item.fallbackUsed && item.fallbackReason ? (
                  <div
                    data-testid={`${testIdPrefix}-fallback-${tier}`}
                    className="flex items-start gap-1 rounded-md border border-warning/35 bg-warning/10 px-2 py-1 text-3xs text-warning-foreground"
                  >
                    <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span>{item.fallbackReason}</span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-tiers`}>
      {resolved.templateFallbackUsed && resolved.templateFallbackReason ? (
        <div
          data-testid={`${testIdPrefix}-template-fallback`}
          className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-2xs text-warning-foreground"
        >
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{resolved.templateFallbackReason}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="rounded border border-border/80 bg-muted/50 px-1.5 py-0.5">
          {uiText(coordinatorDelegationStrategyLabel(resolved.template.delegationStrategy))}
        </span>
        <span className="rounded border border-border/80 bg-muted/50 px-1.5 py-0.5">
          {resolved.template.preferDelegation
            ? uiText("Prefer delegation")
            : uiText("Flexible execution")}
        </span>
      </div>

      <div className="space-y-1">
        {COORDINATOR_TIERS.map((tier) => {
          const item = resolved.tiers[tier];
          const modelLabel = formatCoordinatorModelSelectionLabel(item.modelSelection, providers);
          const sourceLabel = coordinatorTierSourceLabel(item.source);
          return (
            <div
              key={tier}
              data-testid={`${testIdPrefix}-tier-${tier}`}
              className={cn(
                "rounded-md border border-border/70 bg-muted/25",
                compact ? "px-2 py-1.5" : "px-2.5 py-2",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="inline-flex shrink-0 items-center rounded border border-border bg-background px-1 py-0.25 font-mono text-3xs font-semibold text-foreground">
                    {tier}
                  </span>
                  <span className="truncate text-2xs font-medium text-muted-foreground">
                    {uiText(coordinatorTierRoleLabel(tier))}
                  </span>
                </div>
                <span
                  data-testid={`${testIdPrefix}-source-${tier}`}
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.25 text-3xs font-medium",
                    sourceBadgeClassName(item.source),
                  )}
                >
                  {uiText(sourceLabel)}
                </span>
              </div>
              <div
                data-testid={`${testIdPrefix}-model-${tier}`}
                className={cn(
                  "mt-1 truncate font-mono text-foreground",
                  compact ? "text-2xs" : "text-xs",
                )}
              >
                {item.modelSelection === null ? uiText("Unavailable") : modelLabel}
              </div>
              {item.fallbackUsed && item.fallbackReason ? (
                <div
                  data-testid={`${testIdPrefix}-fallback-${tier}`}
                  className="mt-1 flex items-start gap-1 text-3xs text-warning-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>{item.fallbackReason}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CoordinatorModeControl({
  coordinatorMode,
  settings,
  providers,
  projectId,
  rootModelSelection,
  size = "sm",
  compact = false,
  disabled = false,
  onChange,
}: {
  readonly coordinatorMode: ThreadCoordinatorMode | null | undefined;
  readonly settings: CoordinatorResolutionSettingsSlice;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly rootModelSelection: ModelSelection | null | undefined;
  readonly size?: ComposerControlSize;
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: ThreadCoordinatorMode) => void;
}) {
  const { text: uiText } = useUiLanguage();
  const navigate = useNavigate();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);

  const state = resolveCoordinatorControlState({
    coordinatorMode,
    settings,
    providers,
    projectId,
    rootModelSelection,
  });

  const handleToggleEnabled = (enabled: boolean) => {
    if (disabled) return;
    onChange({
      enabled,
      templateId: state.resolved.template.id,
    });
  };

  const handleTemplateChange = (nextTemplateId: string | null) => {
    if (disabled || nextTemplateId === null) return;
    onChange({
      enabled: state.enabled,
      templateId: nextTemplateId as CoordinatorRoleTemplateId,
    });
  };

  const activeTemplateName = formatTemplateDisplayName(state.resolved.template, uiText);
  const triggerAriaLabel = state.enabled
    ? uiText("Task Coordinator Mode enabled ({value0})", { value0: activeTemplateName })
    : uiText("Task Coordinator Mode");

  const delegationPolicyLabel = state.resolved.template.preferDelegation
    ? uiText("Prefer delegation")
    : uiText("Flexible execution");
  const modelStrategyLabel = uiText(
    coordinatorDelegationStrategyShortLabel(state.resolved.template.delegationStrategy),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <ComposerControl
                  size={size}
                  aria-label={triggerAriaLabel}
                  aria-pressed={state.enabled}
                  data-testid="coordinator-mode-trigger"
                  data-coordinator-enabled={state.enabled ? "true" : "false"}
                  className={cn(
                    state.enabled
                      ? "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                      : "text-muted-foreground",
                  )}
                >
                  <ComposerControlIcon
                    icon={LayersIcon}
                    size={size}
                    className={state.enabled ? "text-primary" : undefined}
                  />
                  {!compact ? (
                    <span
                      data-composer-control-label
                      className="max-w-28 truncate text-xs font-medium"
                    >
                      {uiText("Coordinator")}
                    </span>
                  ) : null}
                  {state.enabled && (state.hasAnyFallback || state.hasUnavailableTier) ? (
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                    />
                  ) : null}
                </ComposerControl>
              }
            />
          }
        />
        <TooltipPopup side="top">{triggerAriaLabel}</TooltipPopup>
      </Tooltip>

      <PopoverPopup
        align="start"
        side="top"
        sideOffset={8}
        className="w-76 max-w-[calc(100vw-2rem)]"
        data-testid="coordinator-mode-popover"
        {...composerFloatingLayerProps}
      >
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <LayersIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    state.enabled ? "text-primary" : "text-muted-foreground",
                  )}
                  aria-hidden
                />
                <span>{uiText("Task Coordinator Mode")}</span>
              </div>
              <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                {state.enabled
                  ? uiText("This thread focuses on planning, delegation, review, and synthesis.")
                  : uiText(
                      "Split complex tasks into parallel subtasks with automatic model tiering.",
                    )}
              </p>
            </div>
            <Switch
              checked={state.enabled}
              disabled={disabled}
              onCheckedChange={(checked) => handleToggleEnabled(Boolean(checked))}
              aria-label={uiText("Enable Task Coordinator Mode")}
              data-testid="coordinator-mode-toggle"
            />
          </div>

          {state.enabled ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="coordinator-template-select"
                  className="shrink-0 text-xs font-medium text-muted-foreground"
                >
                  {uiText("Template")}
                </label>
                <Select
                  value={state.resolved.template.id}
                  onValueChange={handleTemplateChange}
                  disabled={disabled}
                >
                  <SelectTrigger
                    id="coordinator-template-select"
                    size="sm"
                    className="h-7 w-auto min-w-32 max-w-44"
                    aria-label={uiText("Coordinator role template")}
                    data-testid="coordinator-template-select"
                  >
                    <SelectValue>
                      {(value: string | null) => {
                        const matched = state.templates.find((item) => item.id === value);
                        return matched
                          ? formatTemplateDisplayName(matched, uiText)
                          : activeTemplateName;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {state.templates.map((template) => (
                      <SelectItem
                        key={template.id}
                        value={template.id}
                        data-testid={`coordinator-template-option-${template.id}`}
                      >
                        <span className="truncate">
                          {formatTemplateDisplayName(template, uiText)}
                        </span>
                        {template.builtIn ? (
                          <span className="ms-1.5 text-2xs text-muted-foreground">
                            ({uiText("Built-in")})
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              <div className="border-t border-border/70 pt-2">
                <CoordinatorTierPreviewList
                  resolved={state.resolved}
                  providers={providers}
                  variant="compact-table"
                  testIdPrefix="coordinator-preview"
                />
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2 text-2xs text-muted-foreground">
                <span className="truncate">
                  {uiText("Policy: {value0} · {value1}", {
                    value0: delegationPolicyLabel,
                    value1: modelStrategyLabel,
                  })}
                </span>
                <Button
                  type="button"
                  size="micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  data-testid="coordinator-manage-templates"
                  onClick={() => {
                    setOpen(false);
                    void navigate({ to: "/settings/threads" });
                  }}
                >
                  <Settings2Icon className="size-3" aria-hidden />
                  {uiText("Manage templates")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div
                data-testid="coordinator-mode-disabled-summary"
                className="rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2 text-2xs leading-relaxed text-muted-foreground"
              >
                {uiText(
                  "When enabled, this thread plans and reviews while automatically matching faster or stronger models to each subtask.",
                )}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2 text-2xs text-muted-foreground">
                <span className="truncate">{uiText("Current: Direct execution")}</span>
                <Button
                  type="button"
                  size="micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  data-testid="coordinator-manage-templates"
                  onClick={() => {
                    setOpen(false);
                    void navigate({ to: "/settings/threads" });
                  }}
                >
                  <Settings2Icon className="size-3" aria-hidden />
                  {uiText("Manage templates")}
                </Button>
              </div>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

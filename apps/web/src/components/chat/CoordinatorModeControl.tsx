import {
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
  coordinatorTierRoleLabel,
  coordinatorTierSourceLabel,
  formatCoordinatorModelSelectionLabel,
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

export function CoordinatorTierPreviewList({
  resolved,
  providers,
  compact = false,
  testIdPrefix = "coordinator-preview",
}: {
  readonly resolved: ResolvedCoordinatorConfiguration;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly compact?: boolean;
  readonly testIdPrefix?: string;
}) {
  const { text: uiText } = useUiLanguage();

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

  const triggerAriaLabel = state.enabled
    ? uiText("L0 Coordinator Mode enabled ({value0})", { value0: state.resolved.template.name })
    : uiText("L0 Coordinator Mode");

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
                      {state.enabled ? state.resolved.template.name : uiText("Coordinator")}
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
        className="w-84 max-w-[calc(100vw-2rem)]"
        data-testid="coordinator-mode-popover"
        {...composerFloatingLayerProps}
      >
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <LayersIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
                <span>{uiText("L0 Coordinator Mode")}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {uiText(
                  "Focus this root thread on task decomposition, delegation, review, and synthesis.",
                )}
              </p>
            </div>
            <Switch
              checked={state.enabled}
              disabled={disabled}
              onCheckedChange={(checked) => handleToggleEnabled(Boolean(checked))}
              aria-label={uiText("Enable L0 Coordinator Mode")}
              data-testid="coordinator-mode-toggle"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="coordinator-template-select"
              className="block text-xs font-medium text-foreground"
            >
              {uiText("Role template")}
            </label>
            <Select
              value={state.resolved.template.id}
              onValueChange={handleTemplateChange}
              disabled={disabled}
            >
              <SelectTrigger
                id="coordinator-template-select"
                size="sm"
                className="w-full"
                aria-label={uiText("Coordinator role template")}
                data-testid="coordinator-template-select"
              >
                <SelectValue>
                  {(value: string | null) => {
                    const matched = state.templates.find((item) => item.id === value);
                    return matched ? matched.name : state.resolved.template.name;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {state.templates.map((template) => (
                  <SelectItem
                    key={template.id}
                    value={template.id}
                    data-testid={`coordinator-template-option-${template.id}`}
                  >
                    <span className="truncate">{template.name}</span>
                    {template.builtIn ? (
                      <span className="ms-1.5 text-2xs text-muted-foreground">
                        ({uiText("Built-in")})
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {state.resolved.template.description ? (
              <p className="text-2xs text-muted-foreground">
                {state.resolved.template.description}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5 border-t border-border/70 pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                {uiText("Dynamic tier preview")}
              </span>
              <span className="text-3xs text-muted-foreground">
                {state.enabled ? uiText("Active on L0") : uiText("Preview when enabled")}
              </span>
            </div>
            <CoordinatorTierPreviewList
              resolved={state.resolved}
              providers={providers}
              compact
              testIdPrefix="coordinator-preview"
            />
          </div>

          <div className="flex items-center justify-end border-t border-border/70 pt-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="coordinator-manage-templates"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/settings/threads" });
              }}
            >
              <Settings2Icon className="size-3" aria-hidden />
              {uiText("Manage role templates")}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

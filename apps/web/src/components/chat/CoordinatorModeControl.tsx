import {
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateId,
  type CoordinatorTier,
  type CoordinatorTierModelOverrides,
  type CoordinatorTierResolutionSource,
  type ModelSelection,
  type ProjectId,
  type ResolvedCoordinatorConfiguration,
  type ServerProvider,
  type ThreadCoordinatorMode,
} from "@t3tools/contracts";
import type {
  CoordinatorResolutionSettingsSlice,
  CoordinatorSelectableProviderGroup,
} from "@t3tools/shared/coordinator";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, LayersIcon, RotateCcwIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import {
  buildCoordinatorTemplateSwitchMode,
  buildCoordinatorTierOverrideMode,
  buildCoordinatorToggleMode,
  COORDINATOR_TIER_OPTION_FOLLOW,
  COORDINATOR_TIER_OPTION_TEMPLATE,
  COORDINATOR_TIERS,
  coordinatorSceneModeLabel,
  coordinatorTierRoleLabel,
  coordinatorTierShortRoleLabel,
  coordinatorTierShortSourceLabel,
  coordinatorTierSourceLabel,
  decodeCoordinatorTierOption,
  encodeCoordinatorTierModelOption,
  formatCoordinatorModelSelectionLabel,
  formatCoordinatorModelShortName,
  isCoordinatorOverridableTier,
  resolveCoordinatorControlState,
  resolveCoordinatorTierSelectValue,
  type CoordinatorOverridableTier,
} from "./coordinatorModeControl.logic";

function sourceBadgeClassName(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "thread_override":
      return "border-primary/40 bg-primary/15 text-primary";
    case "template_configured":
      return "border-primary/30 bg-primary/10 text-primary";
    case "root_thread":
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
    case "thread_override":
      return "bg-primary/15 text-primary";
    case "template_configured":
      return "bg-primary/10 text-primary";
    case "root_thread":
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
  tiers = COORDINATOR_TIERS,
  compact = false,
  variant = "cards",
  testIdPrefix = "coordinator-preview",
  tierModelOverrides,
  selectableProviderGroups,
  disabled = false,
  onTierModelOverrideChange,
}: {
  readonly resolved: ResolvedCoordinatorConfiguration;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly tiers?: ReadonlyArray<CoordinatorTier>;
  readonly compact?: boolean;
  readonly variant?: "cards" | "compact-table";
  readonly testIdPrefix?: string;
  readonly tierModelOverrides?: CoordinatorTierModelOverrides | undefined;
  readonly selectableProviderGroups?: ReadonlyArray<CoordinatorSelectableProviderGroup> | undefined;
  readonly disabled?: boolean;
  readonly onTierModelOverrideChange?:
    | ((tier: CoordinatorOverridableTier, nextValue: ModelSelection | null | undefined) => void)
    | undefined;
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
          {tiers.map((tier) => {
            const item = resolved.tiers[tier];
            const shortModelLabel = formatCoordinatorModelShortName(item.modelSelection, providers);
            const fullModelLabel = formatCoordinatorModelSelectionLabel(
              item.modelSelection,
              providers,
            );
            const sourceLabel = coordinatorTierShortSourceLabel(item.source);
            const showWarningReason =
              (item.fallbackUsed || item.source === "unavailable") && item.fallbackReason !== null;
            const roleLabel = uiText(coordinatorTierShortRoleLabel(tier));
            const editableTier =
              onTierModelOverrideChange && isCoordinatorOverridableTier(tier) ? tier : null;

            return (
              <div key={tier} data-testid={`${testIdPrefix}-tier-${tier}`} className="space-y-1">
                <div className="grid grid-cols-[minmax(4.25rem,auto)_minmax(0,1fr)_auto] items-center gap-2">
                  <span className="text-2xs font-medium text-muted-foreground">{roleLabel}</span>
                  {editableTier !== null ? (
                    (() => {
                      const templateTierModel = resolved.template.tierModels[editableTier];
                      const overrideValue =
                        tierModelOverrides && Object.hasOwn(tierModelOverrides, editableTier)
                          ? tierModelOverrides[editableTier]
                          : undefined;
                      const selectValue = resolveCoordinatorTierSelectValue({
                        templateTierModel,
                        overrideValue,
                        resolved: item,
                      });
                      const providerGroups = selectableProviderGroups ?? [];

                      return (
                        <Select
                          value={selectValue}
                          disabled={disabled}
                          onValueChange={(nextValue) => {
                            if (nextValue === null) return;
                            const decoded = decodeCoordinatorTierOption(nextValue);
                            if (decoded === null) return;
                            if (decoded.kind === "template") {
                              onTierModelOverrideChange?.(editableTier, undefined);
                            } else if (decoded.kind === "follow") {
                              onTierModelOverrideChange?.(editableTier, null);
                            } else {
                              onTierModelOverrideChange?.(editableTier, decoded.selection);
                            }
                          }}
                        >
                          <Tooltip>
                            <SelectTrigger
                              size="xs"
                              disabled={disabled}
                              aria-label={uiText("Choose model for {value0}", {
                                value0: roleLabel,
                              })}
                              data-testid={`${testIdPrefix}-picker-${editableTier}`}
                              className="min-w-0 w-full"
                            >
                              <TooltipTrigger
                                render={
                                  <span
                                    data-testid={`${testIdPrefix}-model-${editableTier}`}
                                    className={cn(
                                      "min-w-0 flex-1 truncate text-left font-mono font-medium",
                                      item.modelSelection === null && "text-destructive",
                                    )}
                                  >
                                    {item.modelSelection === null
                                      ? uiText("Unavailable")
                                      : shortModelLabel}
                                  </span>
                                }
                              />
                            </SelectTrigger>
                            <TooltipPopup side="top">
                              {item.modelSelection === null
                                ? (item.fallbackReason ?? uiText("Unavailable"))
                                : fullModelLabel}
                            </TooltipPopup>
                          </Tooltip>
                          <SelectPopup
                            align="end"
                            alignItemWithTrigger={false}
                            matchTriggerWidth={false}
                            className="min-w-48 max-w-64"
                          >
                            <SelectGroup>
                              {templateTierModel !== null ? (
                                <>
                                  <SelectItem
                                    value={COORDINATOR_TIER_OPTION_TEMPLATE}
                                    data-testid={`${testIdPrefix}-option-${editableTier}-template`}
                                  >
                                    <span className="truncate">
                                      {uiText("Use template ({value0})", {
                                        value0: formatCoordinatorModelShortName(
                                          templateTierModel,
                                          providers,
                                        ),
                                      })}
                                    </span>
                                  </SelectItem>
                                  <SelectItem
                                    value={COORDINATOR_TIER_OPTION_FOLLOW}
                                    data-testid={`${testIdPrefix}-option-${editableTier}-follow`}
                                  >
                                    <span className="truncate">
                                      {uiText("Follow current thread")}
                                    </span>
                                  </SelectItem>
                                </>
                              ) : (
                                <SelectItem
                                  value={COORDINATOR_TIER_OPTION_TEMPLATE}
                                  data-testid={`${testIdPrefix}-option-${editableTier}-follow`}
                                >
                                  <span className="truncate">
                                    {uiText("Follow current thread")}
                                  </span>
                                </SelectItem>
                              )}
                            </SelectGroup>
                            {providerGroups.map((group) => (
                              <SelectGroup key={group.provider.instanceId}>
                                <SelectGroupLabel>{group.provider.displayName}</SelectGroupLabel>
                                {group.models.map((model) => (
                                  <SelectItem
                                    key={`${group.provider.instanceId}:${model.slug}`}
                                    value={encodeCoordinatorTierModelOption(
                                      group.provider.instanceId,
                                      model.slug,
                                    )}
                                    data-testid={`${testIdPrefix}-option-${editableTier}-${group.provider.instanceId}-${model.slug}`}
                                  >
                                    <span className="truncate">{model.name}</span>
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            ))}
                          </SelectPopup>
                        </Select>
                      );
                    })()
                  ) : item.modelSelection === null ? (
                    <span
                      data-testid={`${testIdPrefix}-model-${tier}`}
                      className="truncate font-mono text-xs font-medium text-destructive"
                    >
                      {uiText("Unavailable")}
                    </span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            data-testid={`${testIdPrefix}-model-${tier}`}
                            className="truncate px-1.5 font-mono text-xs font-medium text-foreground"
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
                {showWarningReason ? (
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
          {uiText("Scene: {value0}", {
            value0: uiText(coordinatorSceneModeLabel(resolved.template.mode)),
          })}
        </span>
        <span className="rounded border border-border/80 bg-muted/50 px-1.5 py-0.5">
          {resolved.template.preferDelegation
            ? uiText("Prefer delegation")
            : uiText("Flexible execution")}
        </span>
      </div>

      <div className="space-y-1">
        {tiers.map((tier) => {
          const item = resolved.tiers[tier];
          const modelLabel = formatCoordinatorModelSelectionLabel(item.modelSelection, providers);
          const sourceLabel = coordinatorTierSourceLabel(item.source);
          const showWarningReason =
            (item.fallbackUsed || item.source === "unavailable") && item.fallbackReason !== null;
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
              {showWarningReason ? (
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
  callerTier = "L0",
  inheritedRootTemplateId = null,
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
  readonly callerTier?: "L0" | "L1";
  readonly inheritedRootTemplateId?: CoordinatorRoleTemplateId | null | undefined;
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
    callerTier,
    inheritedRootTemplateId,
  });

  const handleToggleEnabled = (enabled: boolean) => {
    if (disabled) return;
    onChange(
      buildCoordinatorToggleMode({
        enabled,
        templateId: state.resolved.template.id,
        tierModelOverrides: state.tierModelOverrides,
      }),
    );
  };

  const handleTemplateChange = (nextTemplateId: string | null) => {
    if (disabled || nextTemplateId === null) return;
    onChange(
      buildCoordinatorTemplateSwitchMode({
        enabled: state.enabled,
        templateId: nextTemplateId as CoordinatorRoleTemplateId,
      }),
    );
  };

  const handleTierModelOverrideChange = (
    tier: CoordinatorOverridableTier,
    nextValue: ModelSelection | null | undefined,
  ) => {
    if (disabled) return;
    onChange(
      buildCoordinatorTierOverrideMode({
        enabled: state.enabled,
        templateId: state.resolved.template.id,
        currentOverrides: state.tierModelOverrides,
        tier,
        templateTierModel: state.resolved.template.tierModels[tier],
        nextValue,
      }),
    );
  };

  const handleResetOverrides = () => {
    if (disabled) return;
    onChange(
      buildCoordinatorTemplateSwitchMode({
        enabled: state.enabled,
        templateId: state.resolved.template.id,
      }),
    );
  };

  const isL1 = state.callerTier === "L1";
  const activeTemplateName = formatTemplateDisplayName(state.resolved.template, uiText);
  const triggerAriaLabel = state.enabled
    ? uiText(
        isL1
          ? "Sub-Coordinator Mode enabled ({value0})"
          : "Task Coordinator Mode enabled ({value0})",
        { value0: activeTemplateName },
      )
    : uiText(isL1 ? "Sub-Coordinator Mode (L1)" : "Task Coordinator Mode");
  const sceneModeLabel = uiText(coordinatorSceneModeLabel(state.resolved.template.mode));
  const showL2FollowHint = state.resolved.tiers.L2.source === "root_thread";

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
                  data-coordinator-tier={state.callerTier}
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
                      {uiText(isL1 ? "Sub-Coordinator" : "Coordinator")}
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
                <span>{uiText(isL1 ? "Sub-Coordinator Mode (L1)" : "Task Coordinator Mode")}</span>
              </div>
              <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                {state.enabled
                  ? uiText(
                      isL1
                        ? "This subtask can break down work into L2 specialists and report back to L0."
                        : "This thread focuses on planning, delegation, review, and synthesis.",
                    )
                  : uiText(
                      isL1
                        ? "Opt in to split this complex subtask into L2 child sessions."
                        : "Split complex tasks into parallel subtasks with optional per-tier models.",
                    )}
              </p>
            </div>
            <Switch
              checked={state.enabled}
              disabled={disabled}
              onCheckedChange={(checked) => handleToggleEnabled(Boolean(checked))}
              aria-label={uiText(
                isL1 ? "Enable Sub-Coordinator Mode" : "Enable Task Coordinator Mode",
              )}
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
                    className="h-7 w-auto min-w-32 max-w-48"
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
                {state.hasThreadOverrides ? (
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-3xs font-medium text-muted-foreground">
                      {uiText("Tier models")}
                    </span>
                    <Button
                      type="button"
                      size="micro"
                      variant="ghost-muted"
                      disabled={disabled}
                      data-testid="coordinator-reset-overrides"
                      onClick={handleResetOverrides}
                    >
                      <RotateCcwIcon className="size-3" aria-hidden />
                      {uiText("Reset to template")}
                    </Button>
                  </div>
                ) : null}
                <CoordinatorTierPreviewList
                  resolved={state.resolved}
                  providers={providers}
                  tiers={state.visibleTiers}
                  variant="compact-table"
                  testIdPrefix="coordinator-preview"
                  tierModelOverrides={state.tierModelOverrides}
                  selectableProviderGroups={state.selectableProviderGroups}
                  disabled={disabled}
                  onTierModelOverrideChange={handleTierModelOverrideChange}
                />
                {showL2FollowHint ? (
                  <p
                    data-testid="coordinator-l2-follow-hint"
                    className="mt-1.5 text-3xs leading-relaxed text-muted-foreground"
                  >
                    {uiText("L2 follows this thread's model. Pick another model above if needed.")}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2 text-2xs text-muted-foreground">
                <span data-testid="coordinator-scene-badge" className="truncate">
                  {uiText("Scene: {value0}", { value0: sceneModeLabel })}
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
                  isL1
                    ? "By default, this subtask runs directly. Enable to delegate focused work to L2."
                    : "When enabled, this thread plans, delegates subtasks, and synthesizes results.",
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

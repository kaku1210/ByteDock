import {
  isCoordinatorEligibleThread,
  isSubCoordinatorEligibleThread,
  ProviderInstanceId,
  type CoordinatorDelegationStrategy,
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateId,
  type CoordinatorSceneMode,
  type CoordinatorTier,
  type CoordinatorTierModelOverrides,
  type CoordinatorTierResolutionSource,
  type ModelSelection,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2DelegatedFrom,
  type ProjectId,
  type ResolvedCoordinatorConfiguration,
  type ResolvedCoordinatorTierModel,
  type ServerProvider,
  type ThreadCoordinatorMode,
} from "@t3tools/contracts";
import {
  listSelectableCoordinatorProviderModels,
  normalizeCoordinatorTierModelOverrides,
  resolveCoordinatorModels,
  resolveCoordinatorRoleTemplates,
  type CoordinatorResolutionSettingsSlice,
  type CoordinatorSelectableProviderGroup,
} from "@t3tools/shared/coordinator";
import { createModelSelection } from "@t3tools/shared/model";

export const COORDINATOR_TIERS: ReadonlyArray<CoordinatorTier> = ["L0", "L1", "L2"];

export type CoordinatorOverridableTier = "L1" | "L2";

export const COORDINATOR_TIER_OPTION_TEMPLATE = "__template__";
export const COORDINATOR_TIER_OPTION_FOLLOW = "__follow__";
const COORDINATOR_TIER_OPTION_MODEL_PREFIX = "model:";

export function encodeCoordinatorTierModelOption(
  instanceId: ProviderInstanceId,
  model: string,
): string {
  return `${COORDINATOR_TIER_OPTION_MODEL_PREFIX}${JSON.stringify([instanceId, model])}`;
}

export function decodeCoordinatorTierOption(
  value: string,
):
  | { readonly kind: "template" }
  | { readonly kind: "follow" }
  | { readonly kind: "model"; readonly selection: ModelSelection }
  | null {
  if (value === COORDINATOR_TIER_OPTION_TEMPLATE) {
    return { kind: "template" };
  }
  if (value === COORDINATOR_TIER_OPTION_FOLLOW) {
    return { kind: "follow" };
  }
  if (!value.startsWith(COORDINATOR_TIER_OPTION_MODEL_PREFIX)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value.slice(COORDINATOR_TIER_OPTION_MODEL_PREFIX.length));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0].length > 0 &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0
    ) {
      return {
        kind: "model",
        selection: createModelSelection(ProviderInstanceId.make(parsed[0]), parsed[1]),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function isCoordinatorOverridableTier(
  tier: CoordinatorTier,
): tier is CoordinatorOverridableTier {
  return tier === "L1" || tier === "L2";
}

export function resolveCoordinatorTierSelectValue(input: {
  readonly templateTierModel: ModelSelection | null;
  readonly overrideValue: ModelSelection | null | undefined;
  readonly resolved: ResolvedCoordinatorTierModel;
}): string {
  if (input.overrideValue === undefined) {
    return COORDINATOR_TIER_OPTION_TEMPLATE;
  }
  if (input.overrideValue === null) {
    return input.templateTierModel === null
      ? COORDINATOR_TIER_OPTION_TEMPLATE
      : COORDINATOR_TIER_OPTION_FOLLOW;
  }
  const active = input.resolved.modelSelection ?? input.overrideValue;
  return encodeCoordinatorTierModelOption(active.instanceId, active.model);
}

export function buildCoordinatorToggleMode(input: {
  readonly enabled: boolean;
  readonly templateId: CoordinatorRoleTemplateId;
  readonly tierModelOverrides: CoordinatorTierModelOverrides | null | undefined;
}): ThreadCoordinatorMode {
  const normalizedOverrides = normalizeCoordinatorTierModelOverrides(input.tierModelOverrides);
  return {
    enabled: input.enabled,
    templateId: input.templateId,
    ...(normalizedOverrides ? { tierModelOverrides: normalizedOverrides } : {}),
  };
}

export function buildCoordinatorTemplateSwitchMode(input: {
  readonly enabled: boolean;
  readonly templateId: CoordinatorRoleTemplateId;
}): ThreadCoordinatorMode {
  return {
    enabled: input.enabled,
    templateId: input.templateId,
  };
}

export function buildCoordinatorTierOverrideMode(input: {
  readonly enabled: boolean;
  readonly templateId: CoordinatorRoleTemplateId;
  readonly currentOverrides: CoordinatorTierModelOverrides | null | undefined;
  readonly tier: CoordinatorOverridableTier;
  readonly templateTierModel: ModelSelection | null;
  readonly nextValue: ModelSelection | null | undefined;
}): ThreadCoordinatorMode {
  const draft: { L1?: ModelSelection | null | undefined; L2?: ModelSelection | null | undefined } =
    {
      ...input.currentOverrides,
    };
  if (input.nextValue === undefined) {
    delete draft[input.tier];
  } else if (input.nextValue === null && input.templateTierModel === null) {
    delete draft[input.tier];
  } else {
    draft[input.tier] = input.nextValue;
  }
  const normalizedOverrides = normalizeCoordinatorTierModelOverrides(draft);
  return {
    enabled: input.enabled,
    templateId: input.templateId,
    ...(normalizedOverrides ? { tierModelOverrides: normalizedOverrides } : {}),
  };
}

export interface CoordinatorControlThreadSlice {
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom | null | undefined;
}

/**
 * Resolves whether a thread can show the coordinator control and which tier view it operates in:
 * - `"L0"` for persistent L0 root threads and new drafts
 * - `"L1"` for persistent direct L1 subtasks/subagents (opt-in sub-coordinator)
 * - `null` for L2 children, side chats, temporary threads, workflow steps, and remotely delegated threads
 */
export function resolveCoordinatorControlTier(input: {
  readonly routeKind: "server" | "draft";
  readonly thread: CoordinatorControlThreadSlice | null | undefined;
}): "L0" | "L1" | null {
  if (input.routeKind === "draft") {
    return "L0";
  }
  if (!input.thread) {
    return null;
  }
  const subject = {
    lineage: input.thread.lineage,
    delegatedFrom: input.thread.delegatedFrom ?? undefined,
  };
  if (isCoordinatorEligibleThread(subject)) {
    return "L0";
  }
  if (isSubCoordinatorEligibleThread(subject)) {
    return "L1";
  }
  return null;
}

export function isThreadCoordinatorControlVisible(input: {
  readonly routeKind: "server" | "draft";
  readonly thread: CoordinatorControlThreadSlice | null | undefined;
}): boolean {
  return resolveCoordinatorControlTier(input) !== null;
}

export interface CoordinatorControlState {
  readonly enabled: boolean;
  readonly callerTier: "L0" | "L1";
  readonly visibleTiers: ReadonlyArray<CoordinatorTier>;
  readonly selectedTemplateId: CoordinatorRoleTemplateId;
  readonly tierModelOverrides: CoordinatorTierModelOverrides | undefined;
  readonly hasThreadOverrides: boolean;
  readonly templates: ReadonlyArray<CoordinatorRoleTemplate>;
  readonly selectableProviderGroups: ReadonlyArray<CoordinatorSelectableProviderGroup>;
  readonly resolved: ResolvedCoordinatorConfiguration;
  readonly hasAnyFallback: boolean;
  readonly hasUnavailableTier: boolean;
}

export function resolveCoordinatorControlState(input: {
  readonly coordinatorMode: ThreadCoordinatorMode | null | undefined;
  readonly settings: CoordinatorResolutionSettingsSlice;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly rootModelSelection?: ModelSelection | null | undefined;
  readonly callerTier?: "L0" | "L1" | undefined;
  readonly inheritedRootTemplateId?: CoordinatorRoleTemplateId | null | undefined;
}): CoordinatorControlState {
  const callerTier = input.callerTier ?? "L0";
  const visibleTiers: ReadonlyArray<CoordinatorTier> =
    callerTier === "L1" ? ["L2"] : COORDINATOR_TIERS;
  const enabled = input.coordinatorMode?.enabled === true;
  const selectedTemplateId =
    input.coordinatorMode?.templateId ??
    (callerTier === "L1" && input.inheritedRootTemplateId
      ? input.inheritedRootTemplateId
      : input.settings.defaultCoordinatorRoleTemplateId);
  const tierModelOverrides = normalizeCoordinatorTierModelOverrides(
    input.coordinatorMode?.tierModelOverrides,
  );
  const templates = resolveCoordinatorRoleTemplates(input.settings);
  const selectableProviderGroups = listSelectableCoordinatorProviderModels({
    settings: input.settings,
    providers: input.providers,
    projectId: input.projectId,
  });
  const resolved = resolveCoordinatorModels({
    settings: input.settings,
    providers: input.providers,
    projectId: input.projectId,
    templateId: selectedTemplateId,
    tierModelOverrides,
    rootModelSelection: input.rootModelSelection,
    callerTier,
  });
  const hasThreadOverrides = visibleTiers.some(
    (tier) =>
      isCoordinatorOverridableTier(tier) &&
      tierModelOverrides !== undefined &&
      Object.hasOwn(tierModelOverrides, tier),
  );
  const hasAnyFallback =
    resolved.templateFallbackUsed || visibleTiers.some((tier) => resolved.tiers[tier].fallbackUsed);
  const hasUnavailableTier = visibleTiers.some(
    (tier) => resolved.tiers[tier].source === "unavailable",
  );
  return {
    enabled,
    callerTier,
    visibleTiers,
    selectedTemplateId,
    tierModelOverrides,
    hasThreadOverrides,
    templates,
    selectableProviderGroups,
    resolved,
    hasAnyFallback,
    hasUnavailableTier,
  };
}

/* oxlint-disable t3code/no-untranslated-copy -- returns interfaceCopy keys translated via uiText() at call sites */
export function formatCoordinatorModelSelectionLabel(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): string {
  if (selection === null) {
    return "Unavailable";
  }
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const providerLabel = provider?.displayName ?? selection.instanceId;
  const model = provider?.models.find(
    (candidate) =>
      candidate.slug === selection.model || candidate.aliases?.includes(selection.model),
  );
  const modelLabel = model?.name ?? selection.model;
  return `${providerLabel} · ${modelLabel}`;
}

export function formatCoordinatorModelShortName(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): string {
  if (selection === null) {
    return "Unavailable";
  }
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find(
    (candidate) =>
      candidate.slug === selection.model || candidate.aliases?.includes(selection.model),
  );
  return model?.name ?? selection.model;
}

export function coordinatorTierRoleLabel(tier: CoordinatorTier): string {
  switch (tier) {
    case "L0":
      return "L0 Coordinator";
    case "L1":
      return "L1 Task Lead";
    case "L2":
      return "L2 Worker";
  }
}

export function coordinatorTierShortRoleLabel(tier: CoordinatorTier): string {
  switch (tier) {
    case "L0":
      return "Plan & coordinate";
    case "L1":
      return "Module lead";
    case "L2":
      return "Light execution";
  }
}

export function coordinatorSceneModeLabel(mode: CoordinatorSceneMode): string {
  switch (mode) {
    case "code":
      return "Code";
    case "general":
      return "General";
  }
}

export function coordinatorTierSourceLabel(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "thread_override":
      return "This thread";
    case "template_configured":
      return "Pinned";
    case "root_thread":
      return "Follows current";
    case "dynamic_available":
      return "Follows current";
    case "fallback_available":
      return "Fallback";
    case "unavailable":
      return "Unavailable";
  }
}

export function coordinatorTierShortSourceLabel(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "thread_override":
      return "This thread";
    case "template_configured":
      return "Pinned";
    case "root_thread":
      return "Follows current";
    case "dynamic_available":
      return "Follows current";
    case "fallback_available":
      return "Fallback";
    case "unavailable":
      return "Unavailable";
  }
}

export function coordinatorDelegationStrategyLabel(
  strategy: CoordinatorDelegationStrategy,
): string {
  switch (strategy) {
    case "tiered":
      return "Tiered models (L0 / L1 / L2)";
    case "inherit_root":
      return "Inherit L0 model";
  }
}

export function coordinatorDelegationStrategyShortLabel(
  strategy: CoordinatorDelegationStrategy,
): string {
  switch (strategy) {
    case "tiered":
      return "Tiered models";
    case "inherit_root":
      return "Inherit main model";
  }
}
/* oxlint-enable t3code/no-untranslated-copy */

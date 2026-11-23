import {
  isCoordinatorEligibleThread,
  type CoordinatorDelegationStrategy,
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateId,
  type CoordinatorTier,
  type CoordinatorTierResolutionSource,
  type ModelSelection,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2DelegatedFrom,
  type ProjectId,
  type ResolvedCoordinatorConfiguration,
  type ServerProvider,
  type ThreadCoordinatorMode,
} from "@t3tools/contracts";
import {
  resolveCoordinatorModels,
  resolveCoordinatorRoleTemplates,
  type CoordinatorResolutionSettingsSlice,
} from "@t3tools/shared/coordinator";

export const COORDINATOR_TIERS: ReadonlyArray<CoordinatorTier> = ["L0", "L1", "L2"];

export interface CoordinatorControlThreadSlice {
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom | null | undefined;
}

/**
 * Coordinator mode is strictly limited to persistent L0 root threads (and new L0 draft threads).
 * Subtasks, subagents, side chats, temporary threads, and remotely delegated threads never show it.
 */
export function isThreadCoordinatorControlVisible(input: {
  readonly routeKind: "server" | "draft";
  readonly thread: CoordinatorControlThreadSlice | null | undefined;
}): boolean {
  if (input.routeKind === "draft") {
    return true;
  }
  if (!input.thread) {
    return false;
  }
  return isCoordinatorEligibleThread({
    lineage: input.thread.lineage,
    delegatedFrom: input.thread.delegatedFrom ?? undefined,
  });
}

export interface CoordinatorControlState {
  readonly enabled: boolean;
  readonly selectedTemplateId: CoordinatorRoleTemplateId;
  readonly templates: ReadonlyArray<CoordinatorRoleTemplate>;
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
}): CoordinatorControlState {
  const enabled = input.coordinatorMode?.enabled === true;
  const selectedTemplateId =
    input.coordinatorMode?.templateId ?? input.settings.defaultCoordinatorRoleTemplateId;
  const templates = resolveCoordinatorRoleTemplates(input.settings);
  const resolved = resolveCoordinatorModels({
    settings: input.settings,
    providers: input.providers,
    projectId: input.projectId,
    templateId: selectedTemplateId,
    rootModelSelection: input.rootModelSelection,
  });
  const hasAnyFallback =
    resolved.templateFallbackUsed ||
    resolved.tiers.L0.fallbackUsed ||
    resolved.tiers.L1.fallbackUsed ||
    resolved.tiers.L2.fallbackUsed;
  const hasUnavailableTier =
    resolved.tiers.L0.source === "unavailable" ||
    resolved.tiers.L1.source === "unavailable" ||
    resolved.tiers.L2.source === "unavailable";
  return {
    enabled,
    selectedTemplateId,
    templates,
    resolved,
    hasAnyFallback,
    hasUnavailableTier,
  };
}

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

export function coordinatorTierSourceLabel(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "template_configured":
      return "Template override";
    case "root_thread":
      return "Inherited from L0";
    case "dynamic_available":
      return "Dynamic";
    case "fallback_available":
      return "Fallback";
    case "unavailable":
      return "Unavailable";
  }
}

export function coordinatorTierShortSourceLabel(source: CoordinatorTierResolutionSource): string {
  switch (source) {
    case "template_configured":
      return "Pinned";
    case "root_thread":
      return "Follows current";
    case "dynamic_available":
      return "Auto";
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

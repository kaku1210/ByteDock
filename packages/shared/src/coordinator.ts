import {
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE,
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateConfig,
  type CoordinatorRoleTemplateId,
  type CoordinatorTier,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ResolvedCoordinatorConfiguration,
  type ResolvedCoordinatorTierModel,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "./model.ts";

export type CoordinatorTemplateSettingsSlice = Pick<
  ServerSettings,
  "coordinatorRoleTemplates" | "defaultCoordinatorRoleTemplateId"
>;

export type CoordinatorResolutionSettingsSlice = Pick<
  ServerSettings,
  | "coordinatorRoleTemplates"
  | "defaultCoordinatorRoleTemplateId"
  | "providerInstances"
  | "projectSettingsOverrides"
  | "providerModelPreferences"
  | "favorites"
  | "defaultModelSelection"
  | "fallbackModelSelection"
>;

export interface ResolvedCoordinatorTemplateLookup {
  readonly template: CoordinatorRoleTemplate;
  readonly requestedTemplateId: CoordinatorRoleTemplateId;
  readonly templateFallbackUsed: boolean;
  readonly templateFallbackReason: string | null;
}

export interface ResolveCoordinatorModelsInput {
  readonly settings: CoordinatorResolutionSettingsSlice;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly templateId?: CoordinatorRoleTemplateId | undefined;
  readonly rootModelSelection?: ModelSelection | null | undefined;
  readonly orchestrationCapableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}

function toRoleTemplate(
  id: CoordinatorRoleTemplateId,
  config: CoordinatorRoleTemplateConfig,
): CoordinatorRoleTemplate {
  return {
    id,
    builtIn: id === DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    name: config.name,
    description: config.description,
    tierModels: config.tierModels,
    preferDelegation: config.preferDelegation,
    delegationStrategy: config.delegationStrategy,
    instructions: config.instructions,
  };
}

/** Whether a template id exists in settings (or names the built-in default template). */
export function hasCoordinatorRoleTemplate(
  settings: Pick<ServerSettings, "coordinatorRoleTemplates">,
  templateId: CoordinatorRoleTemplateId,
): boolean {
  return (
    templateId === DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID ||
    Object.hasOwn(settings.coordinatorRoleTemplates, templateId)
  );
}

/**
 * Lists all coordinator role templates available in this environment:
 * built-in `"default"` first (incorporating any user overrides), followed by custom templates.
 */
export function resolveCoordinatorRoleTemplates(
  settings: Pick<ServerSettings, "coordinatorRoleTemplates">,
): ReadonlyArray<CoordinatorRoleTemplate> {
  const defaultOverride = Object.hasOwn(
    settings.coordinatorRoleTemplates,
    DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  )
    ? settings.coordinatorRoleTemplates[DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID]
    : undefined;
  const defaultTemplate =
    defaultOverride !== undefined
      ? toRoleTemplate(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID, defaultOverride)
      : BUILT_IN_COORDINATOR_ROLE_TEMPLATE;

  const customTemplates = Object.entries(settings.coordinatorRoleTemplates)
    .filter(([id]) => id !== DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)
    .map(([id, config]) => toRoleTemplate(id as CoordinatorRoleTemplateId, config))
    .sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0 ? nameOrder : left.id.localeCompare(right.id);
    });

  return [defaultTemplate, ...customTemplates];
}

/**
 * Resolves a coordinator role template by id (defaulting to `settings.defaultCoordinatorRoleTemplateId`).
 * If a referenced custom template was deleted, falls back gracefully to the configured default
 * or built-in default template.
 */
export function resolveCoordinatorRoleTemplate(
  settings: CoordinatorTemplateSettingsSlice,
  templateId?: CoordinatorRoleTemplateId | undefined,
): ResolvedCoordinatorTemplateLookup {
  const requestedTemplateId = templateId ?? settings.defaultCoordinatorRoleTemplateId;
  if (requestedTemplateId === DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID) {
    const override = Object.hasOwn(
      settings.coordinatorRoleTemplates,
      DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    )
      ? settings.coordinatorRoleTemplates[DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID]
      : undefined;
    return {
      template:
        override !== undefined
          ? toRoleTemplate(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID, override)
          : BUILT_IN_COORDINATOR_ROLE_TEMPLATE,
      requestedTemplateId,
      templateFallbackUsed: false,
      templateFallbackReason: null,
    };
  }

  if (Object.hasOwn(settings.coordinatorRoleTemplates, requestedTemplateId)) {
    const config = settings.coordinatorRoleTemplates[requestedTemplateId]!;
    return {
      template: toRoleTemplate(requestedTemplateId, config),
      requestedTemplateId,
      templateFallbackUsed: false,
      templateFallbackReason: null,
    };
  }

  // Fallback to defaultCoordinatorRoleTemplateId if it exists and differs; else built-in default.
  const defaultId = settings.defaultCoordinatorRoleTemplateId;
  const fallbackConfig =
    defaultId !== requestedTemplateId && Object.hasOwn(settings.coordinatorRoleTemplates, defaultId)
      ? settings.coordinatorRoleTemplates[defaultId]!
      : Object.hasOwn(settings.coordinatorRoleTemplates, DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)
        ? settings.coordinatorRoleTemplates[DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID]!
        : BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG;
  const fallbackId =
    defaultId !== requestedTemplateId && Object.hasOwn(settings.coordinatorRoleTemplates, defaultId)
      ? defaultId
      : DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID;

  return {
    template: toRoleTemplate(fallbackId, fallbackConfig),
    requestedTemplateId,
    templateFallbackUsed: true,
    templateFallbackReason: `Coordinator role template "${requestedTemplateId}" was not found; falling back to "${fallbackId}".`,
  };
}

function providerUnavailabilityReason(input: {
  readonly provider: ServerProvider;
  readonly settings: CoordinatorResolutionSettingsSlice;
  readonly projectId: ProjectId | null;
  readonly orchestrationCapableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}): string | null {
  const { provider, settings, projectId, orchestrationCapableInstanceIds } = input;
  if (
    orchestrationCapableInstanceIds !== undefined &&
    !orchestrationCapableInstanceIds.has(provider.instanceId)
  ) {
    return `Provider "${provider.instanceId}" does not support orchestrated tasks.`;
  }
  const projectOverride =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[provider.instanceId]
          ?.enabled;
  if (projectOverride === false) {
    return `Provider "${provider.instanceId}" is disabled for this project.`;
  }
  const instanceConfig = Object.hasOwn(settings.providerInstances, provider.instanceId)
    ? settings.providerInstances[provider.instanceId]
    : undefined;
  const settingsEnabled =
    projectOverride ??
    (instanceConfig !== undefined ? resolveProviderInstanceEnabled(instanceConfig) : undefined);
  if (settingsEnabled === false) {
    return `Provider "${provider.instanceId}" is disabled.`;
  }
  if (!isProviderAvailable(provider)) {
    return (
      provider.unavailableReason ?? `Provider "${provider.instanceId}" is currently unavailable.`
    );
  }
  if (settingsEnabled !== true && !provider.enabled) {
    return `Provider "${provider.instanceId}" is disabled.`;
  }
  if (!provider.installed) {
    return `Provider "${provider.instanceId}" is not installed.`;
  }
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `Provider "${provider.instanceId}" status is ${provider.status}.`;
  }
  if (provider.auth.status === "unauthenticated") {
    return `Provider "${provider.instanceId}" is not authenticated.`;
  }
  return null;
}

function sanitizeSelectionOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (options === undefined || options.length === 0) {
    return undefined;
  }
  if (descriptors === undefined || descriptors.length === 0) {
    return options;
  }
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const filtered: Array<ProviderOptionSelection> = [];
  for (const selection of options) {
    const descriptor = byId.get(selection.id);
    if (descriptor === undefined) continue;
    if (descriptor.type === "boolean") {
      if (typeof selection.value === "boolean") {
        filtered.push(selection);
      }
      continue;
    }
    if (
      typeof selection.value === "string" &&
      (descriptor.options.length === 0 ||
        descriptor.options.some((option) => option.id === selection.value))
    ) {
      filtered.push(selection);
    }
  }
  return filtered.length > 0 ? filtered : undefined;
}

function matchProviderModel(
  provider: ServerProvider,
  requestedModel: string,
): ServerProviderModel | undefined {
  const exact = provider.models.find(
    (model) => model.slug === requestedModel || model.aliases?.includes(requestedModel),
  );
  if (exact !== undefined) return exact;
  const lowered = requestedModel.toLowerCase();
  return provider.models.find(
    (model) =>
      model.slug.toLowerCase() === lowered ||
      model.aliases?.some((alias) => alias.toLowerCase() === lowered),
  );
}

const HIGH_TIER_TOKENS = new Set([
  "opus",
  "pro",
  "ultra",
  "max",
  "flagship",
  "heavy",
  "large",
  "deep",
  "reasoning",
]);

const LOW_TIER_TOKENS = new Set([
  "mini",
  "nano",
  "lite",
  "light",
  "flash",
  "haiku",
  "fast",
  "small",
  "instant",
  "spark",
  "micro",
  "tiny",
]);

const MID_TIER_TOKENS = new Set(["sonnet", "balanced", "standard", "medium", "base"]);

function tokenizeModelLabel(model: ServerProviderModel): ReadonlyArray<string> {
  return `${model.slug} ${model.name}`
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Computes a generic, vendor-agnostic tier weight purely from structural capability metadata
 * and generic capability class tokens (never matching concrete model slugs).
 * Higher values favor L0 coordination; lower values favor fast L2 execution.
 */
function genericModelTierWeight(model: ServerProviderModel): number {
  const tokens = tokenizeModelLabel(model);
  let score = 0;
  let hasHigh = false;
  let hasLow = false;
  let hasMid = false;
  for (const token of tokens) {
    if (HIGH_TIER_TOKENS.has(token)) hasHigh = true;
    if (LOW_TIER_TOKENS.has(token)) hasLow = true;
    if (MID_TIER_TOKENS.has(token)) hasMid = true;
  }
  if (hasHigh && !hasLow) score += 20;
  else if (hasLow && !hasHigh) score -= 20;
  else if (hasMid) score += 5;

  const reasoningDescriptor = model.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.type === "select" && descriptor.id === "reasoningEffort",
  );
  if (reasoningDescriptor !== undefined && reasoningDescriptor.type === "select") {
    const effortIds = new Set(reasoningDescriptor.options.map((option) => option.id.toLowerCase()));
    if (effortIds.has("xhigh") || effortIds.has("max")) {
      score += 4;
    } else if (effortIds.has("high")) {
      score += 2;
    }
  }
  return score;
}

function orderedProviderCandidates(
  provider: ServerProvider,
  settings: CoordinatorResolutionSettingsSlice,
): ReadonlyArray<ServerProviderModel> {
  if (provider.models.length === 0) return [];
  const preferences = settings.providerModelPreferences?.[provider.instanceId];
  const hiddenSet = new Set(preferences?.hiddenModels ?? []);
  const visible = provider.models.filter((model) => !hiddenSet.has(model.slug));
  const afterHidden = visible.length > 0 ? visible : provider.models;
  const nonLegacy = afterHidden.filter((model) => model.isLegacy !== true);
  const pool = nonLegacy.length > 0 ? nonLegacy : afterHidden;

  const orderIndex = new Map<string, number>();
  for (const [index, slug] of (preferences?.modelOrder ?? []).entries()) {
    orderIndex.set(slug, index);
  }
  const favoriteSet = new Set(
    (settings.favorites ?? [])
      .filter((favorite) => favorite.provider === provider.instanceId)
      .map((favorite) => favorite.model),
  );

  return pool
    .map((model, originalIndex) => ({
      model,
      originalIndex,
      customOrder: orderIndex.get(model.slug),
      isFavorite: favoriteSet.has(model.slug),
      tierWeight: genericModelTierWeight(model),
    }))
    .sort((left, right) => {
      if (left.tierWeight !== right.tierWeight) {
        return right.tierWeight - left.tierWeight;
      }
      if (left.customOrder !== undefined || right.customOrder !== undefined) {
        if (left.customOrder === undefined) return 1;
        if (right.customOrder === undefined) return -1;
        if (left.customOrder !== right.customOrder) {
          return left.customOrder - right.customOrder;
        }
      }
      if (left.isFavorite !== right.isFavorite) {
        return left.isFavorite ? -1 : 1;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map((entry) => entry.model);
}

function pickDynamicTierFromCandidates(
  provider: ServerProvider,
  candidates: ReadonlyArray<ServerProviderModel>,
  tier: CoordinatorTier,
): ModelSelection | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return createModelSelection(provider.instanceId, candidates[0]!.slug);
  }
  if (tier === "L0") {
    return createModelSelection(provider.instanceId, candidates[0]!.slug);
  }
  if (tier === "L2") {
    return createModelSelection(provider.instanceId, candidates[candidates.length - 1]!.slug);
  }
  // L1 (task lead): with 2 models, keep the stronger model if the second is explicitly lightweight;
  // with 3+ models, pick the balanced middle candidate.
  if (candidates.length === 2) {
    const secondWeight = genericModelTierWeight(candidates[1]!);
    const chosen = secondWeight < 0 ? candidates[0]! : candidates[1]!;
    return createModelSelection(provider.instanceId, chosen.slug);
  }
  const middleIndex = Math.floor((candidates.length - 1) / 2);
  return createModelSelection(provider.instanceId, candidates[middleIndex]!.slug);
}

/**
 * Dynamically resolves L0/L1/L2 model selections against live available providers and models
 * without hardcoding concrete model names.
 */
export function resolveCoordinatorModels(
  input: ResolveCoordinatorModelsInput,
): ResolvedCoordinatorConfiguration {
  const { settings, providers, projectId, rootModelSelection, orchestrationCapableInstanceIds } =
    input;
  const templateLookup = resolveCoordinatorRoleTemplate(settings, input.templateId);
  const { template } = templateLookup;

  const usableProviders: Array<ServerProvider> = [];
  const usableByInstanceId = new Map<ProviderInstanceId, ServerProvider>();
  const unavailableReasonByInstanceId = new Map<ProviderInstanceId, string>();

  for (const provider of providers) {
    const reason = providerUnavailabilityReason({
      provider,
      settings,
      projectId,
      orchestrationCapableInstanceIds,
    });
    if (reason === null) {
      usableProviders.push(provider);
      usableByInstanceId.set(provider.instanceId, provider);
    } else {
      unavailableReasonByInstanceId.set(provider.instanceId, reason);
    }
  }

  const validateSelection = (
    selection: ModelSelection,
  ):
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly reason: string } => {
    const provider = usableByInstanceId.get(selection.instanceId);
    if (provider === undefined) {
      return {
        ok: false,
        reason:
          unavailableReasonByInstanceId.get(selection.instanceId) ??
          `Provider "${selection.instanceId}" is not available.`,
      };
    }
    const matched = matchProviderModel(provider, selection.model);
    if (matched === undefined) {
      return {
        ok: false,
        reason: `Configured model "${selection.model}" is not available on provider "${selection.instanceId}".`,
      };
    }
    const sanitizedOptions = sanitizeSelectionOptions(
      selection.options,
      matched.capabilities?.optionDescriptors,
    );
    return {
      ok: true,
      selection: createModelSelection(provider.instanceId, matched.slug, sanitizedOptions),
    };
  };

  const candidatesByProvider = new Map<ProviderInstanceId, ReadonlyArray<ServerProviderModel>>();
  for (const provider of usableProviders) {
    candidatesByProvider.set(provider.instanceId, orderedProviderCandidates(provider, settings));
  }

  const pickPreferredProvider = (
    preferredInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>,
  ): ServerProvider | undefined => {
    for (const instanceId of preferredInstanceIds) {
      if (instanceId === undefined || instanceId === null) continue;
      const provider = usableByInstanceId.get(instanceId);
      if (
        provider !== undefined &&
        (candidatesByProvider.get(provider.instanceId)?.length ?? 0) > 0
      ) {
        return provider;
      }
    }
    return usableProviders.find(
      (provider) => (candidatesByProvider.get(provider.instanceId)?.length ?? 0) > 0,
    );
  };

  const configuredL0 = template.tierModels.L0;
  let resolvedL0: ResolvedCoordinatorTierModel;
  {
    const configuredCheck = configuredL0 !== null ? validateSelection(configuredL0) : null;
    if (configuredCheck?.ok) {
      resolvedL0 = {
        tier: "L0",
        modelSelection: configuredCheck.selection,
        configuredModelSelection: configuredL0,
        source: "template_configured",
        fallbackUsed: false,
        fallbackReason: null,
      };
    } else {
      const configuredFailure = configuredCheck?.ok === false ? configuredCheck.reason : null;
      const rootCheck =
        rootModelSelection !== undefined && rootModelSelection !== null
          ? validateSelection(rootModelSelection)
          : null;
      if (rootCheck?.ok) {
        resolvedL0 = {
          tier: "L0",
          modelSelection: rootCheck.selection,
          configuredModelSelection: configuredL0,
          source: configuredL0 !== null ? "fallback_available" : "root_thread",
          fallbackUsed: configuredL0 !== null,
          fallbackReason: configuredFailure,
        };
      } else {
        const defaultCheck =
          settings.defaultModelSelection !== null
            ? validateSelection(settings.defaultModelSelection)
            : null;
        const fallbackCheck =
          !defaultCheck?.ok && settings.fallbackModelSelection !== null
            ? validateSelection(settings.fallbackModelSelection)
            : null;
        const preferredProvider = pickPreferredProvider([
          rootModelSelection?.instanceId,
          settings.defaultModelSelection?.instanceId,
          settings.fallbackModelSelection?.instanceId,
        ]);
        const dynamicSelection = defaultCheck?.ok
          ? defaultCheck.selection
          : fallbackCheck?.ok
            ? fallbackCheck.selection
            : preferredProvider !== undefined
              ? pickDynamicTierFromCandidates(
                  preferredProvider,
                  candidatesByProvider.get(preferredProvider.instanceId) ?? [],
                  "L0",
                )
              : null;
        resolvedL0 =
          dynamicSelection !== null
            ? {
                tier: "L0",
                modelSelection: dynamicSelection,
                configuredModelSelection: configuredL0,
                source: configuredL0 !== null ? "fallback_available" : "dynamic_available",
                fallbackUsed: configuredL0 !== null,
                fallbackReason: configuredFailure,
              }
            : {
                tier: "L0",
                modelSelection: null,
                configuredModelSelection: configuredL0,
                source: "unavailable",
                fallbackUsed: configuredL0 !== null,
                fallbackReason:
                  configuredFailure ?? "No enabled and available provider models found.",
              };
      }
    }
  }

  const resolveChildTier = (tier: "L1" | "L2"): ResolvedCoordinatorTierModel => {
    const configured = template.tierModels[tier];
    const configuredCheck = configured !== null ? validateSelection(configured) : null;
    if (configuredCheck?.ok) {
      return {
        tier,
        modelSelection: configuredCheck.selection,
        configuredModelSelection: configured,
        source: "template_configured",
        fallbackUsed: false,
        fallbackReason: null,
      };
    }
    const configuredFailure = configuredCheck?.ok === false ? configuredCheck.reason : null;

    if (template.delegationStrategy === "inherit_root") {
      if (resolvedL0.modelSelection !== null) {
        return {
          tier,
          modelSelection: resolvedL0.modelSelection,
          configuredModelSelection: configured,
          source: configured !== null ? "fallback_available" : "root_thread",
          fallbackUsed: configured !== null,
          fallbackReason: configuredFailure,
        };
      }
      return {
        tier,
        modelSelection: null,
        configuredModelSelection: configured,
        source: "unavailable",
        fallbackUsed: configured !== null,
        fallbackReason: configuredFailure ?? "No enabled and available provider models found.",
      };
    }

    const preferredProvider = pickPreferredProvider([
      resolvedL0.modelSelection?.instanceId,
      rootModelSelection?.instanceId,
      settings.defaultModelSelection?.instanceId,
      settings.fallbackModelSelection?.instanceId,
    ]);
    const dynamicSelection =
      preferredProvider !== undefined
        ? pickDynamicTierFromCandidates(
            preferredProvider,
            candidatesByProvider.get(preferredProvider.instanceId) ?? [],
            tier,
          )
        : null;

    if (dynamicSelection !== null) {
      return {
        tier,
        modelSelection: dynamicSelection,
        configuredModelSelection: configured,
        source: configured !== null ? "fallback_available" : "dynamic_available",
        fallbackUsed: configured !== null,
        fallbackReason: configuredFailure,
      };
    }

    return {
      tier,
      modelSelection: null,
      configuredModelSelection: configured,
      source: "unavailable",
      fallbackUsed: configured !== null,
      fallbackReason: configuredFailure ?? "No enabled and available provider models found.",
    };
  };

  return {
    template,
    requestedTemplateId: templateLookup.requestedTemplateId,
    templateFallbackUsed: templateLookup.templateFallbackUsed,
    templateFallbackReason: templateLookup.templateFallbackReason,
    tiers: {
      L0: resolvedL0,
      L1: resolveChildTier("L1"),
      L2: resolveChildTier("L2"),
    },
  };
}

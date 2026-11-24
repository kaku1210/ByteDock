import {
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE_BY_ID,
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG,
  BUILT_IN_COORDINATOR_ROLE_TEMPLATES,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  isBuiltInCoordinatorRoleTemplateId,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateConfig,
  type CoordinatorRoleTemplateId,
  type CoordinatorTier,
  type CoordinatorTierModelOverrides,
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
  readonly tierModelOverrides?: CoordinatorTierModelOverrides | null | undefined;
  readonly rootModelSelection?: ModelSelection | null | undefined;
  readonly callerTier?: "L0" | "L1" | undefined;
  readonly orchestrationCapableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}

export interface CoordinatorSelectableProviderGroup {
  readonly provider: ServerProvider;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

function toRoleTemplate(
  id: CoordinatorRoleTemplateId,
  config: CoordinatorRoleTemplateConfig,
): CoordinatorRoleTemplate {
  return {
    id,
    builtIn: isBuiltInCoordinatorRoleTemplateId(id),
    name: config.name,
    description: config.description,
    mode: config.mode,
    tierModels: config.tierModels,
    preferDelegation: config.preferDelegation,
    delegationStrategy: config.delegationStrategy,
    instructions: config.instructions,
  };
}

/** Whether a template id exists in settings (or names a built-in template). */
export function hasCoordinatorRoleTemplate(
  settings: Pick<ServerSettings, "coordinatorRoleTemplates">,
  templateId: CoordinatorRoleTemplateId,
): boolean {
  return (
    isBuiltInCoordinatorRoleTemplateId(templateId) ||
    Object.hasOwn(settings.coordinatorRoleTemplates, templateId)
  );
}

/**
 * Lists all coordinator role templates available in this environment:
 * built-in templates first (incorporating any user overrides), followed by custom templates.
 */
export function resolveCoordinatorRoleTemplates(
  settings: Pick<ServerSettings, "coordinatorRoleTemplates">,
): ReadonlyArray<CoordinatorRoleTemplate> {
  const builtInTemplates = BUILT_IN_COORDINATOR_ROLE_TEMPLATES.map((builtIn) => {
    const override = Object.hasOwn(settings.coordinatorRoleTemplates, builtIn.id)
      ? settings.coordinatorRoleTemplates[builtIn.id]
      : undefined;
    return override !== undefined ? toRoleTemplate(builtIn.id, override) : builtIn;
  });

  const customTemplates = Object.entries(settings.coordinatorRoleTemplates)
    .filter(([id]) => !isBuiltInCoordinatorRoleTemplateId(id))
    .map(([id, config]) => toRoleTemplate(id as CoordinatorRoleTemplateId, config))
    .sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name);
      return nameOrder !== 0 ? nameOrder : left.id.localeCompare(right.id);
    });

  return [...builtInTemplates, ...customTemplates];
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
  const builtInMatch = BUILT_IN_COORDINATOR_ROLE_TEMPLATE_BY_ID.get(requestedTemplateId);
  if (builtInMatch !== undefined) {
    const override = Object.hasOwn(settings.coordinatorRoleTemplates, requestedTemplateId)
      ? settings.coordinatorRoleTemplates[requestedTemplateId]
      : undefined;
    return {
      template:
        override !== undefined ? toRoleTemplate(requestedTemplateId, override) : builtInMatch,
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
  const canUseConfiguredDefault =
    defaultId !== requestedTemplateId && hasCoordinatorRoleTemplate(settings, defaultId);
  const fallbackId = canUseConfiguredDefault ? defaultId : DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID;
  const fallbackBuiltIn = BUILT_IN_COORDINATOR_ROLE_TEMPLATE_BY_ID.get(fallbackId);
  const fallbackConfig = Object.hasOwn(settings.coordinatorRoleTemplates, fallbackId)
    ? settings.coordinatorRoleTemplates[fallbackId]!
    : (fallbackBuiltIn ?? BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG);

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

function pickFirstVisibleProviderModel(
  provider: ServerProvider,
  settings: CoordinatorResolutionSettingsSlice,
): ModelSelection | null {
  if (provider.models.length === 0) return null;
  const preferences = settings.providerModelPreferences?.[provider.instanceId];
  const hiddenSet = new Set(preferences?.hiddenModels ?? []);
  const visible = provider.models.filter((model) => !hiddenSet.has(model.slug));
  const afterHidden = visible.length > 0 ? visible : provider.models;
  const nonLegacy = afterHidden.filter((model) => model.isLegacy !== true);
  const pool = nonLegacy.length > 0 ? nonLegacy : afterHidden;
  const first = pool[0];
  return first !== undefined ? createModelSelection(provider.instanceId, first.slug) : null;
}

/** Strips unset keys so empty override objects are omitted from persisted payloads. */
export function normalizeCoordinatorTierModelOverrides(
  overrides: CoordinatorTierModelOverrides | null | undefined,
): CoordinatorTierModelOverrides | undefined {
  if (!overrides) return undefined;
  const next: { L1?: ModelSelection | null; L2?: ModelSelection | null } = {};
  if (Object.hasOwn(overrides, "L1") && overrides.L1 !== undefined) {
    next.L1 = overrides.L1;
  }
  if (Object.hasOwn(overrides, "L2") && overrides.L2 !== undefined) {
    next.L2 = overrides.L2;
  }
  return next.L1 !== undefined || next.L2 !== undefined ? next : undefined;
}

/** Lists live available providers and their visible models for inline coordinator tier pickers. */
export function listSelectableCoordinatorProviderModels(input: {
  readonly settings: CoordinatorResolutionSettingsSlice;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly orchestrationCapableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}): ReadonlyArray<CoordinatorSelectableProviderGroup> {
  const groups: Array<CoordinatorSelectableProviderGroup> = [];
  for (const provider of input.providers) {
    const reason = providerUnavailabilityReason({
      provider,
      settings: input.settings,
      projectId: input.projectId,
      orchestrationCapableInstanceIds: input.orchestrationCapableInstanceIds,
    });
    if (reason !== null || provider.models.length === 0) {
      continue;
    }
    const preferences = input.settings.providerModelPreferences?.[provider.instanceId];
    const hiddenSet = new Set(preferences?.hiddenModels ?? []);
    const visible = provider.models.filter((model) => !hiddenSet.has(model.slug));
    const afterHidden = visible.length > 0 ? visible : provider.models;
    const nonLegacy = afterHidden.filter((model) => model.isLegacy !== true);
    const models = nonLegacy.length > 0 ? nonLegacy : afterHidden;
    if (models.length > 0) {
      groups.push({ provider, models });
    }
  }
  return groups;
}

/**
 * Deterministically resolves L0/L1/L2 model selections against live available providers:
 * thread overrides take precedence over template pins, and unpinned tiers follow `rootModelSelection`.
 */
export function resolveCoordinatorModels(
  input: ResolveCoordinatorModelsInput,
): ResolvedCoordinatorConfiguration {
  const {
    settings,
    providers,
    projectId,
    tierModelOverrides,
    rootModelSelection,
    orchestrationCapableInstanceIds,
    callerTier = "L0",
  } = input;
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

  const resolveBaselineSelection = ():
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly reason: string } => {
    if (rootModelSelection !== undefined && rootModelSelection !== null) {
      return validateSelection(rootModelSelection);
    }
    if (settings.defaultModelSelection !== null) {
      const defaultCheck = validateSelection(settings.defaultModelSelection);
      if (defaultCheck.ok) {
        return defaultCheck;
      }
    }
    if (settings.fallbackModelSelection !== null) {
      const fallbackCheck = validateSelection(settings.fallbackModelSelection);
      if (fallbackCheck.ok) {
        return fallbackCheck;
      }
    }
    for (const provider of usableProviders) {
      const firstModel = pickFirstVisibleProviderModel(provider, settings);
      if (firstModel !== null) {
        return { ok: true, selection: firstModel };
      }
    }
    return {
      ok: false,
      reason: "No enabled and available provider models found.",
    };
  };

  const baseline = resolveBaselineSelection();

  const resolveBaselineTier = (tier: CoordinatorTier): ResolvedCoordinatorTierModel =>
    baseline.ok
      ? {
          tier,
          modelSelection: baseline.selection,
          configuredModelSelection: null,
          source: "root_thread",
          fallbackUsed: false,
          fallbackReason: null,
        }
      : {
          tier,
          modelSelection: null,
          configuredModelSelection: null,
          source: "unavailable",
          fallbackUsed: false,
          fallbackReason: baseline.reason,
        };

  const resolveTier = (tier: CoordinatorTier): ResolvedCoordinatorTierModel => {
    // When running as an L1 sub-coordinator, L1 represents the current running B thread itself.
    if (callerTier === "L1" && tier === "L1") {
      return resolveBaselineTier(tier);
    }

    if (
      (tier === "L1" || tier === "L2") &&
      tierModelOverrides !== undefined &&
      tierModelOverrides !== null &&
      Object.hasOwn(tierModelOverrides, tier)
    ) {
      const override = tierModelOverrides[tier];
      if (override !== undefined) {
        if (override === null) {
          return resolveBaselineTier(tier);
        }
        const overrideCheck = validateSelection(override);
        if (overrideCheck.ok) {
          return {
            tier,
            modelSelection: overrideCheck.selection,
            configuredModelSelection: override,
            source: "thread_override",
            fallbackUsed: false,
            fallbackReason: null,
          };
        }
        return {
          tier,
          modelSelection: null,
          configuredModelSelection: override,
          source: "unavailable",
          fallbackUsed: false,
          fallbackReason: overrideCheck.reason,
        };
      }
    }

    const configured = template.tierModels[tier];
    if (configured !== null) {
      const configuredCheck = validateSelection(configured);
      if (configuredCheck.ok) {
        return {
          tier,
          modelSelection: configuredCheck.selection,
          configuredModelSelection: configured,
          source: "template_configured",
          fallbackUsed: false,
          fallbackReason: null,
        };
      }
      return {
        tier,
        modelSelection: null,
        configuredModelSelection: configured,
        source: "unavailable",
        fallbackUsed: false,
        fallbackReason: configuredCheck.reason,
      };
    }

    return resolveBaselineTier(tier);
  };

  return {
    template,
    requestedTemplateId: templateLookup.requestedTemplateId,
    templateFallbackUsed: templateLookup.templateFallbackUsed,
    templateFallbackReason: templateLookup.templateFallbackReason,
    tiers: {
      L0: resolveTier("L0"),
      L1: resolveTier("L1"),
      L2: resolveTier("L2"),
    },
  };
}

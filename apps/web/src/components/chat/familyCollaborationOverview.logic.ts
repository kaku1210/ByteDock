import {
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  type CoordinatorRoleTemplate,
  type CoordinatorRoleTemplateId,
  type CoordinatorSceneMode,
  type CoordinatorTierResolutionSource,
  type FamilyCollaborationNode,
  type FamilyCollaborationOverview,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ThreadCoordinatorMode,
} from "@t3tools/contracts";
import {
  normalizeCoordinatorTierModelOverrides,
  resolveCoordinatorModels,
  resolveCoordinatorRoleTemplates,
  type CoordinatorResolutionSettingsSlice,
} from "@t3tools/shared/coordinator";

import {
  buildCoordinatorToggleMode,
  coordinatorSceneModeLabel,
  coordinatorTierShortSourceLabel,
  formatCoordinatorModelShortName,
  type CoordinatorOverridableTier,
} from "./coordinatorModeControl.logic";

export interface OverviewNodeCoordinatorTierSummary {
  readonly tier: CoordinatorOverridableTier;
  readonly modelSelection: ModelSelection | null;
  readonly modelLabel: string;
  readonly source: CoordinatorTierResolutionSource;
  readonly sourceLabel: string;
  readonly isThreadOverride: boolean;
  readonly reason: string | null;
}

export interface OverviewNodeCoordinatorView {
  readonly tier: "L0" | "L1";
  readonly roleLabel: string;
  readonly templateId: CoordinatorRoleTemplateId;
  readonly templateName: string;
  readonly sceneMode: CoordinatorSceneMode;
  readonly sceneModeLabel: string;
  readonly hasThreadOverrides: boolean;
  readonly overrideSummary: string | null;
  readonly resolvedTiers: ReadonlyArray<OverviewNodeCoordinatorTierSummary>;
}

/**
 * Only non-archived L1 subtask nodes can be promoted to or demoted from Sub-Coordinator
 * directly in the Collaboration Tree Overview.
 */
export function canToggleNodeSubCoordinator(
  node: Pick<FamilyCollaborationNode, "depth" | "nodeKind" | "isArchived">,
): boolean {
  return node.depth === 1 && node.nodeKind === "subtask" && !node.isArchived;
}

/**
 * Builds the next `ThreadCoordinatorMode` payload for toggling an L1 node's Sub-Coordinator
 * state from the overview tree, inheriting L0's template on first opt-in and preserving
 * any existing template selection and per-thread tier overrides.
 */
export function buildNodeSubCoordinatorToggleMode(input: {
  readonly node: Pick<FamilyCollaborationNode, "coordinatorMode">;
  readonly rootCoordinatorMode: ThreadCoordinatorMode | null | undefined;
  readonly defaultTemplateId?: CoordinatorRoleTemplateId | undefined;
}): ThreadCoordinatorMode {
  const currentlyEnabled = input.node.coordinatorMode?.enabled === true;
  const templateId =
    input.node.coordinatorMode?.templateId ??
    input.rootCoordinatorMode?.templateId ??
    input.defaultTemplateId ??
    DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID;
  return buildCoordinatorToggleMode({
    enabled: !currentlyEnabled,
    templateId,
    tierModelOverrides: input.node.coordinatorMode?.tierModelOverrides,
  });
}

function findCoordinatorTemplate(
  templateId: CoordinatorRoleTemplateId,
  settings: CoordinatorResolutionSettingsSlice | null | undefined,
): CoordinatorRoleTemplate | null {
  const templates = resolveCoordinatorRoleTemplates(settings ?? { coordinatorRoleTemplates: {} });
  return templates.find((candidate) => candidate.id === templateId) ?? null;
}

function formatTemplateDisplayName(
  template: CoordinatorRoleTemplate | null,
  fallbackTemplateId: CoordinatorRoleTemplateId,
  uiText: (source: string) => string,
): string {
  if (template === null) {
    return fallbackTemplateId;
  }
  return template.builtIn ? uiText(template.name) : template.name;
}

/**
 * Resolves display metadata for an L0 Coordinator or L1 Sub-Coordinator node in the
 * Collaboration Tree Overview, including localized template name, scene mode, and tier routing.
 */
export function resolveOverviewNodeCoordinatorView(input: {
  readonly node: Pick<FamilyCollaborationNode, "depth" | "coordinatorMode" | "modelSelection">;
  readonly projectId: ProjectId | null;
  readonly settings: CoordinatorResolutionSettingsSlice | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly uiText: (source: string) => string;
}): OverviewNodeCoordinatorView | null {
  const { node, projectId, settings, providers, uiText } = input;
  if ((node.depth !== 0 && node.depth !== 1) || node.coordinatorMode?.enabled !== true) {
    return null;
  }

  const tier: "L0" | "L1" = node.depth === 0 ? "L0" : "L1";
  const visibleTiers: ReadonlyArray<CoordinatorOverridableTier> =
    tier === "L0" ? ["L1", "L2"] : ["L2"];
  const templateId = node.coordinatorMode.templateId;
  const matchedTemplate = findCoordinatorTemplate(templateId, settings);
  const templateName = formatTemplateDisplayName(matchedTemplate, templateId, uiText);
  const sceneMode: CoordinatorSceneMode = matchedTemplate?.mode ?? "code";
  const sceneModeLabel = uiText(coordinatorSceneModeLabel(sceneMode));
  const normalizedOverrides = normalizeCoordinatorTierModelOverrides(
    node.coordinatorMode.tierModelOverrides,
  );

  const fullResolution =
    settings != null && providers.length > 0
      ? resolveCoordinatorModels({
          settings,
          providers,
          projectId,
          templateId,
          tierModelOverrides: normalizedOverrides,
          rootModelSelection: node.modelSelection,
          callerTier: tier,
        })
      : null;

  const resolvedTiers: Array<OverviewNodeCoordinatorTierSummary> = visibleTiers.map(
    (targetTier) => {
      const hasOverrideKey =
        normalizedOverrides !== undefined && Object.hasOwn(normalizedOverrides, targetTier);
      const overrideValue = hasOverrideKey ? normalizedOverrides[targetTier] : undefined;

      if (fullResolution !== null) {
        const resolvedTier = fullResolution.tiers[targetTier];
        const modelLabel =
          resolvedTier.source === "unavailable"
            ? uiText("Unavailable")
            : resolvedTier.source === "root_thread" || resolvedTier.source === "dynamic_available"
              ? uiText("Follows current")
              : formatCoordinatorModelShortName(resolvedTier.modelSelection, providers);
        const sourceLabel =
          hasOverrideKey && resolvedTier.source === "root_thread"
            ? uiText("This thread")
            : uiText(coordinatorTierShortSourceLabel(resolvedTier.source));
        return {
          tier: targetTier,
          modelSelection: resolvedTier.modelSelection,
          modelLabel,
          source: resolvedTier.source,
          sourceLabel,
          isThreadOverride: hasOverrideKey,
          reason: resolvedTier.fallbackReason,
        };
      }

      if (hasOverrideKey) {
        if (overrideValue === null) {
          return {
            tier: targetTier,
            modelSelection: node.modelSelection,
            modelLabel: uiText("Follows current"),
            source: "root_thread",
            sourceLabel: uiText("This thread"),
            isThreadOverride: true,
            reason: null,
          };
        }
        if (overrideValue !== undefined) {
          return {
            tier: targetTier,
            modelSelection: overrideValue,
            modelLabel: formatCoordinatorModelShortName(overrideValue, providers),
            source: "thread_override",
            sourceLabel: uiText("This thread"),
            isThreadOverride: true,
            reason: null,
          };
        }
      }

      const templateModel = matchedTemplate?.tierModels[targetTier] ?? null;
      if (templateModel !== null) {
        return {
          tier: targetTier,
          modelSelection: templateModel,
          modelLabel: formatCoordinatorModelShortName(templateModel, providers),
          source: "template_configured",
          sourceLabel: uiText("Pinned"),
          isThreadOverride: false,
          reason: null,
        };
      }

      return {
        tier: targetTier,
        modelSelection: node.modelSelection,
        modelLabel: uiText("Follows current"),
        source: "root_thread",
        sourceLabel: uiText("Follows current"),
        isThreadOverride: false,
        reason: null,
      };
    },
  );

  const overrideParts = resolvedTiers
    .filter((entry) => entry.isThreadOverride)
    .map((entry) => `${entry.tier}: ${entry.modelLabel}`);

  return {
    tier,
    roleLabel: tier === "L0" ? uiText("Coordinator") : uiText("Sub-Coordinator"),
    templateId,
    templateName,
    sceneMode,
    sceneModeLabel,
    hasThreadOverrides: overrideParts.length > 0,
    overrideSummary: overrideParts.length > 0 ? overrideParts.join(" · ") : null,
    resolvedTiers,
  };
}

/**
 * Returns true when the family root node is actively coordinating with a `general` scene template.
 */
export function isOverviewGeneralScene(input: {
  readonly overview: Pick<FamilyCollaborationOverview, "nodes">;
  readonly settings: CoordinatorResolutionSettingsSlice | null | undefined;
}): boolean {
  const rootNode = input.overview.nodes.find((node) => node.depth === 0);
  if (!rootNode?.coordinatorMode?.enabled) {
    return false;
  }
  const template = findCoordinatorTemplate(rootNode.coordinatorMode.templateId, input.settings);
  return template?.mode === "general";
}

import {
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG,
  COORDINATOR_ROLE_TEMPLATE_MAX_COUNT,
  CoordinatorRoleTemplateConfig,
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
  type CoordinatorDelegationStrategy,
  type CoordinatorRoleTemplate,
  type CoordinatorTierModelSelections,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import type { CoordinatorResolutionSettingsSlice } from "@t3tools/shared/coordinator";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTemplateId = Schema.decodeUnknownOption(CoordinatorRoleTemplateId);
const decodeTemplateConfig = Schema.decodeUnknownOption(CoordinatorRoleTemplateConfig);

export interface CoordinatorRoleTemplateDraft {
  readonly mode: "create" | "edit";
  readonly id: string;
  readonly idManuallyEdited: boolean;
  readonly name: string;
  readonly description: string;
  readonly preferDelegation: boolean;
  readonly delegationStrategy: CoordinatorDelegationStrategy;
  readonly instructions: string;
  readonly tierModels: CoordinatorTierModelSelections;
}

export function isBuiltInTemplateCustomized(
  settings: Pick<ServerSettings, "coordinatorRoleTemplates">,
): boolean {
  return Object.hasOwn(settings.coordinatorRoleTemplates, DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID);
}

export function canCreateCoordinatorRoleTemplate(
  settings: Pick<ServerSettings, "coordinatorRoleTemplates">,
): boolean {
  return (
    Object.keys(settings.coordinatorRoleTemplates).length < COORDINATOR_ROLE_TEMPLATE_MAX_COUNT
  );
}

/** Derives a clean, unique template id slug from a human-readable template name. */
export function slugifyCoordinatorTemplateId(
  name: string,
  existingIds: ReadonlySet<string>,
): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const root = base.length > 0 ? base : "custom-template";
  if (!existingIds.has(root) && root !== DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID) {
    return root;
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${root}-${suffix}`;
    if (!existingIds.has(candidate) && candidate !== DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID) {
      return candidate;
    }
  }
  return `${root}-${Date.now().toString(36).slice(-4)}`;
}

export function createEmptyCoordinatorTemplateDraft(
  existingIds: ReadonlySet<string>,
): CoordinatorRoleTemplateDraft {
  return {
    mode: "create",
    id: slugifyCoordinatorTemplateId("", existingIds),
    idManuallyEdited: false,
    name: "",
    description: "",
    preferDelegation: BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG.preferDelegation,
    delegationStrategy: BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG.delegationStrategy,
    instructions: "",
    tierModels: { ...DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS },
  };
}

export function createEditCoordinatorTemplateDraft(
  template: CoordinatorRoleTemplate,
): CoordinatorRoleTemplateDraft {
  return {
    mode: "edit",
    id: template.id,
    idManuallyEdited: true,
    name: template.name,
    description: template.description,
    preferDelegation: template.preferDelegation,
    delegationStrategy: template.delegationStrategy,
    instructions: template.instructions,
    tierModels: {
      L0: template.tierModels.L0,
      L1: template.tierModels.L1,
      L2: template.tierModels.L2,
    },
  };
}

export type CoordinatorTemplateValidationResult =
  | {
      readonly ok: true;
      readonly id: CoordinatorRoleTemplateId;
      readonly config: CoordinatorRoleTemplateConfig;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export function validateCoordinatorTemplateDraft(
  draft: CoordinatorRoleTemplateDraft,
  existingIds: ReadonlySet<string>,
): CoordinatorTemplateValidationResult {
  const trimmedName = draft.name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, error: "Template name is required." };
  }
  const decodedId = decodeTemplateId(draft.id.trim());
  if (Option.isNone(decodedId)) {
    return { ok: false, error: "Template ID must be a non-empty identifier (max 64 characters)." };
  }
  const id = decodedId.value;
  if (draft.mode === "create") {
    if (id === DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID || existingIds.has(id)) {
      return { ok: false, error: `Template ID "${id}" already exists.` };
    }
  }
  const decodedConfig = decodeTemplateConfig({
    name: trimmedName,
    description: draft.description.trim(),
    tierModels: draft.tierModels,
    preferDelegation: draft.preferDelegation,
    delegationStrategy: draft.delegationStrategy,
    instructions: draft.instructions.trim(),
  });
  if (Option.isNone(decodedConfig)) {
    return {
      ok: false,
      error: "Check template field lengths (name <= 80, description <= 240, instructions <= 2000).",
    };
  }
  return {
    ok: true,
    id,
    config: decodedConfig.value,
  };
}

/**
 * Picks a fallback initial model selection from currently available live providers when
 * a user switches a tier from "Auto (Dynamic)" to an explicit override. Never hardcodes model names.
 */
export function pickInitialExplicitTierModel(
  providers: ReadonlyArray<ServerProvider>,
  preferred: ModelSelection | null | undefined,
): ModelSelection | null {
  if (preferred !== null && preferred !== undefined) {
    return preferred;
  }
  const candidateProvider =
    providers.find((provider) => provider.enabled && provider.models.length > 0) ??
    providers.find((provider) => provider.models.length > 0);
  const firstModel = candidateProvider?.models[0];
  if (!candidateProvider || !firstModel) {
    return null;
  }
  return createModelSelection(candidateProvider.instanceId, firstModel.slug);
}

/**
 * Builds an ephemeral settings slice containing the unsaved template draft so the editor dialog
 * can render a live dynamic tier resolution preview before saving.
 */
export function buildDraftCoordinatorPreviewSettings(
  settings: CoordinatorResolutionSettingsSlice,
  draft: CoordinatorRoleTemplateDraft,
): {
  readonly settings: CoordinatorResolutionSettingsSlice;
  readonly templateId: CoordinatorRoleTemplateId;
} {
  const decodedId = decodeTemplateId(draft.id.trim());
  const previewId = Option.isSome(decodedId)
    ? decodedId.value
    : CoordinatorRoleTemplateId.make("__draft_preview__");
  const config: CoordinatorRoleTemplateConfig = {
    name: draft.name.trim() || "Untitled template",
    description: draft.description.trim(),
    tierModels: draft.tierModels,
    preferDelegation: draft.preferDelegation,
    delegationStrategy: draft.delegationStrategy,
    instructions: draft.instructions.trim(),
  };
  return {
    templateId: previewId,
    settings: {
      ...settings,
      coordinatorRoleTemplates: {
        ...settings.coordinatorRoleTemplates,
        [previewId]: config,
      },
    },
  };
}

export function summarizeTierOverrides(tierModels: CoordinatorTierModelSelections): string {
  const configuredTiers: Array<string> = [];
  if (tierModels.L0 !== null) configuredTiers.push("L0");
  if (tierModels.L1 !== null) configuredTiers.push("L1");
  if (tierModels.L2 !== null) configuredTiers.push("L2");
  if (configuredTiers.length === 0) {
    return "All tiers dynamic";
  }
  return `Custom ${configuredTiers.join(" / ")}`;
}

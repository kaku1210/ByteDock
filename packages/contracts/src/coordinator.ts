import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const COORDINATOR_ROLE_TEMPLATE_ID_MAX_LENGTH = 64;
const COORDINATOR_ROLE_TEMPLATE_NAME_MAX_LENGTH = 80;
const COORDINATOR_ROLE_TEMPLATE_DESCRIPTION_MAX_LENGTH = 240;
const COORDINATOR_ROLE_TEMPLATE_INSTRUCTIONS_MAX_LENGTH = 2000;
export const COORDINATOR_ROLE_TEMPLATE_MAX_COUNT = 32;

export const CoordinatorRoleTemplateId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COORDINATOR_ROLE_TEMPLATE_ID_MAX_LENGTH),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
).pipe(Schema.brand("CoordinatorRoleTemplateId"));
export type CoordinatorRoleTemplateId = typeof CoordinatorRoleTemplateId.Type;

export const DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID: CoordinatorRoleTemplateId =
  CoordinatorRoleTemplateId.make("default");

export const GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID: CoordinatorRoleTemplateId =
  CoordinatorRoleTemplateId.make("general-batch");

export const CoordinatorTier = Schema.Literals(["L0", "L1", "L2"]);
export type CoordinatorTier = typeof CoordinatorTier.Type;

export const CoordinatorSceneMode = Schema.Literals(["code", "general"]);
export type CoordinatorSceneMode = typeof CoordinatorSceneMode.Type;

export const CoordinatorDelegationStrategy = Schema.Literals(["tiered", "inherit_root"]);
export type CoordinatorDelegationStrategy = typeof CoordinatorDelegationStrategy.Type;

export const CoordinatorTierModelSelections = Schema.Struct({
  L0: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  L1: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  L2: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type CoordinatorTierModelSelections = typeof CoordinatorTierModelSelections.Type;

export const DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS: CoordinatorTierModelSelections = {
  L0: null,
  L1: null,
  L2: null,
};

/**
 * Persisted coordinator role template configuration stored under `ServerSettings.coordinatorRoleTemplates`.
 * All tier models default to `null` so runtime resolution follows the current coordinating thread
 * unless a tier is explicitly pinned.
 */
export const CoordinatorRoleTemplateConfig = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(COORDINATOR_ROLE_TEMPLATE_NAME_MAX_LENGTH)),
  description: TrimmedString.check(
    Schema.isMaxLength(COORDINATOR_ROLE_TEMPLATE_DESCRIPTION_MAX_LENGTH),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Scene mode controlling whether instructions include code/worktree guidance or general deliverable guidance. */
  mode: CoordinatorSceneMode.pipe(Schema.withDecodingDefault(Effect.succeed("code" as const))),
  tierModels: CoordinatorTierModelSelections.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS)),
  ),
  /** Constrain the coordinator to focus on decomposition, delegation, review, and synthesis. */
  preferDelegation: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Legacy strategy field kept for backward compatibility with persisted settings. */
  delegationStrategy: CoordinatorDelegationStrategy.pipe(
    Schema.withDecodingDefault(Effect.succeed("tiered" as const)),
  ),
  /** Optional extra coordinator guidance appended when this template is active. */
  instructions: TrimmedString.check(
    Schema.isMaxLength(COORDINATOR_ROLE_TEMPLATE_INSTRUCTIONS_MAX_LENGTH),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type CoordinatorRoleTemplateConfig = typeof CoordinatorRoleTemplateConfig.Type;

export const CoordinatorRoleTemplate = Schema.Struct({
  id: CoordinatorRoleTemplateId,
  builtIn: Schema.Boolean,
  ...CoordinatorRoleTemplateConfig.fields,
});
export type CoordinatorRoleTemplate = typeof CoordinatorRoleTemplate.Type;

export const CoordinatorRoleTemplatesMap = Schema.Record(
  CoordinatorRoleTemplateId,
  CoordinatorRoleTemplateConfig,
).check(
  Schema.makeFilter(
    (templates) =>
      Object.keys(templates).length <= COORDINATOR_ROLE_TEMPLATE_MAX_COUNT ||
      `At most ${COORDINATOR_ROLE_TEMPLATE_MAX_COUNT} coordinator role templates are allowed.`,
  ),
);
export type CoordinatorRoleTemplatesMap = typeof CoordinatorRoleTemplatesMap.Type;

export const BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG: CoordinatorRoleTemplateConfig = {
  name: "Default Coordinator",
  description:
    "Coordinate engineering workflows: plan, delegate implementation to L1/L2, review outputs, and synthesize results.",
  mode: "code",
  tierModels: DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
  preferDelegation: true,
  delegationStrategy: "tiered",
  instructions: "",
};

export const BUILT_IN_COORDINATOR_ROLE_TEMPLATE: CoordinatorRoleTemplate = {
  id: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  builtIn: true,
  ...BUILT_IN_COORDINATOR_ROLE_TEMPLATE_CONFIG,
};

const BUILT_IN_GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_CONFIG: CoordinatorRoleTemplateConfig = {
  name: "General Batch Collaboration",
  description:
    "Coordinate multi-item content, research, or batch production workflows without code/worktree assumptions.",
  mode: "general",
  tierModels: DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
  preferDelegation: true,
  delegationStrategy: "tiered",
  instructions: "",
};

export const BUILT_IN_GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE: CoordinatorRoleTemplate = {
  id: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  builtIn: true,
  ...BUILT_IN_GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_CONFIG,
};

export const BUILT_IN_COORDINATOR_ROLE_TEMPLATES: ReadonlyArray<CoordinatorRoleTemplate> = [
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE,
  BUILT_IN_GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE,
];

export const BUILT_IN_COORDINATOR_ROLE_TEMPLATE_BY_ID: ReadonlyMap<
  CoordinatorRoleTemplateId,
  CoordinatorRoleTemplate
> = new Map(BUILT_IN_COORDINATOR_ROLE_TEMPLATES.map((template) => [template.id, template]));

export function isBuiltInCoordinatorRoleTemplateId(id: string): id is CoordinatorRoleTemplateId {
  return BUILT_IN_COORDINATOR_ROLE_TEMPLATE_BY_ID.has(id as CoordinatorRoleTemplateId);
}

/**
 * Per-thread overrides for delegated tiers (`L1`, `L2`):
 * omitted inherits from template, `ModelSelection` pins for this thread, `null` forces follow-current.
 */
export const CoordinatorTierModelOverrides = Schema.Struct({
  L1: Schema.optional(Schema.NullOr(ModelSelection)),
  L2: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type CoordinatorTierModelOverrides = typeof CoordinatorTierModelOverrides.Type;

/**
 * Per-thread coordinator mode configuration persisted on `OrchestrationV2AppThread`
 * (for L0 root coordinators and L1 opt-in sub-coordinators).
 */
export const ThreadCoordinatorMode = Schema.Struct({
  enabled: Schema.Boolean,
  templateId: CoordinatorRoleTemplateId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)),
  ),
  tierModelOverrides: Schema.optional(CoordinatorTierModelOverrides),
});
export type ThreadCoordinatorMode = typeof ThreadCoordinatorMode.Type;

export const CoordinatorTierResolutionSource = Schema.Literals([
  "thread_override",
  "template_configured",
  "root_thread",
  "dynamic_available",
  "fallback_available",
  "unavailable",
]);
export type CoordinatorTierResolutionSource = typeof CoordinatorTierResolutionSource.Type;

export const ResolvedCoordinatorTierModel = Schema.Struct({
  tier: CoordinatorTier,
  modelSelection: Schema.NullOr(ModelSelection),
  configuredModelSelection: Schema.NullOr(ModelSelection),
  source: CoordinatorTierResolutionSource,
  fallbackUsed: Schema.Boolean,
  fallbackReason: Schema.NullOr(Schema.String),
});
export type ResolvedCoordinatorTierModel = typeof ResolvedCoordinatorTierModel.Type;

export const ResolvedCoordinatorTierModels = Schema.Struct({
  L0: ResolvedCoordinatorTierModel,
  L1: ResolvedCoordinatorTierModel,
  L2: ResolvedCoordinatorTierModel,
});
export type ResolvedCoordinatorTierModels = typeof ResolvedCoordinatorTierModels.Type;

export const ResolvedCoordinatorConfiguration = Schema.Struct({
  template: CoordinatorRoleTemplate,
  requestedTemplateId: CoordinatorRoleTemplateId,
  templateFallbackUsed: Schema.Boolean,
  templateFallbackReason: Schema.NullOr(Schema.String),
  tiers: ResolvedCoordinatorTierModels,
});
export type ResolvedCoordinatorConfiguration = typeof ResolvedCoordinatorConfiguration.Type;

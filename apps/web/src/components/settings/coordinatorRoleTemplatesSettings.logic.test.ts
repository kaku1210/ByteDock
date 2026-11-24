import {
  COORDINATOR_ROLE_TEMPLATE_MAX_COUNT,
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  type CoordinatorRoleTemplateConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveCoordinatorModels } from "@t3tools/shared/coordinator";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftCoordinatorPreviewSettings,
  canCreateCoordinatorRoleTemplate,
  createEmptyCoordinatorTemplateDraft,
  isBuiltInTemplateCustomized,
  pickInitialExplicitTierModel,
  slugifyCoordinatorTemplateId,
  summarizeTierOverrides,
  validateCoordinatorTemplateDraft,
} from "./coordinatorRoleTemplatesSettings.logic";

function makeProvider(
  instanceId: string,
  slugs: ReadonlyArray<string>,
  enabled = true,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName: instanceId,
    enabled,
    installed: true,
    version: "1.0.0",
    status: enabled ? "ready" : "disabled",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: slugs.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("coordinatorRoleTemplatesSettings.logic", () => {
  it("generates unique template slugs avoiding built-in IDs and collisions", () => {
    const existing = new Set<string>(["default", "general-batch", "strict-architect"]);
    expect(slugifyCoordinatorTemplateId("Default", existing)).toBe("default-2");
    expect(slugifyCoordinatorTemplateId("General Batch", existing)).toBe("general-batch-2");
    expect(slugifyCoordinatorTemplateId("Strict Architect!", existing)).toBe("strict-architect-2");
    expect(slugifyCoordinatorTemplateId("   ", existing)).toBe("custom-template");
  });

  it("validates create and edit template drafts including sceneMode", () => {
    const existing = new Set<string>(["default", "general-batch", "review-lead"]);
    const empty = createEmptyCoordinatorTemplateDraft(existing);
    expect(empty.sceneMode).toBe("code");
    expect(validateCoordinatorTemplateDraft(empty, existing)).toEqual({
      ok: false,
      error: "Template name is required.",
    });

    const duplicate = {
      ...empty,
      name: "Review Lead",
      id: "review-lead",
    };
    expect(validateCoordinatorTemplateDraft(duplicate, existing)).toEqual({
      ok: false,
      error: 'Template ID "review-lead" already exists.',
    });

    const validCreate = validateCoordinatorTemplateDraft(
      {
        ...empty,
        name: "Short Drama Pipeline",
        id: "short-drama-pipeline",
        sceneMode: "general",
        description: "Batch episode planning and execution",
        instructions: "Produce structured deliverables per episode.",
      },
      existing,
    );
    expect(validCreate.ok).toBe(true);
    if (validCreate.ok) {
      expect(validCreate.id).toBe("short-drama-pipeline");
      expect(validCreate.config.name).toBe("Short Drama Pipeline");
      expect(validCreate.config.mode).toBe("general");
      expect(validCreate.config.instructions).toBe("Produce structured deliverables per episode.");
    }

    // Edit mode permits keeping the existing template ID.
    const validEdit = validateCoordinatorTemplateDraft(
      {
        ...empty,
        mode: "edit",
        id: "review-lead",
        name: "Review Lead Updated",
      },
      existing,
    );
    expect(validEdit.ok).toBe(true);
  });

  it("detects built-in customization per built-in template and max template count limit", () => {
    expect(isBuiltInTemplateCustomized(DEFAULT_SERVER_SETTINGS)).toBe(false);
    expect(
      isBuiltInTemplateCustomized(
        DEFAULT_SERVER_SETTINGS,
        GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      ),
    ).toBe(false);
    expect(canCreateCoordinatorRoleTemplate(DEFAULT_SERVER_SETTINGS)).toBe(true);

    const sampleConfig: CoordinatorRoleTemplateConfig = {
      name: "Custom",
      description: "",
      mode: "code",
      tierModels: { L0: null, L1: null, L2: null },
      preferDelegation: true,
      delegationStrategy: "tiered",
      instructions: "",
    };
    const customized: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      coordinatorRoleTemplates: {
        [DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID]: sampleConfig,
        [GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID]: {
          ...sampleConfig,
          mode: "general",
        },
      },
    };
    expect(isBuiltInTemplateCustomized(customized, DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)).toBe(
      true,
    );
    expect(
      isBuiltInTemplateCustomized(customized, GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID),
    ).toBe(true);

    const fullMap: Record<CoordinatorRoleTemplateId, CoordinatorRoleTemplateConfig> = {};
    for (let i = 0; i < COORDINATOR_ROLE_TEMPLATE_MAX_COUNT; i += 1) {
      fullMap[CoordinatorRoleTemplateId.make(`tpl-${i}`)] = sampleConfig;
    }
    expect(
      canCreateCoordinatorRoleTemplate({
        coordinatorRoleTemplates: fullMap,
      }),
    ).toBe(false);
  });

  it("picks initial explicit tier models dynamically from live providers", () => {
    const preferred = createModelSelection(ProviderInstanceId.make("p1"), "alpha-pro");
    const providers = [
      makeProvider("disabled", ["off-model"], false),
      makeProvider("p1", ["alpha-pro", "alpha-mini"], true),
    ];
    expect(pickInitialExplicitTierModel(providers, preferred)).toEqual(preferred);
    expect(pickInitialExplicitTierModel(providers, null)).toEqual(
      createModelSelection(ProviderInstanceId.make("p1"), "alpha-pro"),
    );
    expect(pickInitialExplicitTierModel([], null)).toBeNull();
  });

  it("builds live unsaved draft settings for deterministic tier preview", () => {
    const providers = [makeProvider("p1", ["flagship-pro", "balanced-standard", "fast-mini"])];
    const draft = {
      ...createEmptyCoordinatorTemplateDraft(new Set(["default", "general-batch"])),
      id: "batch-preview",
      name: "Batch Preview",
      sceneMode: "general" as const,
      tierModels: {
        L0: createModelSelection(ProviderInstanceId.make("p1"), "flagship-pro"),
        L1: null,
        L2: null,
      },
    };
    const preview = buildDraftCoordinatorPreviewSettings(DEFAULT_SERVER_SETTINGS, draft);
    const resolved = resolveCoordinatorModels({
      settings: preview.settings,
      providers,
      projectId: null,
      templateId: preview.templateId,
      rootModelSelection: createModelSelection(ProviderInstanceId.make("p1"), "balanced-standard"),
    });
    expect(resolved.template.mode).toBe("general");
    expect(resolved.tiers.L0.modelSelection?.model).toBe("flagship-pro");
    expect(resolved.tiers.L0.source).toBe("template_configured");
    expect(resolved.tiers.L1.modelSelection?.model).toBe("balanced-standard");
    expect(resolved.tiers.L1.source).toBe("root_thread");
    expect(resolved.tiers.L2.modelSelection?.model).toBe("balanced-standard");
    expect(summarizeTierOverrides(draft.tierModels)).toBe("Custom L0");
    expect(summarizeTierOverrides({ L0: null, L1: null, L2: null })).toBe(
      "All tiers follow current",
    );
  });
});

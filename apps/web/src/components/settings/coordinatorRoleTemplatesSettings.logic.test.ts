import {
  COORDINATOR_ROLE_TEMPLATE_MAX_COUNT,
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
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
  it("generates unique template slugs avoiding built-in default and collisions", () => {
    const existing = new Set<string>(["default", "strict-architect"]);
    expect(slugifyCoordinatorTemplateId("Default", existing)).toBe("default-2");
    expect(slugifyCoordinatorTemplateId("Strict Architect!", existing)).toBe("strict-architect-2");
    expect(slugifyCoordinatorTemplateId("   ", existing)).toBe("custom-template");
  });

  it("validates create and edit template drafts", () => {
    const existing = new Set<string>(["default", "review-lead"]);
    const empty = createEmptyCoordinatorTemplateDraft(existing);
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
        name: "Strict Architect",
        id: "strict-architect",
        description: "Delegates implementation to L1/L2",
        instructions: "Always verify tests before synthesis.",
      },
      existing,
    );
    expect(validCreate.ok).toBe(true);
    if (validCreate.ok) {
      expect(validCreate.id).toBe("strict-architect");
      expect(validCreate.config.name).toBe("Strict Architect");
      expect(validCreate.config.instructions).toBe("Always verify tests before synthesis.");
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

  it("detects built-in customization and max template count limit", () => {
    expect(isBuiltInTemplateCustomized(DEFAULT_SERVER_SETTINGS)).toBe(false);
    expect(canCreateCoordinatorRoleTemplate(DEFAULT_SERVER_SETTINGS)).toBe(true);

    const sampleConfig: CoordinatorRoleTemplateConfig = {
      name: "Custom",
      description: "",
      tierModels: { L0: null, L1: null, L2: null },
      preferDelegation: true,
      delegationStrategy: "tiered",
      instructions: "",
    };
    const customized: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      coordinatorRoleTemplates: {
        [DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID]: sampleConfig,
      },
    };
    expect(isBuiltInTemplateCustomized(customized)).toBe(true);

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

  it("builds live unsaved draft settings for dynamic tier preview", () => {
    const providers = [makeProvider("p1", ["flagship-pro", "balanced-standard", "fast-mini"])];
    const draft = {
      ...createEmptyCoordinatorTemplateDraft(new Set(["default"])),
      id: "inherit-preview",
      name: "Inherit Preview",
      delegationStrategy: "inherit_root" as const,
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
      rootModelSelection: null,
    });
    expect(resolved.tiers.L0.modelSelection?.model).toBe("flagship-pro");
    expect(resolved.tiers.L1.modelSelection?.model).toBe("flagship-pro");
    expect(resolved.tiers.L1.source).toBe("root_thread");
    expect(resolved.tiers.L2.modelSelection?.model).toBe("flagship-pro");
    expect(summarizeTierOverrides(draft.tierModels)).toBe("Custom L0");
    expect(summarizeTierOverrides({ L0: null, L1: null, L2: null })).toBe("All tiers dynamic");
  });
});

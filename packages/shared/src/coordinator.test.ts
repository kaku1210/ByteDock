import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasCoordinatorRoleTemplate,
  resolveCoordinatorModels,
  resolveCoordinatorRoleTemplate,
  resolveCoordinatorRoleTemplates,
} from "./coordinator.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

function makeModel(
  slug: string,
  overrides: Partial<ServerProviderModel> = {},
): ServerProviderModel {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    ...overrides,
  };
}

function makeProvider(
  instanceId: string,
  models: ReadonlyArray<ServerProviderModel>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-21T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...overrides,
  };
}

describe("coordinator role template settings & lookup", () => {
  it("merges, overrides, deletes, and resets default template via applyServerSettingsPatch", () => {
    const customId = CoordinatorRoleTemplateId.make("arch-lead");
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultCoordinatorRoleTemplateId: customId,
      coordinatorRoleTemplates: {
        [customId]: {
          name: "Architecture Lead",
          description: "Strict delegation",
          tierModels: { L0: null, L1: null, L2: null },
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "Keep L0 focused on planning.",
        },
      },
    });

    expect(hasCoordinatorRoleTemplate(patched, DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)).toBe(true);
    expect(hasCoordinatorRoleTemplate(patched, customId)).toBe(true);
    expect(hasCoordinatorRoleTemplate(patched, CoordinatorRoleTemplateId.make("missing-tpl"))).toBe(
      false,
    );
    expect(patched.defaultCoordinatorRoleTemplateId).toBe(customId);

    const templates = resolveCoordinatorRoleTemplates(patched);
    expect(templates.map((t) => t.id)).toEqual([DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID, customId]);
    expect(templates[0]?.builtIn).toBe(true);
    expect(templates[1]?.builtIn).toBe(false);

    // Deleting the active default custom template resets defaultCoordinatorRoleTemplateId to "default".
    const afterDelete = applyServerSettingsPatch(patched, {
      coordinatorRoleTemplates: {
        [customId]: null,
      },
    });
    expect(hasCoordinatorRoleTemplate(afterDelete, customId)).toBe(false);
    expect(afterDelete.defaultCoordinatorRoleTemplateId).toBe(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID);
  });

  it("falls back gracefully when resolving a deleted custom template id", () => {
    const deletedId = CoordinatorRoleTemplateId.make("deleted-template");
    const lookup = resolveCoordinatorRoleTemplate(DEFAULT_SERVER_SETTINGS, deletedId);
    expect(lookup.template.id).toBe(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID);
    expect(lookup.requestedTemplateId).toBe(deletedId);
    expect(lookup.templateFallbackUsed).toBe(true);
    expect(lookup.templateFallbackReason).toContain("deleted-template");
  });
});

describe("resolveCoordinatorModels", () => {
  it("dynamically assigns L0/L1/L2 across available models without hardcoded model names", () => {
    const providerA = makeProvider("provider-alpha", [
      makeModel("alpha-top", {
        name: "Alpha Pro",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning Effort",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      }),
      makeModel("alpha-balanced", { name: "Alpha Balanced" }),
      makeModel("alpha-lite", { name: "Alpha Fast Mini" }),
    ]);

    const resolved = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [providerA],
      projectId: null,
    });

    expect(resolved.templateFallbackUsed).toBe(false);
    expect(resolved.tiers.L0.modelSelection?.model).toBe("alpha-top");
    expect(resolved.tiers.L0.source).toBe("dynamic_available");
    expect(resolved.tiers.L1.modelSelection?.model).toBe("alpha-balanced");
    expect(resolved.tiers.L1.source).toBe("dynamic_available");
    expect(resolved.tiers.L2.modelSelection?.model).toBe("alpha-lite");
    expect(resolved.tiers.L2.source).toBe("dynamic_available");
    expect(resolved.tiers.L0.fallbackUsed).toBe(false);
    expect(resolved.tiers.L1.fallbackUsed).toBe(false);
    expect(resolved.tiers.L2.fallbackUsed).toBe(false);
  });

  it("degrades cleanly when only 1 or 2 usable models exist", () => {
    const singleModelProvider = makeProvider("solo-provider", [makeModel("only-model")]);
    const singleResolved = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [singleModelProvider],
      projectId: null,
    });
    expect(singleResolved.tiers.L0.modelSelection?.model).toBe("only-model");
    expect(singleResolved.tiers.L1.modelSelection?.model).toBe("only-model");
    expect(singleResolved.tiers.L2.modelSelection?.model).toBe("only-model");

    const twoModelProvider = makeProvider("duo-provider", [
      makeModel("duo-max"),
      makeModel("duo-mini"),
    ]);
    const duoResolved = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [twoModelProvider],
      projectId: null,
    });
    expect(duoResolved.tiers.L0.modelSelection?.model).toBe("duo-max");
    expect(duoResolved.tiers.L1.modelSelection?.model).toBe("duo-max");
    expect(duoResolved.tiers.L2.modelSelection?.model).toBe("duo-mini");
  });

  it("supports cross-provider pinned template models, aliases, and option descriptor filtering", () => {
    const providerA = makeProvider("provider-a", [
      makeModel("a-architect", {
        aliases: ["a-arch-alias"],
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      }),
    ]);
    const providerB = makeProvider("provider-b", [makeModel("b-builder"), makeModel("b-quick")]);

    const customId = CoordinatorRoleTemplateId.make("cross-provider");
    const settings = settingsWith({
      coordinatorRoleTemplates: {
        [customId]: {
          name: "Cross Provider",
          description: "",
          tierModels: {
            L0: {
              instanceId: ProviderInstanceId.make("provider-a"),
              model: "a-arch-alias",
              options: [
                { id: "effort", value: "high" },
                { id: "unknown-option", value: "nope" },
              ],
            },
            L1: {
              instanceId: ProviderInstanceId.make("provider-b"),
              model: "b-builder",
            },
            L2: {
              instanceId: ProviderInstanceId.make("provider-b"),
              model: "b-quick",
            },
          },
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "",
        },
      },
    });

    const resolved = resolveCoordinatorModels({
      settings,
      providers: [providerA, providerB],
      projectId: null,
      templateId: customId,
    });

    expect(resolved.tiers.L0).toMatchObject({
      source: "template_configured",
      fallbackUsed: false,
      modelSelection: {
        instanceId: "provider-a",
        model: "a-architect",
        options: [{ id: "effort", value: "high" }],
      },
    });
    expect(resolved.tiers.L1).toMatchObject({
      source: "template_configured",
      fallbackUsed: false,
      modelSelection: { instanceId: "provider-b", model: "b-builder" },
    });
    expect(resolved.tiers.L2).toMatchObject({
      source: "template_configured",
      fallbackUsed: false,
      modelSelection: { instanceId: "provider-b", model: "b-quick" },
    });
  });

  it("falls back with explicit reasons when pinned provider/model is disabled, unauthenticated, project-disabled, or missing", () => {
    const projectId = ProjectId.make("project:alpha");
    const disabledProvider = makeProvider("provider-disabled", [makeModel("m-disabled")], {
      enabled: false,
    });
    const unauthProvider = makeProvider("provider-unauth", [makeModel("m-unauth")], {
      auth: { status: "unauthenticated" },
    });
    const projectDisabledProvider = makeProvider("provider-proj-off", [makeModel("m-proj-off")]);
    const liveProvider = makeProvider("provider-live", [
      makeModel("live-top"),
      makeModel("live-mid"),
      makeModel("live-mini"),
    ]);

    const tplId = CoordinatorRoleTemplateId.make("fallback-test");
    const settings = settingsWith({
      projectSettingsOverrides: {
        [projectId]: {
          providerInstances: {
            [ProviderInstanceId.make("provider-proj-off")]: { enabled: false },
          },
        },
      },
      coordinatorRoleTemplates: {
        [tplId]: {
          name: "Fallback Test",
          description: "",
          tierModels: {
            L0: { instanceId: ProviderInstanceId.make("provider-disabled"), model: "m-disabled" },
            L1: { instanceId: ProviderInstanceId.make("provider-unauth"), model: "m-unauth" },
            L2: {
              instanceId: ProviderInstanceId.make("provider-proj-off"),
              model: "m-proj-off",
            },
          },
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "",
        },
      },
    });

    const resolved = resolveCoordinatorModels({
      settings,
      providers: [disabledProvider, unauthProvider, projectDisabledProvider, liveProvider],
      projectId,
      templateId: tplId,
    });

    expect(resolved.tiers.L0.source).toBe("fallback_available");
    expect(resolved.tiers.L0.fallbackUsed).toBe(true);
    expect(resolved.tiers.L0.fallbackReason).toContain("disabled");
    expect(resolved.tiers.L0.modelSelection?.instanceId).toBe("provider-live");

    expect(resolved.tiers.L1.source).toBe("fallback_available");
    expect(resolved.tiers.L1.fallbackUsed).toBe(true);
    expect(resolved.tiers.L1.fallbackReason).toContain("not authenticated");
    expect(resolved.tiers.L1.modelSelection?.instanceId).toBe("provider-live");

    expect(resolved.tiers.L2.source).toBe("fallback_available");
    expect(resolved.tiers.L2.fallbackUsed).toBe(true);
    expect(resolved.tiers.L2.fallbackReason).toContain("disabled for this project");
    expect(resolved.tiers.L2.modelSelection?.instanceId).toBe("provider-live");
  });

  it("supports inherit_root delegation strategy using the root thread model", () => {
    const provider = makeProvider("provider-x", [
      makeModel("x-pro"),
      makeModel("x-mid"),
      makeModel("x-fast"),
    ]);
    const inheritId = CoordinatorRoleTemplateId.make("inherit-root");
    const settings = settingsWith({
      coordinatorRoleTemplates: {
        [inheritId]: {
          name: "Inherit Root",
          description: "",
          tierModels: { L0: null, L1: null, L2: null },
          preferDelegation: true,
          delegationStrategy: "inherit_root",
          instructions: "",
        },
      },
    });

    const resolved = resolveCoordinatorModels({
      settings,
      providers: [provider],
      projectId: null,
      templateId: inheritId,
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-x"),
        model: "x-mid",
      },
    });

    expect(resolved.tiers.L0).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-x", model: "x-mid" },
    });
    expect(resolved.tiers.L1).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-x", model: "x-mid" },
    });
    expect(resolved.tiers.L2).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-x", model: "x-mid" },
    });
  });

  it("returns unavailable tiers gracefully when no usable provider or model is available", () => {
    const unavailableProvider = makeProvider("provider-err", [makeModel("err-model")], {
      status: "error",
      message: "CLI missing",
    });

    const resolved = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [unavailableProvider],
      projectId: null,
    });

    expect(resolved.tiers.L0).toMatchObject({
      source: "unavailable",
      modelSelection: null,
      fallbackUsed: false,
    });
    expect(resolved.tiers.L0.fallbackReason).toContain("No enabled and available");
    expect(resolved.tiers.L1.source).toBe("unavailable");
    expect(resolved.tiers.L2.source).toBe("unavailable");
  });
});

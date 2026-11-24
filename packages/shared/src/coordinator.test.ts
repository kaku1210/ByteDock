import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
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
  it("merges, overrides, deletes, and preserves built-in default templates via applyServerSettingsPatch", () => {
    const customId = CoordinatorRoleTemplateId.make("arch-lead");
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultCoordinatorRoleTemplateId: customId,
      coordinatorRoleTemplates: {
        [customId]: {
          name: "Architecture Lead",
          description: "Strict delegation",
          mode: "code",
          tierModels: { L0: null, L1: null, L2: null },
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "Keep L0 focused on planning.",
        },
      },
    });

    expect(hasCoordinatorRoleTemplate(patched, DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)).toBe(true);
    expect(hasCoordinatorRoleTemplate(patched, GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID)).toBe(
      true,
    );
    expect(hasCoordinatorRoleTemplate(patched, customId)).toBe(true);
    expect(hasCoordinatorRoleTemplate(patched, CoordinatorRoleTemplateId.make("missing-tpl"))).toBe(
      false,
    );
    expect(patched.defaultCoordinatorRoleTemplateId).toBe(customId);

    const templates = resolveCoordinatorRoleTemplates(patched);
    expect(templates.map((t) => t.id)).toEqual([
      DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      customId,
    ]);
    expect(templates[0]?.builtIn).toBe(true);
    expect(templates[0]?.mode).toBe("code");
    expect(templates[1]?.builtIn).toBe(true);
    expect(templates[1]?.mode).toBe("general");
    expect(templates[2]?.builtIn).toBe(false);

    // Setting defaultCoordinatorRoleTemplateId to the built-in general-batch preset is preserved.
    const generalDefault = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultCoordinatorRoleTemplateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    });
    expect(generalDefault.defaultCoordinatorRoleTemplateId).toBe(
      GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    );

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
  it("deterministically follows the current coordinating thread model when tiers are unpinned", () => {
    const providerA = makeProvider("provider-alpha", [
      makeModel("alpha-top", { name: "Alpha Pro" }),
      makeModel("alpha-balanced", { name: "Alpha Balanced" }),
      makeModel("alpha-lite", { name: "Alpha Fast Mini" }),
    ]);

    const resolved = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [providerA],
      projectId: null,
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-alpha"),
        model: "alpha-balanced",
      },
    });

    expect(resolved.templateFallbackUsed).toBe(false);
    expect(resolved.tiers.L0).toMatchObject({
      source: "root_thread",
      fallbackUsed: false,
      modelSelection: { instanceId: "provider-alpha", model: "alpha-balanced" },
    });
    expect(resolved.tiers.L1).toMatchObject({
      source: "root_thread",
      fallbackUsed: false,
      modelSelection: { instanceId: "provider-alpha", model: "alpha-balanced" },
    });
    expect(resolved.tiers.L2).toMatchObject({
      source: "root_thread",
      fallbackUsed: false,
      modelSelection: { instanceId: "provider-alpha", model: "alpha-balanced" },
    });
  });

  it("falls back to the first visible provider model when no rootModelSelection is supplied", () => {
    const provider = makeProvider("duo-provider", [
      makeModel("duo-first"),
      makeModel("duo-second"),
    ]);
    const resolved = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [provider],
      projectId: null,
    });
    expect(resolved.tiers.L0).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "duo-provider", model: "duo-first" },
    });
    expect(resolved.tiers.L1.modelSelection?.model).toBe("duo-first");
    expect(resolved.tiers.L2.modelSelection?.model).toBe("duo-first");
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
          mode: "code",
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

  it("marks pinned tiers unavailable with explicit reasons instead of silently substituting another model", () => {
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

    const tplId = CoordinatorRoleTemplateId.make("unavailable-pin-test");
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
          name: "Unavailable Pin Test",
          description: "",
          mode: "code",
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
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-live"),
        model: "live-top",
      },
    });

    expect(resolved.tiers.L0).toMatchObject({
      source: "unavailable",
      fallbackUsed: false,
      modelSelection: null,
    });
    expect(resolved.tiers.L0.fallbackReason).toContain("disabled");

    expect(resolved.tiers.L1).toMatchObject({
      source: "unavailable",
      fallbackUsed: false,
      modelSelection: null,
    });
    expect(resolved.tiers.L1.fallbackReason).toContain("not authenticated");

    expect(resolved.tiers.L2).toMatchObject({
      source: "unavailable",
      fallbackUsed: false,
      modelSelection: null,
    });
    expect(resolved.tiers.L2.fallbackReason).toContain("disabled for this project");
  });

  it("supports callerTier='L1' where unpinned L2 follows B's model and pinned L2 honors template", () => {
    const providerA = makeProvider("provider-a", [makeModel("a-cheap"), makeModel("a-lead")]);
    const providerB = makeProvider("provider-b", [makeModel("b-expensive")]);
    const tplId = CoordinatorRoleTemplateId.make("drama-batch");
    const settings = settingsWith({
      coordinatorRoleTemplates: {
        [tplId]: {
          name: "Drama Batch",
          description: "",
          mode: "general",
          tierModels: {
            L0: null,
            L1: null,
            L2: { instanceId: ProviderInstanceId.make("provider-b"), model: "b-expensive" },
          },
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "",
        },
      },
    });

    const pinnedL2 = resolveCoordinatorModels({
      settings,
      providers: [providerA, providerB],
      projectId: null,
      templateId: tplId,
      callerTier: "L1",
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-a"),
        model: "a-cheap",
      },
    });

    expect(pinnedL2.template.mode).toBe("general");
    expect(pinnedL2.tiers.L1).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-a", model: "a-cheap" },
    });
    expect(pinnedL2.tiers.L2).toMatchObject({
      source: "template_configured",
      modelSelection: { instanceId: "provider-b", model: "b-expensive" },
    });

    const unpinnedL2 = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [providerA, providerB],
      projectId: null,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      callerTier: "L1",
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-a"),
        model: "a-lead",
      },
    });

    expect(unpinnedL2.template.mode).toBe("general");
    expect(unpinnedL2.tiers.L2).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-a", model: "a-lead" },
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

  it("applies per-thread tierModelOverrides above template pins, supports explicit null follow-current, and reports unavailable overrides without silent swap", () => {
    const providerA = makeProvider("provider-a", [
      makeModel("a-root"),
      makeModel("a-lead"),
      makeModel("a-fast"),
    ]);
    const providerB = makeProvider("provider-b", [makeModel("b-specialist")]);
    const tplId = CoordinatorRoleTemplateId.make("pinned-both");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      coordinatorRoleTemplates: {
        [tplId]: {
          name: "Pinned Both",
          description: "",
          mode: "code",
          tierModels: {
            L0: null,
            L1: { instanceId: ProviderInstanceId.make("provider-a"), model: "a-lead" },
            L2: { instanceId: ProviderInstanceId.make("provider-b"), model: "b-specialist" },
          },
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "",
        },
      },
    };

    // Override L1 back to follow-current (null) and pin L2 to a different available model.
    const overridden = resolveCoordinatorModels({
      settings,
      providers: [providerA, providerB],
      projectId: null,
      templateId: tplId,
      tierModelOverrides: {
        L1: null,
        L2: { instanceId: ProviderInstanceId.make("provider-a"), model: "a-fast" },
      },
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-a"),
        model: "a-root",
      },
    });

    expect(overridden.tiers.L0).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-a", model: "a-root" },
    });
    expect(overridden.tiers.L1).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-a", model: "a-root" },
      configuredModelSelection: null,
    });
    expect(overridden.tiers.L2).toMatchObject({
      source: "thread_override",
      modelSelection: { instanceId: "provider-a", model: "a-fast" },
      configuredModelSelection: { instanceId: "provider-a", model: "a-fast" },
      fallbackUsed: false,
    });

    // Unavailable thread override must report unavailable (no silent swap).
    const unavailableOverride = resolveCoordinatorModels({
      settings,
      providers: [providerA, providerB],
      projectId: null,
      templateId: tplId,
      tierModelOverrides: {
        L2: { instanceId: ProviderInstanceId.make("provider-b"), model: "removed-model" },
      },
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-a"),
        model: "a-root",
      },
    });
    expect(unavailableOverride.tiers.L1.source).toBe("template_configured");
    expect(unavailableOverride.tiers.L2).toMatchObject({
      source: "unavailable",
      modelSelection: null,
      fallbackUsed: false,
    });
    expect(unavailableOverride.tiers.L2.fallbackReason).toContain("removed-model");

    // L1 sub-coordinator respects its own L2 thread override while keeping L1 on its own thread model.
    const l1WithL2Override = resolveCoordinatorModels({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [providerA, providerB],
      projectId: null,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      callerTier: "L1",
      tierModelOverrides: {
        L1: { instanceId: ProviderInstanceId.make("provider-a"), model: "a-fast" },
        L2: { instanceId: ProviderInstanceId.make("provider-b"), model: "b-specialist" },
      },
      rootModelSelection: {
        instanceId: ProviderInstanceId.make("provider-a"),
        model: "a-lead",
      },
    });
    expect(l1WithL2Override.tiers.L1).toMatchObject({
      source: "root_thread",
      modelSelection: { instanceId: "provider-a", model: "a-lead" },
    });
    expect(l1WithL2Override.tiers.L2).toMatchObject({
      source: "thread_override",
      modelSelection: { instanceId: "provider-b", model: "b-specialist" },
    });
  });
});

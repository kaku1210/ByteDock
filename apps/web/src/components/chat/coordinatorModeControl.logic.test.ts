import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCoordinatorTemplateSwitchMode,
  buildCoordinatorTierOverrideMode,
  buildCoordinatorToggleMode,
  COORDINATOR_TIER_OPTION_FOLLOW,
  COORDINATOR_TIER_OPTION_TEMPLATE,
  coordinatorDelegationStrategyLabel,
  coordinatorDelegationStrategyShortLabel,
  coordinatorSceneModeLabel,
  coordinatorTierRoleLabel,
  coordinatorTierShortRoleLabel,
  coordinatorTierShortSourceLabel,
  coordinatorTierSourceLabel,
  decodeCoordinatorTierOption,
  encodeCoordinatorTierModelOption,
  formatCoordinatorModelSelectionLabel,
  formatCoordinatorModelShortName,
  isThreadCoordinatorControlVisible,
  resolveCoordinatorControlState,
  resolveCoordinatorControlTier,
} from "./coordinatorModeControl.logic";

function makeProvider(input: {
  instanceId: string;
  displayName?: string;
  enabled?: boolean;
  models: ReadonlyArray<{ slug: string; name: string }>;
}): ServerProvider {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: input.displayName ?? input.instanceId,
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("resolveCoordinatorControlTier & isThreadCoordinatorControlVisible", () => {
  it("resolves L0 on draft and persistent root threads, and L1 on persistent direct L1 subtasks/subagents", () => {
    expect(resolveCoordinatorControlTier({ routeKind: "draft", thread: null })).toBe("L0");
    expect(isThreadCoordinatorControlVisible({ routeKind: "draft", thread: null })).toBe(true);

    expect(
      resolveCoordinatorControlTier({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: null,
            relationshipToParent: null,
          },
          delegatedFrom: null,
        },
      }),
    ).toBe("L0");

    expect(
      resolveCoordinatorControlTier({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: ThreadId.make("root-1"),
            relationshipToParent: "subtask",
          },
          delegatedFrom: null,
        },
      }),
    ).toBe("L1");

    expect(
      resolveCoordinatorControlTier({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: ThreadId.make("root-1"),
            relationshipToParent: "subagent",
          },
          delegatedFrom: null,
        },
      }),
    ).toBe("L1");
  });

  it("hides on L2 subtasks, side chats, temporary threads, workflow steps, and remotely delegated threads", () => {
    expect(isThreadCoordinatorControlVisible({ routeKind: "server", thread: null })).toBe(false);
    expect(
      resolveCoordinatorControlTier({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: ThreadId.make("l1-child"),
            relationshipToParent: "subtask",
          },
          delegatedFrom: null,
        },
      }),
    ).toBeNull();
    expect(
      isThreadCoordinatorControlVisible({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: ThreadId.make("root-1"),
            relationshipToParent: "fork",
            sideChat: true,
          },
          delegatedFrom: null,
        },
      }),
    ).toBe(false);
    expect(
      isThreadCoordinatorControlVisible({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: null,
            relationshipToParent: null,
            temporary: true,
          },
          delegatedFrom: null,
        },
      }),
    ).toBe(false);
    expect(
      isThreadCoordinatorControlVisible({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: ThreadId.make("root-1"),
            relationshipToParent: "subtask",
            workflowStep: true,
          },
          delegatedFrom: null,
        },
      }),
    ).toBe(false);
    expect(
      isThreadCoordinatorControlVisible({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-1"),
            parentThreadId: null,
            relationshipToParent: null,
          },
          delegatedFrom: {
            environmentId: EnvironmentId.make("remote-env"),
            threadId: ThreadId.make("remote-root"),
            title: "Remote parent",
          },
        },
      }),
    ).toBe(false);
  });
});

describe("resolveCoordinatorControlState", () => {
  const providers: ReadonlyArray<ServerProvider> = [
    makeProvider({
      instanceId: "primary",
      displayName: "Primary Agent",
      models: [
        { slug: "vendor-flagship-pro", name: "Vendor Flagship Pro" },
        { slug: "vendor-balanced-standard", name: "Vendor Balanced Standard" },
        { slug: "vendor-fast-mini", name: "Vendor Fast Mini" },
      ],
    }),
  ];

  it("deterministically follows current thread model when template tiers are unpinned", () => {
    const rootSelection = createModelSelection(
      ProviderInstanceId.make("primary"),
      "vendor-flagship-pro",
    );
    const state = resolveCoordinatorControlState({
      coordinatorMode: {
        enabled: true,
        templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      },
      settings: DEFAULT_SERVER_SETTINGS,
      providers,
      projectId: null,
      rootModelSelection: rootSelection,
    });

    expect(state.enabled).toBe(true);
    expect(state.callerTier).toBe("L0");
    expect(state.visibleTiers).toEqual(["L0", "L1", "L2"]);
    expect(state.hasAnyFallback).toBe(false);
    expect(state.hasUnavailableTier).toBe(false);
    expect(state.resolved.tiers.L0.modelSelection?.model).toBe("vendor-flagship-pro");
    expect(state.resolved.tiers.L0.source).toBe("root_thread");
    expect(state.resolved.tiers.L1.modelSelection?.model).toBe("vendor-flagship-pro");
    expect(state.resolved.tiers.L1.source).toBe("root_thread");
    expect(state.resolved.tiers.L2.modelSelection?.model).toBe("vendor-flagship-pro");
    expect(state.resolved.tiers.L2.source).toBe("root_thread");
    expect(
      formatCoordinatorModelSelectionLabel(state.resolved.tiers.L1.modelSelection, providers),
    ).toBe("Primary Agent · Vendor Flagship Pro");
  });

  it("shows only L2 and inherits L0's template on first-time opt-in for callerTier='L1'", () => {
    const bModel = createModelSelection(
      ProviderInstanceId.make("primary"),
      "vendor-balanced-standard",
    );
    const state = resolveCoordinatorControlState({
      coordinatorMode: null,
      settings: DEFAULT_SERVER_SETTINGS,
      providers,
      projectId: null,
      rootModelSelection: bModel,
      callerTier: "L1",
      inheritedRootTemplateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    expect(state.enabled).toBe(false);
    expect(state.callerTier).toBe("L1");
    expect(state.visibleTiers).toEqual(["L2"]);
    expect(state.selectedTemplateId).toBe(GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID);
    expect(state.resolved.template.mode).toBe("general");
    expect(state.resolved.tiers.L2.source).toBe("root_thread");
    expect(state.resolved.tiers.L2.modelSelection?.model).toBe("vendor-balanced-standard");
  });

  it("flags unavailable without silent model swap when a pinned tier model is missing", () => {
    const customId = CoordinatorRoleTemplateId.make("custom-ops");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      coordinatorRoleTemplates: {
        [customId]: {
          name: "Custom Ops",
          description: "Test unavailable pin",
          mode: "code",
          preferDelegation: true,
          delegationStrategy: "tiered",
          instructions: "",
          tierModels: {
            L0: null,
            L1: createModelSelection(ProviderInstanceId.make("primary"), "removed-model-slug"),
            L2: null,
          },
        },
      },
    };
    const state = resolveCoordinatorControlState({
      coordinatorMode: { enabled: true, templateId: customId },
      settings,
      providers,
      projectId: null,
      rootModelSelection: null,
    });

    expect(state.hasUnavailableTier).toBe(true);
    expect(state.resolved.tiers.L1.fallbackUsed).toBe(false);
    expect(state.resolved.tiers.L1.modelSelection).toBeNull();
    expect(state.resolved.tiers.L1.source).toBe("unavailable");
    expect(state.resolved.tiers.L1.fallbackReason).toContain("removed-model-slug");
  });

  it("flags unavailable tiers when no providers are available and exposes simplified labels", () => {
    const state = resolveCoordinatorControlState({
      coordinatorMode: null,
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [],
      projectId: null,
      rootModelSelection: null,
    });

    expect(state.enabled).toBe(false);
    expect(state.hasUnavailableTier).toBe(true);
    expect(formatCoordinatorModelSelectionLabel(null, [])).toBe("Unavailable");
    expect(formatCoordinatorModelShortName(null, [])).toBe("Unavailable");
    expect(
      formatCoordinatorModelShortName(
        createModelSelection(ProviderInstanceId.make("primary"), "vendor-balanced-standard"),
        providers,
      ),
    ).toBe("Vendor Balanced Standard");
    expect(coordinatorTierRoleLabel("L0")).toBe("L0 Coordinator");
    expect(coordinatorTierRoleLabel("L1")).toBe("L1 Task Lead");
    expect(coordinatorTierRoleLabel("L2")).toBe("L2 Worker");
    expect(coordinatorTierShortRoleLabel("L0")).toBe("Plan & coordinate");
    expect(coordinatorTierShortRoleLabel("L1")).toBe("Module lead");
    expect(coordinatorTierShortRoleLabel("L2")).toBe("Light execution");
    expect(coordinatorSceneModeLabel("code")).toBe("Code");
    expect(coordinatorSceneModeLabel("general")).toBe("General");
    expect(coordinatorTierSourceLabel("thread_override")).toBe("This thread");
    expect(coordinatorTierSourceLabel("template_configured")).toBe("Pinned");
    expect(coordinatorTierSourceLabel("root_thread")).toBe("Follows current");
    expect(coordinatorTierSourceLabel("unavailable")).toBe("Unavailable");
    expect(coordinatorTierShortSourceLabel("thread_override")).toBe("This thread");
    expect(coordinatorTierShortSourceLabel("root_thread")).toBe("Follows current");
    expect(coordinatorTierShortSourceLabel("template_configured")).toBe("Pinned");
    expect(coordinatorTierShortSourceLabel("unavailable")).toBe("Unavailable");
    expect(coordinatorDelegationStrategyLabel("tiered")).toContain("L0 / L1 / L2");
    expect(coordinatorDelegationStrategyLabel("inherit_root")).toContain("L0");
    expect(coordinatorDelegationStrategyShortLabel("tiered")).toBe("Tiered models");
    expect(coordinatorDelegationStrategyShortLabel("inherit_root")).toBe("Inherit main model");
  });

  it("supports per-thread L1/L2 overrides, preserves them on toggle, clears them on template switch, and encodes/decodes tier options", () => {
    const primaryId = ProviderInstanceId.make("primary");
    const rootSelection = createModelSelection(primaryId, "vendor-flagship-pro");
    const leadSelection = createModelSelection(primaryId, "vendor-balanced-standard");
    const fastSelection = createModelSelection(primaryId, "vendor-fast-mini");

    const withOverride = buildCoordinatorTierOverrideMode({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      currentOverrides: undefined,
      tier: "L2",
      templateTierModel: null,
      nextValue: fastSelection,
    });
    expect(withOverride).toEqual({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: { L2: fastSelection },
    });

    // Toggling off preserves overrides; switching templates clears overrides.
    expect(
      buildCoordinatorToggleMode({
        enabled: false,
        templateId: withOverride.templateId,
        tierModelOverrides: withOverride.tierModelOverrides,
      }),
    ).toEqual({
      enabled: false,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: { L2: fastSelection },
    });
    expect(
      buildCoordinatorTemplateSwitchMode({
        enabled: true,
        templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      }),
    ).toEqual({
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    // Setting null on an unpinned template tier drops the redundant override key.
    expect(
      buildCoordinatorTierOverrideMode({
        enabled: true,
        templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
        currentOverrides: { L2: fastSelection },
        tier: "L2",
        templateTierModel: null,
        nextValue: null,
      }),
    ).toEqual({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    // Setting null on a pinned template tier records an explicit null follow-current override.
    expect(
      buildCoordinatorTierOverrideMode({
        enabled: true,
        templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
        currentOverrides: undefined,
        tier: "L1",
        templateTierModel: leadSelection,
        nextValue: null,
      }),
    ).toEqual({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: { L1: null },
    });

    // Control state resolves thread overrides and marks hasThreadOverrides.
    const state = resolveCoordinatorControlState({
      coordinatorMode: withOverride,
      settings: DEFAULT_SERVER_SETTINGS,
      providers,
      projectId: null,
      rootModelSelection: rootSelection,
    });
    expect(state.hasThreadOverrides).toBe(true);
    expect(state.resolved.tiers.L2.source).toBe("thread_override");
    expect(state.resolved.tiers.L2.modelSelection?.model).toBe("vendor-fast-mini");
    expect(state.selectableProviderGroups).toHaveLength(1);
    expect(state.selectableProviderGroups[0]?.models.map((model) => model.slug)).toEqual([
      "vendor-flagship-pro",
      "vendor-balanced-standard",
      "vendor-fast-mini",
    ]);

    const encoded = encodeCoordinatorTierModelOption(primaryId, "vendor-fast-mini");
    expect(decodeCoordinatorTierOption(encoded)).toEqual({
      kind: "model",
      selection: fastSelection,
    });
    expect(decodeCoordinatorTierOption(COORDINATOR_TIER_OPTION_TEMPLATE)).toEqual({
      kind: "template",
    });
    expect(decodeCoordinatorTierOption(COORDINATOR_TIER_OPTION_FOLLOW)).toEqual({
      kind: "follow",
    });
  });
});

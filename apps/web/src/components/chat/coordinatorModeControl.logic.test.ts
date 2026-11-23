import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorDelegationStrategyLabel,
  coordinatorDelegationStrategyShortLabel,
  coordinatorTierRoleLabel,
  coordinatorTierShortRoleLabel,
  coordinatorTierShortSourceLabel,
  coordinatorTierSourceLabel,
  formatCoordinatorModelSelectionLabel,
  formatCoordinatorModelShortName,
  isThreadCoordinatorControlVisible,
  resolveCoordinatorControlState,
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

describe("isThreadCoordinatorControlVisible", () => {
  it("shows on draft threads and persistent L0 root threads", () => {
    expect(isThreadCoordinatorControlVisible({ routeKind: "draft", thread: null })).toBe(true);
    expect(
      isThreadCoordinatorControlVisible({
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
    ).toBe(true);
    expect(
      isThreadCoordinatorControlVisible({
        routeKind: "server",
        thread: {
          lineage: {
            rootThreadId: ThreadId.make("root-2"),
            parentThreadId: null,
            relationshipToParent: null,
          },
        },
      }),
    ).toBe(true);
  });

  it("hides on subtasks, subagents, side chats, temporary threads, and remotely delegated threads", () => {
    expect(isThreadCoordinatorControlVisible({ routeKind: "server", thread: null })).toBe(false);
    expect(
      isThreadCoordinatorControlVisible({
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
    ).toBe(false);
    expect(
      isThreadCoordinatorControlVisible({
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
    ).toBe(false);
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

  it("dynamically resolves L0/L1/L2 tiers from live provider catalog without hardcoded models", () => {
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
    expect(state.hasAnyFallback).toBe(false);
    expect(state.hasUnavailableTier).toBe(false);
    expect(state.resolved.tiers.L0.modelSelection?.model).toBe("vendor-flagship-pro");
    expect(state.resolved.tiers.L0.source).toBe("root_thread");
    expect(state.resolved.tiers.L1.modelSelection?.model).toBe("vendor-balanced-standard");
    expect(state.resolved.tiers.L1.source).toBe("dynamic_available");
    expect(state.resolved.tiers.L2.modelSelection?.model).toBe("vendor-fast-mini");
    expect(state.resolved.tiers.L2.source).toBe("dynamic_available");
    expect(
      formatCoordinatorModelSelectionLabel(state.resolved.tiers.L1.modelSelection, providers),
    ).toBe("Primary Agent · Vendor Balanced Standard");
  });

  it("flags fallback when a configured template tier model is unavailable", () => {
    const customId = CoordinatorRoleTemplateId.make("custom-ops");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      coordinatorRoleTemplates: {
        [customId]: {
          name: "Custom Ops",
          description: "Test fallback",
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

    expect(state.hasAnyFallback).toBe(true);
    expect(state.resolved.tiers.L1.fallbackUsed).toBe(true);
    expect(state.resolved.tiers.L1.source).toBe("fallback_available");
    expect(state.resolved.tiers.L1.fallbackReason).toContain("removed-model-slug");
  });

  it("flags unavailable tiers when no providers are available", () => {
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
    expect(coordinatorTierSourceLabel("template_configured")).toBe("Template override");
    expect(coordinatorTierSourceLabel("fallback_available")).toBe("Fallback");
    expect(coordinatorTierShortSourceLabel("root_thread")).toBe("Follows current");
    expect(coordinatorTierShortSourceLabel("dynamic_available")).toBe("Auto");
    expect(coordinatorTierShortSourceLabel("template_configured")).toBe("Pinned");
    expect(coordinatorDelegationStrategyLabel("tiered")).toContain("L0 / L1 / L2");
    expect(coordinatorDelegationStrategyLabel("inherit_root")).toContain("L0");
    expect(coordinatorDelegationStrategyShortLabel("tiered")).toBe("Tiered models");
    expect(coordinatorDelegationStrategyShortLabel("inherit_root")).toBe("Inherit main model");
  });
});

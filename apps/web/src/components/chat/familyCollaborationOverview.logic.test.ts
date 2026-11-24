import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNodeSubCoordinatorToggleMode,
  canToggleNodeSubCoordinator,
  isOverviewGeneralScene,
  resolveOverviewNodeCoordinatorView,
} from "./familyCollaborationOverview.logic";

const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

function makeProviders(): ReadonlyArray<ServerProvider> {
  return [
    {
      driver: ProviderDriverKind.make("codex"),
      instanceId: CODEX_INSTANCE,
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-20T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "gpt-5.4-mini",
          name: "GPT-5.4 Mini",
          isCustom: false,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: CLAUDE_INSTANCE,
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-20T00:00:00.000Z",
      models: [
        {
          slug: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          isCustom: false,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ];
}

describe("familyCollaborationOverview.logic", () => {
  it("allows quick Sub-Coordinator toggling only for non-archived L1 subtasks", () => {
    expect(canToggleNodeSubCoordinator({ depth: 1, nodeKind: "subtask", isArchived: false })).toBe(
      true,
    );
    expect(canToggleNodeSubCoordinator({ depth: 0, nodeKind: "root", isArchived: false })).toBe(
      false,
    );
    expect(canToggleNodeSubCoordinator({ depth: 1, nodeKind: "fork", isArchived: false })).toBe(
      false,
    );
    expect(canToggleNodeSubCoordinator({ depth: 1, nodeKind: "subtask", isArchived: true })).toBe(
      false,
    );
    expect(canToggleNodeSubCoordinator({ depth: 2, nodeKind: "subtask", isArchived: false })).toBe(
      false,
    );
  });

  it("inherits L0 template on first L1 opt-in and preserves overrides across toggles", () => {
    const firstEnable = buildNodeSubCoordinatorToggleMode({
      node: { coordinatorMode: null },
      rootCoordinatorMode: {
        enabled: true,
        templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      },
      defaultTemplateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    });
    expect(firstEnable).toEqual({
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    const disablePreservingOverrides = buildNodeSubCoordinatorToggleMode({
      node: {
        coordinatorMode: {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L2: { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" },
          },
        },
      },
      rootCoordinatorMode: {
        enabled: true,
        templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      },
    });
    expect(disablePreservingOverrides).toEqual({
      enabled: false,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L2: { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" },
      },
    });
  });

  it("resolves L0 and L1 coordinator views with localized template names, scene mode, and overrides", () => {
    const providers = makeProviders();
    const uiText = (source: string) =>
      source === "General Batch Collaboration" ? "通用批量协作" : source;

    const l0View = resolveOverviewNodeCoordinatorView({
      node: {
        depth: 0,
        modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4" },
        coordinatorMode: {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L1: { instanceId: CODEX_INSTANCE, model: "gpt-5.4-mini" },
          },
        },
      },
      projectId: ProjectId.make("project-1"),
      settings: DEFAULT_UNIFIED_SETTINGS,
      providers,
      uiText,
    });

    expect(l0View).not.toBeNull();
    expect(l0View?.tier).toBe("L0");
    expect(l0View?.roleLabel).toBe("Coordinator");
    expect(l0View?.templateName).toBe("通用批量协作");
    expect(l0View?.sceneMode).toBe("general");
    expect(l0View?.hasThreadOverrides).toBe(true);
    expect(l0View?.overrideSummary).toBe("L1: GPT-5.4 Mini");
    expect(l0View?.resolvedTiers.map((tier) => tier.tier)).toEqual(["L1", "L2"]);
    expect(l0View?.resolvedTiers[0]).toMatchObject({
      tier: "L1",
      modelLabel: "GPT-5.4 Mini",
      source: "thread_override",
      sourceLabel: "This thread",
      isThreadOverride: true,
    });
    expect(l0View?.resolvedTiers[1]).toMatchObject({
      tier: "L2",
      modelLabel: "Follows current",
      source: "root_thread",
      isThreadOverride: false,
    });

    const l1View = resolveOverviewNodeCoordinatorView({
      node: {
        depth: 1,
        modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4-mini" },
        coordinatorMode: {
          enabled: true,
          templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          tierModelOverrides: {
            L2: { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" },
          },
        },
      },
      projectId: ProjectId.make("project-1"),
      settings: DEFAULT_UNIFIED_SETTINGS,
      providers,
      uiText,
    });

    expect(l1View).not.toBeNull();
    expect(l1View?.tier).toBe("L1");
    expect(l1View?.roleLabel).toBe("Sub-Coordinator");
    expect(l1View?.overrideSummary).toBe("L2: Claude Haiku 4.5");
    expect(l1View?.resolvedTiers.map((tier) => tier.tier)).toEqual(["L2"]);
  });

  it("handles empty providers, unknown template IDs, explicit follow-current overrides, and L2 nodes gracefully", () => {
    const customTemplateId = CoordinatorRoleTemplateId.make("custom-drama-team");
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      coordinatorRoleTemplates: {
        [customTemplateId]: {
          name: "Short Drama Studio",
          description: "Batch episode workflow",
          mode: "general" as const,
          delegationStrategy: "tiered" as const,
          preferDelegation: true,
          instructions: "",
          tierModels: {
            L0: null,
            L1: { instanceId: CODEX_INSTANCE, model: "gpt-5.4-mini" },
            L2: { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" },
          },
        },
      },
    };

    const viewWithNoProviders = resolveOverviewNodeCoordinatorView({
      node: {
        depth: 0,
        modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4" },
        coordinatorMode: {
          enabled: true,
          templateId: customTemplateId,
          tierModelOverrides: {
            L1: null,
          },
        },
      },
      projectId: ProjectId.make("project-1"),
      settings,
      providers: [],
      uiText: (s) => s,
    });

    expect(viewWithNoProviders?.templateName).toBe("Short Drama Studio");
    expect(viewWithNoProviders?.overrideSummary).toBe("L1: Follows current");
    expect(viewWithNoProviders?.resolvedTiers[0]).toMatchObject({
      tier: "L1",
      modelLabel: "Follows current",
      sourceLabel: "This thread",
      isThreadOverride: true,
    });
    expect(viewWithNoProviders?.resolvedTiers[1]).toMatchObject({
      tier: "L2",
      modelLabel: "claude-haiku-4-5",
      source: "template_configured",
      sourceLabel: "Pinned",
    });

    expect(
      isOverviewGeneralScene({
        overview: {
          nodes: [
            {
              depth: 0,
              coordinatorMode: {
                enabled: true,
                templateId: customTemplateId,
              },
            } as never,
          ],
        },
        settings,
      }),
    ).toBe(true);

    expect(
      resolveOverviewNodeCoordinatorView({
        node: {
          depth: 2,
          modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4" },
          coordinatorMode: {
            enabled: true,
            templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
          },
        },
        projectId: null,
        settings,
        providers: [],
        uiText: (s) => s,
      }),
    ).toBeNull();
  });
});

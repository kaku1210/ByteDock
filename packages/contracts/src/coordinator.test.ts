import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE,
  BUILT_IN_COORDINATOR_ROLE_TEMPLATES,
  BUILT_IN_GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE,
  COORDINATOR_ROLE_TEMPLATE_MAX_COUNT,
  CoordinatorRoleTemplateConfig,
  CoordinatorRoleTemplateId,
  CoordinatorRoleTemplatesMap,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  isBuiltInCoordinatorRoleTemplateId,
  isCoordinatorEligibleThread,
  isSubCoordinatorEligibleThread,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  ThreadCoordinatorMode,
  ThreadId,
} from "./index.ts";

const decodeTemplateId = Schema.decodeSync(CoordinatorRoleTemplateId);
const decodeTemplateConfig = Schema.decodeUnknownSync(CoordinatorRoleTemplateConfig);
const decodeTemplatesMap = Schema.decodeUnknownSync(CoordinatorRoleTemplatesMap);
const decodeThreadCoordinatorMode = Schema.decodeUnknownSync(ThreadCoordinatorMode);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("coordinator contracts", () => {
  it("provides built-in code and general-batch templates with follow-current (null) tier models", () => {
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE).toMatchObject({
      id: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      builtIn: true,
      mode: "code",
      preferDelegation: true,
      delegationStrategy: "tiered",
      tierModels: DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
    });
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE.tierModels.L0).toBeNull();
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE.tierModels.L1).toBeNull();
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE.tierModels.L2).toBeNull();

    expect(BUILT_IN_GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE).toMatchObject({
      id: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      name: "General Batch Collaboration",
      builtIn: true,
      mode: "general",
      preferDelegation: true,
      tierModels: DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
    });
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATES.map((template) => template.id)).toEqual([
      DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    ]);
    expect(isBuiltInCoordinatorRoleTemplateId(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID)).toBe(true);
    expect(isBuiltInCoordinatorRoleTemplateId(GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID)).toBe(
      true,
    );
    expect(isBuiltInCoordinatorRoleTemplateId("custom-tpl")).toBe(false);
  });

  it("applies defaults when decoding minimal CoordinatorRoleTemplateConfig and ThreadCoordinatorMode", () => {
    const decoded = decodeTemplateConfig({ name: "  Architecture Lead  " });
    expect(decoded).toEqual({
      name: "Architecture Lead",
      description: "",
      mode: "code",
      tierModels: { L0: null, L1: null, L2: null },
      preferDelegation: true,
      delegationStrategy: "tiered",
      instructions: "",
    });

    const generalDecoded = decodeTemplateConfig({
      name: "Batch Drama Production",
      mode: "general",
    });
    expect(generalDecoded.mode).toBe("general");

    const mode = decodeThreadCoordinatorMode({ enabled: true });
    expect(mode).toEqual({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    const modeWithOverrides = decodeThreadCoordinatorMode({
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L1: { instanceId: ProviderInstanceId.make("provider-a"), model: "model-b" },
        L2: null,
      },
    });
    expect(modeWithOverrides).toEqual({
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L1: { instanceId: "provider-a", model: "model-b" },
        L2: null,
      },
    });
  });

  it("enforces template id, count, and length constraints", () => {
    expect(() => decodeTemplateId("")).toThrow();
    expect(() => decodeTemplateId("bad\nid")).toThrow();
    expect(() => decodeTemplateConfig({ name: "   " })).toThrow();

    const tooMany: Record<string, { name: string }> = {};
    for (let i = 0; i < COORDINATOR_ROLE_TEMPLATE_MAX_COUNT + 1; i += 1) {
      tooMany[`tpl-${i}`] = { name: `Template ${i}` };
    }
    expect(() => decodeTemplatesMap(tooMany)).toThrow();
  });

  it("defaults ServerSettings coordinator fields and supports nullable patch entries", () => {
    const settings = decodeServerSettings({});
    expect(settings.coordinatorRoleTemplates).toEqual({});
    expect(settings.defaultCoordinatorRoleTemplateId).toBe(DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID);
    expect(DEFAULT_SERVER_SETTINGS.coordinatorRoleTemplates).toEqual({});
    expect(DEFAULT_SERVER_SETTINGS.defaultCoordinatorRoleTemplateId).toBe(
      DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    );

    const architectId = CoordinatorRoleTemplateId.make("architect");
    const removedId = CoordinatorRoleTemplateId.make("removed");
    const patch = decodeServerSettingsPatch({
      defaultCoordinatorRoleTemplateId: architectId,
      coordinatorRoleTemplates: {
        [architectId]: {
          name: "Architect",
          tierModels: {
            L0: { instanceId: ProviderInstanceId.make("provider-a"), model: "model-top" },
            L1: null,
            L2: null,
          },
        },
        [removedId]: null,
      },
    });
    expect(patch.defaultCoordinatorRoleTemplateId).toBe(architectId);
    expect(patch.coordinatorRoleTemplates?.[removedId]).toBeNull();
    expect(patch.coordinatorRoleTemplates?.[architectId]?.mode).toBe("code");
    expect(patch.coordinatorRoleTemplates?.[architectId]?.tierModels.L0).toEqual({
      instanceId: "provider-a",
      model: "model-top",
    });
  });

  it("restricts isCoordinatorEligibleThread strictly to persistent L0 root threads", () => {
    const rootId = ThreadId.make("thread:root");
    const childId = ThreadId.make("thread:child");

    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: rootId,
        },
      }),
    ).toBe(true);

    // Plain user forks are listed top-level roots and eligible as L0 coordinators.
    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "fork",
          rootThreadId: childId,
        },
      }),
    ).toBe(true);

    // Subtasks, subagents, side chats, temporary threads, and remotely delegated threads are not L0.
    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
        },
      }),
    ).toBe(false);

    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subagent",
          rootThreadId: rootId,
        },
      }),
    ).toBe(false);

    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "fork",
          rootThreadId: rootId,
          sideChat: true,
        },
      }),
    ).toBe(false);

    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: rootId,
          temporary: true,
        },
      }),
    ).toBe(false);

    expect(
      isCoordinatorEligibleThread({
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: rootId,
        },
        delegatedFrom: {
          environmentId: EnvironmentId.make("env:remote"),
          threadId: ThreadId.make("thread:remote-parent"),
          title: "Remote Parent",
        },
      }),
    ).toBe(false);
  });

  it("restricts isSubCoordinatorEligibleThread strictly to persistent L1 direct children", () => {
    const rootId = ThreadId.make("thread:root");
    const l1Id = ThreadId.make("thread:l1");

    // Persistent L1 subtask and app subagent are eligible.
    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
        },
      }),
    ).toBe(true);

    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subagent",
          rootThreadId: rootId,
        },
      }),
    ).toBe(true);

    // L0 root is not L1 sub-coordinator.
    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: rootId,
        },
      }),
    ).toBe(false);

    // L2 grandchild (parentThreadId !== rootThreadId) is rejected.
    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: l1Id,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
        },
      }),
    ).toBe(false);

    // Side chat, temporary, workflow step, and remotely delegated L1 are rejected.
    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
          sideChat: true,
        },
      }),
    ).toBe(false);

    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
          temporary: true,
        },
      }),
    ).toBe(false);

    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
          workflowStep: true,
        },
      }),
    ).toBe(false);

    expect(
      isSubCoordinatorEligibleThread({
        lineage: {
          parentThreadId: rootId,
          relationshipToParent: "subtask",
          rootThreadId: rootId,
        },
        delegatedFrom: {
          environmentId: EnvironmentId.make("env:remote"),
          threadId: ThreadId.make("thread:remote-parent"),
          title: "Remote Parent",
        },
      }),
    ).toBe(false);
  });
});

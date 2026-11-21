import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_COORDINATOR_ROLE_TEMPLATE,
  COORDINATOR_ROLE_TEMPLATE_MAX_COUNT,
  CoordinatorRoleTemplateConfig,
  CoordinatorRoleTemplateId,
  CoordinatorRoleTemplatesMap,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  isCoordinatorEligibleThread,
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
  it("provides a built-in default template with dynamic (null) tier models", () => {
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE).toMatchObject({
      id: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      builtIn: true,
      preferDelegation: true,
      delegationStrategy: "tiered",
      tierModels: DEFAULT_COORDINATOR_TIER_MODEL_SELECTIONS,
    });
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE.tierModels.L0).toBeNull();
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE.tierModels.L1).toBeNull();
    expect(BUILT_IN_COORDINATOR_ROLE_TEMPLATE.tierModels.L2).toBeNull();
  });

  it("applies defaults when decoding minimal CoordinatorRoleTemplateConfig and ThreadCoordinatorMode", () => {
    const decoded = decodeTemplateConfig({ name: "  Architecture Lead  " });
    expect(decoded).toEqual({
      name: "Architecture Lead",
      description: "",
      tierModels: { L0: null, L1: null, L2: null },
      preferDelegation: true,
      delegationStrategy: "tiered",
      instructions: "",
    });

    const mode = decodeThreadCoordinatorMode({ enabled: true });
    expect(mode).toEqual({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
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
});

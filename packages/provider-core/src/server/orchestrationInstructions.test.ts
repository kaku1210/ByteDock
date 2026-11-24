import { assert, describe, it } from "@effect/vitest";
import {
  CoordinatorRoleTemplateId,
  ProviderInstanceId,
  type ResolvedCoordinatorConfiguration,
} from "@t3tools/contracts";

import {
  buildCoordinatorInstructions,
  COORDINATOR_INSTRUCTIONS_MAX_BYTES,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
  wrapInlineCoordinatorInstructions,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

function makeCoordinatorConfig(
  overrides?: Partial<ResolvedCoordinatorConfiguration>,
): ResolvedCoordinatorConfiguration {
  const providerA = ProviderInstanceId.make("provider-alpha");
  const providerB = ProviderInstanceId.make("provider-beta");
  const templateId = CoordinatorRoleTemplateId.make("default");
  return {
    template: {
      id: templateId,
      builtIn: true,
      name: "Default Coordinator",
      description: "Break work down and delegate.",
      mode: "code",
      tierModels: { L0: null, L1: null, L2: null },
      preferDelegation: true,
      delegationStrategy: "tiered",
      instructions: "Always verify tests before reporting back.",
    },
    requestedTemplateId: templateId,
    templateFallbackUsed: false,
    templateFallbackReason: null,
    tiers: {
      L0: {
        tier: "L0",
        modelSelection: { instanceId: providerA, model: "custom-root-model" },
        configuredModelSelection: null,
        source: "root_thread",
        fallbackUsed: false,
        fallbackReason: null,
      },
      L1: {
        tier: "L1",
        modelSelection: { instanceId: providerB, model: "custom-lead-model" },
        configuredModelSelection: { instanceId: providerB, model: "custom-lead-model" },
        source: "template_configured",
        fallbackUsed: false,
        fallbackReason: null,
      },
      L2: {
        tier: "L2",
        modelSelection: null,
        configuredModelSelection: { instanceId: providerA, model: "offline-model" },
        source: "unavailable",
        fallbackUsed: false,
        fallbackReason: "Configured provider is disabled.",
      },
    },
    ...overrides,
  };
}

describe("coordinator instructions", () => {
  it("renders L0 code mode instructions with tier models, unavailable notes, and fallback warning", () => {
    const config = makeCoordinatorConfig({
      requestedTemplateId: CoordinatorRoleTemplateId.make("deleted-template"),
      templateFallbackUsed: true,
      templateFallbackReason: "Template was deleted.",
    });
    const rendered = buildCoordinatorInstructions(config);

    assert.include(rendered, "## T3 Code L0 Coordinator Mode (Default Coordinator)");
    assert.include(rendered, "Prefer delegating research, implementation, tests, and bulk edits");
    assert.include(rendered, "`plannedPaths`");
    assert.include(rendered, "`t3_worktree_coordinate`");
    assert.include(rendered, "`escalationRequestId`");
    assert.include(rendered, "`provider-alpha/custom-root-model` [root_thread]");
    assert.include(rendered, "`provider-beta/custom-lead-model` [template_configured]");
    assert.include(rendered, "- L2 (worker): unavailable (Configured provider is disabled.)");
    assert.include(rendered, "requested template `deleted-template` was unavailable");
    assert.include(rendered, "Always verify tests before reporting back.");
    assert.isAtMost(new TextEncoder().encode(rendered).length, COORDINATOR_INSTRUCTIONS_MAX_BYTES);
  });

  it("adapts L0 code mode copy when preferDelegation=false and custom instructions are empty", () => {
    const base = makeCoordinatorConfig();
    const rendered = buildCoordinatorInstructions({
      ...base,
      template: {
        ...base.template,
        preferDelegation: false,
        instructions: "",
      },
    });

    assert.include(rendered, "direct execution is acceptable for small focused tasks");
    assert.notInclude(rendered, "Template guidance:");
  });

  it("omits code/worktree wording in general scene mode for both L0 and L1", () => {
    const base = makeCoordinatorConfig();
    const generalConfig: ResolvedCoordinatorConfiguration = {
      ...base,
      template: {
        ...base.template,
        name: "General Batch Collaboration",
        mode: "general",
        instructions: "Keep output artifacts structured per episode.",
      },
      tiers: {
        ...base.tiers,
        L2: {
          tier: "L2",
          modelSelection: {
            instanceId: ProviderInstanceId.make("provider-beta"),
            model: "c-model",
          },
          configuredModelSelection: {
            instanceId: ProviderInstanceId.make("provider-beta"),
            model: "c-model",
          },
          source: "template_configured",
          fallbackUsed: false,
          fallbackReason: null,
        },
      },
    };

    const l0General = buildCoordinatorInstructions(generalConfig, { tierView: "L0" });
    assert.include(l0General, "## T3 Code L0 Coordinator Mode (General Batch Collaboration)");
    assert.include(l0General, "batch/general workflow");
    assert.include(l0General, "- L2 (specialist): `provider-beta/c-model` [template_configured]");
    assert.notInclude(l0General, "plannedPaths");
    assert.notInclude(l0General, "t3_worktree_coordinate");
    assert.notInclude(l0General, "worktree");
    assert.notInclude(l0General, "tests");
    assert.include(l0General, "Keep output artifacts structured per episode.");

    const l1General = buildCoordinatorInstructions(generalConfig, { tierView: "L1" });
    assert.include(l1General, "## T3 Code L1 Sub-Coordinator Mode (General Batch Collaboration)");
    assert.include(l1General, "L1 sub-coordinator");
    assert.include(l1General, "- L2 (specialist): `provider-beta/c-model` [template_configured]");
    assert.notInclude(l1General, "L0 (root coordinator)");
    assert.notInclude(l1General, "escalationRequestId");
    assert.notInclude(l1General, "plannedPaths");
    assert.notInclude(l1General, "t3_worktree_coordinate");
    assert.notInclude(l1General, "worktree");
    assert.notInclude(l1General, "tests");
  });

  it("renders L1 sub-coordinator code mode instructions without L0-only lines", () => {
    const base = makeCoordinatorConfig();
    const l1Code = buildCoordinatorInstructions(base, { tierView: "L1" });
    assert.include(l1Code, "## T3 Code L1 Sub-Coordinator Mode (Default Coordinator)");
    assert.include(l1Code, "L1 sub-coordinator");
    assert.include(l1Code, "`plannedPaths`");
    assert.include(l1Code, "`t3_worktree_coordinate`");
    assert.notInclude(l1Code, "L0 (coordinator)");
    assert.notInclude(l1Code, "escalationRequestId");
    assert.isAtMost(new TextEncoder().encode(l1Code).length, COORDINATOR_INSTRUCTIONS_MAX_BYTES);
  });

  it("clamps long CJK custom instructions safely within COORDINATOR_INSTRUCTIONS_MAX_BYTES", () => {
    const base = makeCoordinatorConfig();
    const longCjk = "协调器模板自定义指令：拆分任务并委派给合适层级。".repeat(200);
    const rendered = buildCoordinatorInstructions({
      ...base,
      template: {
        ...base.template,
        instructions: longCjk,
      },
    });
    const bytes = new TextEncoder().encode(rendered).length;

    assert.isAtMost(bytes, COORDINATOR_INSTRUCTIONS_MAX_BYTES);
    assert.isTrue(rendered.endsWith("…"));
    // Verify valid UTF-16 (no unpaired surrogates).
    assert.equal(
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(rendered)),
      rendered,
    );
  });

  it("wraps inline coordinator instructions in a dedicated tag", () => {
    const wrapped = wrapInlineCoordinatorInstructions("  ## Title\nBody  ");
    assert.equal(
      wrapped,
      "<t3_code_coordinator_instructions>\n## Title\nBody\n</t3_code_coordinator_instructions>",
    );
  });
});

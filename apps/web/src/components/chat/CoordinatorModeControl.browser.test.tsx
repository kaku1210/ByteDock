import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ThreadCoordinatorMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { UiLanguageContext } from "../../i18n/useUiLanguage";

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => routerMocks.navigate) as never,
}));

import { CoordinatorModeControl } from "./CoordinatorModeControl";

function makeProvider(input: {
  instanceId: string;
  displayName?: string;
  models: ReadonlyArray<{ slug: string; name: string }>;
}): ServerProvider {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: input.displayName ?? input.instanceId,
    enabled: true,
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

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  makeProvider({
    instanceId: "inst-alpha",
    displayName: "Alpha Provider",
    models: [
      { slug: "vendor-flagship-pro", name: "Vendor Flagship Pro" },
      { slug: "vendor-balanced-standard", name: "Vendor Balanced Standard" },
      { slug: "vendor-fast-mini", name: "Vendor Fast Mini" },
    ],
  }),
];

const ALPHA_INSTANCE_ID = ProviderInstanceId.make("inst-alpha");
const CUSTOM_TEMPLATE_ID = CoordinatorRoleTemplateId.make("architect-review");

const SETTINGS_WITH_CUSTOM_TEMPLATE: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  coordinatorRoleTemplates: {
    [CUSTOM_TEMPLATE_ID]: {
      name: "Architect Review",
      description: "Prioritizes deep design review before delegating subtasks.",
      mode: "code",
      preferDelegation: true,
      delegationStrategy: "tiered",
      tierModels: {
        L0: null,
        L1: createModelSelection(ALPHA_INSTANCE_ID, "vendor-balanced-standard"),
        L2: createModelSelection(ALPHA_INSTANCE_ID, "removed-legacy-model"),
      },
      instructions: "",
    },
  },
};

describe("CoordinatorModeControl", () => {
  it("shows a compact summary when disabled, reveals 3-row follow-current/pinned/unavailable tier table when enabled, switches template, and navigates to settings", async () => {
    routerMocks.navigate.mockReset();
    const onChange = vi.fn<(next: ThreadCoordinatorMode) => void>();
    const rootModelSelection = createModelSelection(ALPHA_INSTANCE_ID, "vendor-flagship-pro");

    await using screen = await render(
      <StrictMode>
        <CoordinatorModeControl
          coordinatorMode={{ enabled: false, templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={onChange}
        />
      </StrictMode>,
    );

    const trigger = page.getByTestId("coordinator-mode-trigger");
    await expect.element(trigger).toHaveAttribute("data-coordinator-enabled", "false");
    await expect.element(trigger).toHaveTextContent("Coordinator");
    await userEvent.click(trigger);

    await expect.element(page.getByTestId("coordinator-mode-popover")).toBeVisible();
    await expect.element(page.getByTestId("coordinator-mode-disabled-summary")).toBeVisible();
    expect(document.querySelector('[data-testid="coordinator-preview-tiers"]')).toBeNull();

    // Toggle Task Coordinator Mode on
    await userEvent.click(page.getByTestId("coordinator-mode-toggle"));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    // Re-render as enabled -> shows compact 3-row follow-current tier table + Scene footer
    await screen.rerender(
      <StrictMode>
        <CoordinatorModeControl
          coordinatorMode={{ enabled: true, templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={onChange}
        />
      </StrictMode>,
    );

    await expect.element(trigger).toHaveTextContent("Coordinator");
    await expect
      .element(page.getByTestId("coordinator-preview-model-L0"))
      .toHaveTextContent("Vendor Flagship Pro");
    await expect
      .element(page.getByTestId("coordinator-preview-source-L0"))
      .toHaveTextContent("Follows current");
    await expect
      .element(page.getByTestId("coordinator-preview-model-L1"))
      .toHaveTextContent("Vendor Flagship Pro");
    await expect
      .element(page.getByTestId("coordinator-preview-source-L1"))
      .toHaveTextContent("Follows current");
    await expect
      .element(page.getByTestId("coordinator-preview-model-L2"))
      .toHaveTextContent("Vendor Flagship Pro");
    await expect.element(page.getByTestId("coordinator-l2-follow-hint")).toBeVisible();
    expect(page.getByTestId("coordinator-mode-popover").element().textContent).toContain(
      "Scene: Code",
    );

    await userEvent.click(page.getByTestId("coordinator-template-select"));
    await userEvent.click(page.getByTestId(`coordinator-template-option-${CUSTOM_TEMPLATE_ID}`));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: CUSTOM_TEMPLATE_ID,
    });

    // Re-render with custom template -> L1 Pinned, L2 Unavailable with warning reason
    await screen.rerender(
      <StrictMode>
        <CoordinatorModeControl
          coordinatorMode={{ enabled: true, templateId: CUSTOM_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={onChange}
        />
      </StrictMode>,
    );

    await expect
      .element(page.getByTestId("coordinator-preview-source-L1"))
      .toHaveTextContent("Pinned");
    await expect.element(page.getByTestId("coordinator-preview-fallback-L2")).toBeVisible();
    await expect
      .element(page.getByTestId("coordinator-preview-source-L2"))
      .toHaveTextContent("Unavailable");

    // Click Manage templates -> navigates to /settings/threads
    await userEvent.click(page.getByTestId("coordinator-manage-templates"));
    expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/settings/threads" });
  });

  it("renders L1 Sub-Coordinator view with only L2 row and inherits root template on first opt-in", async () => {
    const onChange = vi.fn<(next: ThreadCoordinatorMode) => void>();
    const bModelSelection = createModelSelection(ALPHA_INSTANCE_ID, "vendor-balanced-standard");

    await using screen = await render(
      <UiLanguageContext.Provider value="zh-CN">
        <CoordinatorModeControl
          coordinatorMode={null}
          callerTier="L1"
          inheritedRootTemplateId={GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={bModelSelection}
          onChange={onChange}
        />
      </UiLanguageContext.Provider>,
    );

    const trigger = page.getByTestId("coordinator-mode-trigger");
    await expect.element(trigger).toHaveTextContent("子总控");
    await userEvent.click(trigger);

    const popover = page.getByTestId("coordinator-mode-popover");
    await expect.element(popover).toBeVisible();
    expect(popover.element().textContent).toContain("子总控模式（L1）");

    await userEvent.click(page.getByTestId("coordinator-mode-toggle"));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    await screen.rerender(
      <UiLanguageContext.Provider value="zh-CN">
        <CoordinatorModeControl
          coordinatorMode={{
            enabled: true,
            templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          }}
          callerTier="L1"
          inheritedRootTemplateId={GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={bModelSelection}
          onChange={onChange}
        />
      </UiLanguageContext.Provider>,
    );

    expect(document.querySelector('[data-testid="coordinator-preview-tier-L0"]')).toBeNull();
    expect(document.querySelector('[data-testid="coordinator-preview-tier-L1"]')).toBeNull();
    await expect
      .element(page.getByTestId("coordinator-preview-model-L2"))
      .toHaveTextContent("Vendor Balanced Standard");
    await expect
      .element(page.getByTestId("coordinator-preview-source-L2"))
      .toHaveTextContent("跟随当前");
    const enabledText = popover.element().textContent ?? "";
    expect(enabledText).toContain("通用批量协作");
    expect(enabledText).toContain("场景：通用");
  });

  it("renders natural Chinese copy in zh-CN mode for both disabled and enabled L0 states", async () => {
    const rootModelSelection = createModelSelection(ALPHA_INSTANCE_ID, "vendor-flagship-pro");

    await using screen = await render(
      <UiLanguageContext.Provider value="zh-CN">
        <CoordinatorModeControl
          coordinatorMode={{ enabled: false, templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={vi.fn()}
        />
      </UiLanguageContext.Provider>,
    );

    const trigger = page.getByTestId("coordinator-mode-trigger");
    await expect.element(trigger).toHaveTextContent("总控协作");
    await userEvent.click(trigger);

    const popover = page.getByTestId("coordinator-mode-popover");
    await expect.element(popover).toBeVisible();
    const disabledPopoverText = popover.element().textContent ?? "";
    expect(disabledPopoverText).toContain("任务总控模式");
    expect(disabledPopoverText).toContain("当前：单会话直接执行");
    expect(disabledPopoverText).toContain("管理模板");

    await screen.rerender(
      <UiLanguageContext.Provider value="zh-CN">
        <CoordinatorModeControl
          coordinatorMode={{ enabled: true, templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={vi.fn()}
        />
      </UiLanguageContext.Provider>,
    );

    await expect
      .element(page.getByTestId("coordinator-preview-source-L0"))
      .toHaveTextContent("跟随当前");
    await expect
      .element(page.getByTestId("coordinator-preview-source-L1"))
      .toHaveTextContent("跟随当前");
    const enabledPopoverText = popover.element().textContent ?? "";
    expect(enabledPopoverText).toContain("协作模板");
    expect(enabledPopoverText).toContain("默认总控");
    expect(enabledPopoverText).toContain("场景：代码");
    expect(enabledPopoverText).toContain("总控拆解");
    expect(enabledPopoverText).toContain("模块负责");
    expect(enabledPopoverText).toContain("轻量执行");
  });

  it("lets L0 and L1 pick per-thread tier models inline, override pinned template tiers back to follow-current, preserve overrides on toggle, and reset to template", async () => {
    const onChange = vi.fn<(next: ThreadCoordinatorMode) => void>();
    const rootModelSelection = createModelSelection(ALPHA_INSTANCE_ID, "vendor-flagship-pro");

    await using screen = await render(
      <StrictMode>
        <CoordinatorModeControl
          coordinatorMode={{ enabled: true, templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={onChange}
        />
      </StrictMode>,
    );

    await userEvent.click(page.getByTestId("coordinator-mode-trigger"));
    await expect.element(page.getByTestId("coordinator-mode-popover")).toBeVisible();
    expect(document.querySelector('[data-testid="coordinator-reset-overrides"]')).toBeNull();

    // Pick a custom L2 model directly inside the bottom-bar popover.
    await userEvent.click(page.getByTestId("coordinator-preview-picker-L2"));
    await userEvent.click(
      page.getByTestId(`coordinator-preview-option-L2-${ALPHA_INSTANCE_ID}-vendor-fast-mini`),
    );
    const expectedWithL2Override: ThreadCoordinatorMode = {
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L2: createModelSelection(ALPHA_INSTANCE_ID, "vendor-fast-mini"),
      },
    };
    expect(onChange).toHaveBeenLastCalledWith(expectedWithL2Override);

    await screen.rerender(
      <StrictMode>
        <CoordinatorModeControl
          coordinatorMode={expectedWithL2Override}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={onChange}
        />
      </StrictMode>,
    );

    await expect
      .element(page.getByTestId("coordinator-preview-model-L2"))
      .toHaveTextContent("Vendor Fast Mini");
    await expect
      .element(page.getByTestId("coordinator-preview-source-L2"))
      .toHaveTextContent("This thread");
    await expect.element(page.getByTestId("coordinator-reset-overrides")).toBeVisible();

    // Toggling off preserves per-thread tierModelOverrides.
    await userEvent.click(page.getByTestId("coordinator-mode-toggle"));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: false,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L2: createModelSelection(ALPHA_INSTANCE_ID, "vendor-fast-mini"),
      },
    });

    // Resetting overrides clears tierModelOverrides cleanly.
    await userEvent.click(page.getByTestId("coordinator-reset-overrides"));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    // On a pinned template (L1 pinned), user can override L1 back to Follow current thread.
    await screen.rerender(
      <StrictMode>
        <CoordinatorModeControl
          coordinatorMode={{ enabled: true, templateId: CUSTOM_TEMPLATE_ID }}
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={rootModelSelection}
          onChange={onChange}
        />
      </StrictMode>,
    );
    await userEvent.click(page.getByTestId("coordinator-preview-picker-L1"));
    await userEvent.click(page.getByTestId("coordinator-preview-option-L1-follow"));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: CUSTOM_TEMPLATE_ID,
      tierModelOverrides: {
        L1: null,
      },
    });

    // In L1 Sub-Coordinator mode, user can override L2 inline too.
    await screen.rerender(
      <UiLanguageContext.Provider value="zh-CN">
        <CoordinatorModeControl
          coordinatorMode={{
            enabled: true,
            templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
          }}
          callerTier="L1"
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={createModelSelection(ALPHA_INSTANCE_ID, "vendor-balanced-standard")}
          onChange={onChange}
        />
      </UiLanguageContext.Provider>,
    );
    await userEvent.click(page.getByTestId("coordinator-mode-trigger"));
    await expect.element(page.getByTestId("coordinator-mode-popover")).toBeVisible();
    await userEvent.click(page.getByTestId("coordinator-preview-picker-L2"));
    await userEvent.click(
      page.getByTestId(`coordinator-preview-option-L2-${ALPHA_INSTANCE_ID}-vendor-flagship-pro`),
    );
    const expectedL1Override: ThreadCoordinatorMode = {
      enabled: true,
      templateId: GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
      tierModelOverrides: {
        L2: createModelSelection(ALPHA_INSTANCE_ID, "vendor-flagship-pro"),
      },
    };
    expect(onChange).toHaveBeenLastCalledWith(expectedL1Override);

    await screen.rerender(
      <UiLanguageContext.Provider value="zh-CN">
        <CoordinatorModeControl
          coordinatorMode={expectedL1Override}
          callerTier="L1"
          settings={SETTINGS_WITH_CUSTOM_TEMPLATE}
          providers={PROVIDERS}
          projectId={null}
          rootModelSelection={createModelSelection(ALPHA_INSTANCE_ID, "vendor-balanced-standard")}
          onChange={onChange}
        />
      </UiLanguageContext.Provider>,
    );
    await expect
      .element(page.getByTestId("coordinator-preview-source-L2"))
      .toHaveTextContent("本会话");
    await expect
      .element(page.getByTestId("coordinator-reset-overrides"))
      .toHaveTextContent("恢复模板默认");
  });
});

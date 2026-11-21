import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  DEFAULT_SERVER_SETTINGS,
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
      preferDelegation: true,
      delegationStrategy: "tiered",
      tierModels: {
        L0: null,
        L1: null,
        L2: createModelSelection(ALPHA_INSTANCE_ID, "removed-legacy-model"),
      },
      instructions: "",
    },
  },
};

describe("CoordinatorModeControl", () => {
  it("opens the popover, shows live L0/L1/L2 tier preview, toggles mode, selects template, and navigates to settings", async () => {
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
    await userEvent.click(trigger);

    await expect.element(page.getByTestId("coordinator-mode-popover")).toBeVisible();
    await expect
      .element(page.getByTestId("coordinator-preview-model-L0"))
      .toHaveTextContent("Alpha Provider · Vendor Flagship Pro");
    await expect
      .element(page.getByTestId("coordinator-preview-model-L1"))
      .toHaveTextContent("Alpha Provider · Vendor Balanced Standard");
    await expect
      .element(page.getByTestId("coordinator-preview-model-L2"))
      .toHaveTextContent("Alpha Provider · Vendor Fast Mini");

    // Toggle L0 Coordinator Mode on
    await userEvent.click(page.getByTestId("coordinator-mode-toggle"));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
    });

    // Re-render as enabled and switch to custom template
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

    await userEvent.click(page.getByTestId("coordinator-template-select"));
    await userEvent.click(page.getByTestId(`coordinator-template-option-${CUSTOM_TEMPLATE_ID}`));
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      templateId: CUSTOM_TEMPLATE_ID,
    });

    // Re-render with custom template that has an unavailable L2 override -> displays fallback warning
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

    await expect.element(page.getByTestId("coordinator-preview-fallback-L2")).toBeVisible();
    await expect
      .element(page.getByTestId("coordinator-preview-source-L2"))
      .toHaveTextContent("Fallback");

    // Click Manage role templates -> navigates to /settings/threads
    await userEvent.click(page.getByTestId("coordinator-manage-templates"));
    expect(routerMocks.navigate).toHaveBeenCalledWith({ to: "/settings/threads" });
  });
});

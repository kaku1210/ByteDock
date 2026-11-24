import {
  CoordinatorRoleTemplateId,
  DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID,
  EnvironmentId,
  GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";

const ENV_ID = EnvironmentId.make("env-local");

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

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentId: ENV_ID },
    environment: {
      environmentId: ENV_ID,
      serverConfig: { environment: { environmentId: ENV_ID } },
    },
    connectedEnvironments: [{ environmentId: ENV_ID }],
    targets: [{ settings: state.settings }],
    target: { settings: state.settings },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map([[ENV_ID, PROVIDERS]]),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, control, resetAction, children }) => (
    <div>
      <h3>{title}</h3>
      {description ? <div>{description}</div> : null}
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingsSection: (({
    headerAction,
    children,
  }: {
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {headerAction}
      {children}
    </div>
  )) as never,
}));

import { CoordinatorRoleTemplatesSettings } from "./CoordinatorRoleTemplatesSettings";

function applySettingsPatch(current: UnifiedSettings, patch: ScopedSettingsPatch): UnifiedSettings {
  const nextTemplates = { ...current.coordinatorRoleTemplates };
  if (patch.coordinatorRoleTemplates) {
    for (const [key, value] of Object.entries(patch.coordinatorRoleTemplates)) {
      const templateId = key as CoordinatorRoleTemplateId;
      if (value === null) {
        delete nextTemplates[templateId];
      } else if (value !== undefined) {
        nextTemplates[templateId] = value;
      }
    }
  }
  return {
    ...current,
    ...(patch.defaultCoordinatorRoleTemplateId !== undefined
      ? { defaultCoordinatorRoleTemplateId: patch.defaultCoordinatorRoleTemplateId }
      : {}),
    coordinatorRoleTemplates: nextTemplates,
  };
}

const content = () => (
  <StrictMode>
    <CoordinatorRoleTemplatesSettings />
  </StrictMode>
);

async function setup(initialSettings?: Partial<UnifiedSettings>) {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    defaultModelSelection: createModelSelection(
      ProviderInstanceId.make("inst-alpha"),
      "vendor-flagship-pro",
    ),
    ...initialSettings,
  };
  const screen = await render(content());
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.settings = applySettingsPatch(state.settings, patch);
    void screen.rerender(content());
  });
  return screen;
}

describe("CoordinatorRoleTemplatesSettings", () => {
  it("renders both built-in templates (default & general-batch) with deterministic follow-current L0/L1/L2 preview", async () => {
    await using _screen = await setup();

    await expect
      .element(page.getByTestId(`coordinator-template-row-${DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID}`))
      .toBeVisible();
    await expect
      .element(
        page.getByTestId(`coordinator-template-row-${GENERAL_BATCH_COORDINATOR_ROLE_TEMPLATE_ID}`),
      )
      .toBeVisible();
    await expect
      .element(page.getByTestId("settings-coordinator-preview-model-L0"))
      .toHaveTextContent("Alpha Provider · Vendor Flagship Pro");
    await expect
      .element(page.getByTestId("settings-coordinator-preview-model-L1"))
      .toHaveTextContent("Alpha Provider · Vendor Flagship Pro");
    await expect
      .element(page.getByTestId("settings-coordinator-preview-source-L1"))
      .toHaveTextContent("Follows current");
    await expect
      .element(page.getByTestId("settings-coordinator-preview-model-L2"))
      .toHaveTextContent("Alpha Provider · Vendor Flagship Pro");
  });

  it("creates, pins/unpins a tier override, switches scene mode to General, previews, and deletes a custom role template", async () => {
    await using _screen = await setup();

    await userEvent.click(page.getByTestId("coordinator-new-template-button"));
    await expect.element(page.getByTestId("coordinator-template-editor-dialog")).toBeVisible();

    await userEvent.fill(
      page.getByTestId("coordinator-template-name-input"),
      "Release Coordinator",
    );
    await expect
      .element(page.getByTestId("coordinator-template-id-input"))
      .toHaveValue("release-coordinator");

    // Pin L2 tier model and check editor live preview reflects template_configured ("Pinned")
    await userEvent.click(page.getByTestId("coordinator-template-tier-override-L2"));
    await expect
      .element(page.getByTestId("editor-coordinator-preview-source-L2"))
      .toHaveTextContent("Pinned");

    // Switch back to Follow current
    await userEvent.click(page.getByTestId("coordinator-template-tier-auto-L2"));
    await expect
      .element(page.getByTestId("editor-coordinator-preview-source-L2"))
      .toHaveTextContent("Follows current");

    // Switch scene mode to General
    await userEvent.click(page.getByTestId("coordinator-template-scene-mode-select"));
    await userEvent.click(page.getByRole("option", { name: "General" }));

    await userEvent.click(page.getByTestId("coordinator-template-save-button"));

    expect(state.updateSettings).toHaveBeenCalledWith({
      coordinatorRoleTemplates: {
        "release-coordinator": expect.objectContaining({
          name: "Release Coordinator",
          mode: "general",
        }),
      },
    });
    await expect
      .element(page.getByTestId("coordinator-template-row-release-coordinator"))
      .toBeVisible();

    // Delete custom template via confirmation dialog
    await userEvent.click(page.getByTestId("coordinator-template-delete-release-coordinator"));
    await userEvent.click(page.getByTestId("coordinator-template-confirm-delete"));

    expect(state.updateSettings).toHaveBeenLastCalledWith({
      coordinatorRoleTemplates: {
        "release-coordinator": null,
      },
    });
  });

  it("resets a customized built-in default template back to defaults", async () => {
    await using _screen = await setup({
      coordinatorRoleTemplates: {
        [CoordinatorRoleTemplateId.make("default")]: {
          name: "Custom Lead",
          description: "Customized built-in coordinator",
          mode: "code",
          preferDelegation: true,
          delegationStrategy: "tiered",
          tierModels: {
            L0: null,
            L1: createModelSelection(
              ProviderInstanceId.make("inst-alpha"),
              "vendor-balanced-standard",
            ),
            L2: null,
          },
          instructions: "",
        },
      },
    });

    await expect
      .element(page.getByTestId("settings-coordinator-preview-source-L1"))
      .toHaveTextContent("Pinned");

    await userEvent.click(page.getByTestId("coordinator-template-reset-default"));
    expect(state.updateSettings).toHaveBeenCalledWith({
      coordinatorRoleTemplates: {
        [DEFAULT_COORDINATOR_ROLE_TEMPLATE_ID]: null,
      },
    });
    await expect
      .element(page.getByTestId("settings-coordinator-preview-source-L1"))
      .toHaveTextContent("Follows current");
  });
});

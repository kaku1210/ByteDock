import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopWindowsDefenderExclusionsState,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasAntigravityProvider,
  shouldShowWindowsDefenderExclusionsPrompt,
} from "./WindowsDefenderExclusionsPrompt";

const BASE_STATE: DesktopWindowsDefenderExclusionsState = {
  supported: true,
  realTimeProtectionEnabled: true,
  verificationSource: "unverified",
  allExcluded: false,
  entries: [
    {
      kind: "antigravity-tools",
      path: "C:\\Users\\demo\\.t3-plus\\tools\\antigravity-acp",
      excluded: false,
    },
    {
      kind: "antigravity-temp",
      path: "C:\\Users\\demo\\.t3-plus\\userdata\\antigravity-tmp",
      excluded: false,
    },
    {
      kind: "app-install",
      path: "D:\\AI Program Files\\T3 Code Plus",
      excluded: false,
    },
  ],
  manualCommand:
    "Add-MpPreference -ExclusionPath @('C:\\Users\\demo\\.t3-plus\\tools\\antigravity-acp')",
  promptDismissed: false,
  lastVerifiedAt: null,
};

function makeProvider(overrides: {
  readonly driver: string;
  readonly installed: boolean;
  readonly enabled: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(overrides.driver),
    driver: ProviderDriverKind.make(overrides.driver),
    enabled: overrides.enabled,
    installed: overrides.installed,
    auth: { status: "authenticated" },
    status: "ready",
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

describe("WindowsDefenderExclusionsPrompt helpers", () => {
  it("detects when Antigravity is installed or enabled in any environment", () => {
    const envId = EnvironmentId.make("local");
    expect(
      hasAntigravityProvider(
        new Map([[envId, [makeProvider({ driver: "codex", installed: true, enabled: true })]]]),
      ),
    ).toBe(false);

    expect(
      hasAntigravityProvider(
        new Map([
          [envId, [makeProvider({ driver: "antigravity", installed: false, enabled: false })]],
        ]),
      ),
    ).toBe(false);

    expect(
      hasAntigravityProvider(
        new Map([
          [envId, [makeProvider({ driver: "antigravity", installed: true, enabled: false })]],
        ]),
      ),
    ).toBe(true);

    expect(
      hasAntigravityProvider(
        new Map([
          [envId, [makeProvider({ driver: "antigravity", installed: false, enabled: true })]],
        ]),
      ),
    ).toBe(true);
  });

  it("only shows the startup prompt when Windows Defender exclusions are missing and Antigravity is present", () => {
    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: BASE_STATE,
        hasAntigravity: true,
        sessionDismissed: false,
      }),
    ).toBe(true);

    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: BASE_STATE,
        hasAntigravity: false,
        sessionDismissed: false,
      }),
    ).toBe(false);

    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: BASE_STATE,
        hasAntigravity: true,
        sessionDismissed: true,
      }),
    ).toBe(false);

    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: { ...BASE_STATE, supported: false },
        hasAntigravity: true,
        sessionDismissed: false,
      }),
    ).toBe(false);

    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: { ...BASE_STATE, allExcluded: true },
        hasAntigravity: true,
        sessionDismissed: false,
      }),
    ).toBe(false);

    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: { ...BASE_STATE, promptDismissed: true },
        hasAntigravity: true,
        sessionDismissed: false,
      }),
    ).toBe(false);

    expect(
      shouldShowWindowsDefenderExclusionsPrompt({
        state: { ...BASE_STATE, realTimeProtectionEnabled: false },
        hasAntigravity: true,
        sessionDismissed: false,
      }),
    ).toBe(false);
  });
});

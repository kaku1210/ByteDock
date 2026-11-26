import type {
  DesktopWindowsDefenderExclusionsState,
  EnvironmentId,
  ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { Settings2Icon, ShieldAlertIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentProviders } from "../state/environments";
import { useDesktopWindowsDefenderExclusions } from "./settings/WindowsDefenderExclusionsSettingsRow";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

export function hasAntigravityProvider(
  providersByEnvironment: ReadonlyMap<EnvironmentId, readonly ServerProvider[]>,
): boolean {
  for (const providers of providersByEnvironment.values()) {
    for (const provider of providers) {
      if (provider.driver === "antigravity" && (provider.installed || provider.enabled)) {
        return true;
      }
    }
  }
  return false;
}

export function shouldShowWindowsDefenderExclusionsPrompt(input: {
  readonly state: DesktopWindowsDefenderExclusionsState | null | undefined;
  readonly hasAntigravity: boolean;
  readonly sessionDismissed: boolean;
}): boolean {
  const { state, hasAntigravity, sessionDismissed } = input;
  if (sessionDismissed || !hasAntigravity || !state?.supported) {
    return false;
  }
  if (state.allExcluded || state.promptDismissed) {
    return false;
  }
  if (state.realTimeProtectionEnabled === false) {
    return false;
  }
  return state.entries.some((entry) => !entry.excluded);
}

/**
 * Startup prompt surfaced on Windows desktop when Antigravity is available/enabled
 * and its runtime/temp/app directories have not yet been added to Windows Defender exclusions.
 */
export function WindowsDefenderExclusionsPrompt() {
  const gt = useGT();
  const navigate = useNavigate();
  const providersByEnvironment = useEnvironmentProviders();
  const { state, applying, dismissing, apply, dismissPrompt } =
    useDesktopWindowsDefenderExclusions();
  const [sessionDismissed, setSessionDismissed] = useState(false);

  const hasAntigravity = hasAntigravityProvider(providersByEnvironment);
  if (
    !shouldShowWindowsDefenderExclusionsPrompt({
      state,
      hasAntigravity,
      sessionDismissed,
    })
  ) {
    return null;
  }

  const missingCount = state!.entries.filter((entry) => !entry.excluded).length;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-90 flex justify-center px-4"
    >
      <div className="pointer-events-auto w-full max-w-2xl shadow-lg [-webkit-app-region:no-drag]">
        <Alert variant="warning" surface="glass" controlAlignment="first-line">
          <ShieldAlertIcon aria-hidden className="size-4 shrink-0" />
          <AlertTitle>
            <T>Exclude Antigravity folders from Windows Defender</T>
          </AlertTitle>
          <AlertDescription>
            <p className="text-xs leading-relaxed">
              {gt(
                "Antigravity is active and {count, plural, one {{count} folder is} other {{count} folders are}} not yet excluded from Windows Defender, which can slow down session startup. Click Add now to configure them with Administrator permission.",
                { count: missingCount },
              )}
            </p>
          </AlertDescription>
          <AlertAction>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="default"
                disabled={applying || dismissing}
                onClick={() => void apply()}
              >
                <ShieldCheckIcon aria-hidden className="size-3.5" />
                {applying ? <T>Applying…</T> : <T>Add now</T>}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={applying}
                onClick={() => void navigate({ to: "/settings/general" })}
              >
                <Settings2Icon aria-hidden className="size-3.5" />
                <T>Settings</T>
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={applying || dismissing}
                onClick={() => void dismissPrompt()}
              >
                <T>Don't ask again</T>
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={applying}
                aria-label={gt("Dismiss for this session")}
                onClick={() => setSessionDismissed(true)}
              >
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </AlertAction>
        </Alert>
      </div>
    </div>
  );
}

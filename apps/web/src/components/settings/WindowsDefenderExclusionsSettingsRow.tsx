import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { DesktopWindowsDefenderExclusionKind } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  desktopWindowsDefenderExclusionsStateAtom,
  getDesktopWindowsDefenderExclusionsBridge,
  refreshDesktopWindowsDefenderExclusionsState,
} from "../../state/desktopWindowsDefenderExclusions";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function formatDefenderErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? (thrownErrorMessage(error, m) ?? error.message) : String(error ?? "");
  if (/cancelled|canceled|1223/i.test(raw)) {
    return m(
      msg("Administrator permission was cancelled. Windows Defender exclusions were not changed."),
    );
  }
  if (raw.trim().length > 0) {
    return raw;
  }
  return m(msg("Failed to update Windows Defender exclusions."));
}

function exclusionKindLabel(
  kind: DesktopWindowsDefenderExclusionKind,
  resolve: MessageResolver = m,
): string {
  switch (kind) {
    case "antigravity-tools":
      return resolve(msg("Antigravity runtime"));
    case "antigravity-temp":
      return resolve(msg("Antigravity temp"));
    case "app-install":
      return resolve(msg("T3 Code install folder"));
  }
}

export function useDesktopWindowsDefenderExclusions() {
  const bridge = getDesktopWindowsDefenderExclusionsBridge();
  const query = useEnvironmentQuery(bridge ? desktopWindowsDefenderExclusionsStateAtom : null);
  const [applying, setApplying] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the copy-feedback timer on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const apply = async (): Promise<boolean> => {
    if (!bridge || applying) return false;
    setApplying(true);
    try {
      await bridge.apply();
      refreshDesktopWindowsDefenderExclusionsState();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: m(msg("Windows Defender exclusions added")),
          description: m(
            msg(
              "Exclusions were added and verified. Future Antigravity startups will skip real-time scans.",
            ),
          ),
        }),
      );
      return true;
    } catch (error: unknown) {
      refreshDesktopWindowsDefenderExclusionsState();
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not add Defender exclusions")),
          description: formatDefenderErrorMessage(error),
        }),
      );
      return false;
    } finally {
      setApplying(false);
    }
  };

  const dismissPrompt = async (): Promise<void> => {
    if (!bridge || dismissing) return;
    setDismissing(true);
    try {
      await bridge.dismissPrompt();
      refreshDesktopWindowsDefenderExclusionsState();
    } catch {
      // Non-fatal: prompt can still be dismissed for the current session.
    } finally {
      setDismissing(false);
    }
  };

  const copyManualCommand = async (): Promise<void> => {
    const command = query.data?.manualCommand;
    if (!command || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: m(msg("PowerShell command copied")),
          description: m(msg("Open PowerShell as Administrator and paste the command to run it.")),
        }),
      );
    } catch {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Copy failed")),
          description: m(msg("Could not write to the clipboard.")),
        }),
      );
    }
  };

  return {
    state: bridge ? query.data : undefined,
    isPending: query.isPending,
    applying,
    dismissing,
    copied,
    apply,
    dismissPrompt,
    copyManualCommand,
  };
}

export function WindowsDefenderExclusionsSettingsRow(props?: {
  readonly useSearchableId?: boolean;
}) {
  const useSearchableId = props?.useSearchableId ?? true;
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const resolve = useMessages();
  const { state, isPending, applying, copied, apply, copyManualCommand } =
    useDesktopWindowsDefenderExclusions();

  if (!state?.supported) return null;

  const missingCount = state.entries.filter((entry) => !entry.excluded).length;
  const statusSummary = state.allExcluded
    ? gt("All folders are excluded from Windows Defender and verified.")
    : state.realTimeProtectionEnabled === false
      ? gt("Windows Defender real-time protection is currently off; you can still add exclusions.")
      : state.verificationSource === "unverified"
        ? gt(
            "Not yet added or verified by T3 Code (Windows requires Administrator permission to read Defender exclusions).",
          )
        : gt(
            "{count, plural, one {{count} folder not yet excluded.} other {{count} folders not yet excluded.}}",
            {
              count: missingCount,
            },
          );

  const rowIdentity = useSearchableId
    ? {
        ...searchableSetting("windows-defender-exclusions"),
        title: gt("Windows Defender exclusions"),
      }
    : {
        title: gt("Windows Defender exclusions"),
      };

  return (
    <SettingsRow
      {...rowIdentity}
      description={gt(
        "Exclude Antigravity runtime, temp, and T3 Code install folders from Windows Defender to speed up startup. Requests Administrator permission (UAC).",
      )}
      status={
        <div className="space-y-2 pt-1">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {state.allExcluded ? (
              <ShieldCheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
            ) : (
              <ShieldAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            )}
            <span>{statusSummary}</span>
          </p>
          <ul className="space-y-1 text-xs">
            {state.entries.map((entry) => (
              <li
                key={entry.path}
                className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 rounded-md border border-border/50 bg-muted/25 px-2 py-1"
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-1.5 text-2xs text-muted-foreground">
                    {exclusionKindLabel(entry.kind, resolve)}
                  </span>
                  <code className="font-mono text-2xs break-all text-foreground">{entry.path}</code>
                </div>
                <span
                  className={
                    entry.excluded
                      ? "inline-flex shrink-0 items-center gap-1 text-2xs text-success"
                      : "shrink-0 text-2xs text-warning"
                  }
                >
                  {entry.excluded ? <CheckCircle2Icon aria-hidden className="size-3" /> : null}
                  {entry.excluded ? <T>Excluded</T> : <T>Pending</T>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      }
      control={
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            size="sm"
            variant={state.allExcluded ? "outline" : "default"}
            disabled={applying || isPending}
            onClick={() => void apply()}
          >
            <ShieldCheckIcon aria-hidden className="size-3.5" />
            {applying ? (
              <T>Applying…</T>
            ) : state.allExcluded ? (
              <T>Re-verify</T>
            ) : (
              <T>Add exclusions</T>
            )}
          </Button>
          {state.manualCommand ? (
            <Button
              size="sm"
              variant="outline"
              disabled={applying}
              title={gt("Copy PowerShell command to run as Administrator")}
              onClick={() => void copyManualCommand()}
            >
              {copied ? (
                <CheckIcon aria-hidden className="size-3.5" />
              ) : (
                <CopyIcon aria-hidden className="size-3.5" />
              )}
              {copied ? <T>Copied</T> : <T>Copy command</T>}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function WindowsDefenderExclusionsSettingsSection() {
  const gt = useGT();
  const { state } = useDesktopWindowsDefenderExclusions();
  if (!state?.supported) return null;

  return (
    <SettingsSection id="windows-performance" title={gt("Windows performance")}>
      <WindowsDefenderExclusionsSettingsRow useSearchableId />
    </SettingsSection>
  );
}

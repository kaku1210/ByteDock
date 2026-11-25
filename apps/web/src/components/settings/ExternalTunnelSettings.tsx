import {
  AuthAccessReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  DEFAULT_EXTERNAL_TUNNEL_SETTINGS,
  type ExternalTunnelCandidate,
  type ExternalTunnelInstallEvent,
  type ExternalTunnelInstalledTool,
  type ExternalTunnelMode,
  type ExternalTunnelScanEvent,
  type ExternalTunnelSettings as ExternalTunnelSettingsValue,
} from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyIcon,
  DownloadIcon,
  FolderSearchIcon,
  NetworkIcon,
  PlayIcon,
  RefreshCwIcon,
  Share2Icon,
  SquareIcon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { useGT, useMessages } from "gt-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PROGRESS_CLASS =
  "h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary";

function healthBadgeVariant(state: string): "success" | "warning" | "error" | "secondary" {
  switch (state) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    case "unhealthy":
      return "error";
    default:
      return "secondary";
  }
}

export function ExternalTunnelSettings() {
  const gt = useGT();
  const resolve = useMessages();
  const environmentId = usePrimaryEnvironmentId();
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const canScanFs = useEnvironmentScope(environmentId, AuthFilesystemReadScope);

  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const savedTunnelSettings: ExternalTunnelSettingsValue =
    serverSettings?.externalTunnel ?? DEFAULT_EXTERNAL_TUNNEL_SETTINGS;

  const statusQuery = useEnvironmentQuery(
    environmentId === null || !canReadAccess
      ? null
      : serverEnvironment.externalTunnelStatus({ environmentId, input: {} }),
    resolve,
  );
  const status = statusQuery.data;

  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const runTunnelAction = useAtomCommand(serverEnvironment.externalTunnelAction, {
    reportFailure: false,
  });
  const runTunnelScan = useAtomCommand(serverEnvironment.externalTunnelScan, {
    reportFailure: false,
  });
  const runTunnelInstall = useAtomCommand(serverEnvironment.externalTunnelInstall, {
    reportFailure: false,
  });
  const runExportBundle = useAtomCommand(serverEnvironment.externalTunnelExportBundle, {
    reportFailure: false,
  });
  const runImportBundle = useAtomCommand(serverEnvironment.externalTunnelImportBundle, {
    reportFailure: false,
  });

  // Editable config form state overlaid on saved serverSettings.externalTunnel
  const [draftPatch, setDraftPatch] = useState<Partial<ExternalTunnelSettingsValue>>({});
  const form: ExternalTunnelSettingsValue = { ...savedTunnelSettings, ...draftPatch };
  const updateForm = (patch: Partial<ExternalTunnelSettingsValue>) =>
    setDraftPatch((prev) => ({ ...prev, ...patch }));
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-scan state
  const [scanPath, setScanPath] = useState("~/.t3/tunnel");
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{
    readonly percent: number;
    readonly scannedDirs: number;
    readonly scannedFiles: number;
    readonly currentDir: string;
    readonly truncated: boolean;
  } | null>(null);
  const [scanCandidates, setScanCandidates] = useState<ReadonlyArray<ExternalTunnelCandidate>>([]);

  // One-click install modal state
  const [installOpen, setInstallOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState<{
    readonly stage: string;
    readonly message: string;
    readonly percent: number;
  } | null>(null);
  const [installedTools, setInstalledTools] = useState<ReadonlyArray<ExternalTunnelInstalledTool>>(
    [],
  );
  const [installDir, setInstallDir] = useState("~/.t3/tunnel");
  const [installMode, setInstallMode] = useState<ExternalTunnelMode>("auto");
  const [installServerAddress, setInstallServerAddress] = useState("");
  const [installSni, setInstallSni] = useState("");
  const [installHy2Auth, setInstallHy2Auth] = useState("");
  const [installFrpToken, setInstallFrpToken] = useState("");
  const [installRemotePort, setInstallRemotePort] = useState("3773");
  const [installLocalPort, setInstallLocalPort] = useState("3773");
  const [installSshTarget, setInstallSshTarget] = useState("");
  const [installHealthUrl, setInstallHealthUrl] = useState("");
  const [installAutoStart, setInstallAutoStart] = useState(false);

  // Multi-host bundle export / import state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportHostName, setExportHostName] = useState("macbook");
  const [exportRemotePort, setExportRemotePort] = useState("3774");
  const [exportSubdomain, setExportSubdomain] = useState("");
  const [exportIncludeCreds, setExportIncludeCreds] = useState(false);
  const [exportResult, setExportResult] = useState<{
    readonly bundleJson: string;
    readonly caddySnippet: string;
    readonly summary: string;
  } | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importDir, setImportDir] = useState("~/.t3/tunnel");
  const [importAutoInstall, setImportAutoInstall] = useState(true);
  const [importAutoStart, setImportAutoStart] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    readonly message: string;
    readonly percent: number;
  } | null>(null);

  const handleSaveSettings = async () => {
    if (environmentId === null) return;
    setSaving(true);
    setActionError(null);
    try {
      await updateSettings({
        externalTunnel: {
          ...form,
          monitorIntervalSec: Math.max(5, Math.min(3600, Number(form.monitorIntervalSec) || 30)),
        },
      });
      setDraftPatch({});
      toastManager.add({ type: "success", title: gt("External tunnel settings saved") });
    } catch (error) {
      setActionError(errorDisplayMessage(error, resolve));
    } finally {
      setSaving(false);
    }
  };

  const handleAction = async (
    action: "start" | "stop" | "restart" | "check" | "acknowledgeAlert",
  ) => {
    if (environmentId === null) return;
    setActionBusy(action);
    setActionError(null);
    try {
      const outcome = await runTunnelAction({ environmentId, input: { action } });
      if (!AsyncResult.isSuccess(outcome)) {
        setActionError(errorDisplayMessage(squashAtomCommandFailure(outcome), resolve));
      }
    } catch (error) {
      setActionError(errorDisplayMessage(error, resolve));
    } finally {
      setActionBusy(null);
    }
  };

  const handleScan = async () => {
    if (environmentId === null) return;
    setScanning(true);
    setActionError(null);
    setScanCandidates([]);
    setScanProgress({
      percent: 0,
      scannedDirs: 0,
      scannedFiles: 0,
      currentDir: scanPath,
      truncated: false,
    });
    try {
      const outcome = await runTunnelScan({
        environmentId,
        input: { searchPath: scanPath.trim() || "~", maxDepth: 5 },
        onEvent: (event: ExternalTunnelScanEvent) => {
          if (event.type === "progress") {
            setScanProgress({
              percent: event.percent,
              scannedDirs: event.scannedDirs,
              scannedFiles: event.scannedFiles,
              currentDir: event.currentDir,
              truncated: false,
            });
            setScanCandidates(event.candidates);
          } else {
            setScanProgress({
              percent: 100,
              scannedDirs: event.scannedDirs,
              scannedFiles: event.scannedFiles,
              currentDir: "",
              truncated: event.truncated,
            });
            setScanCandidates(event.candidates);
          }
        },
      });
      if (!AsyncResult.isSuccess(outcome)) {
        setActionError(errorDisplayMessage(squashAtomCommandFailure(outcome), resolve));
      }
    } catch (error) {
      setActionError(errorDisplayMessage(error, resolve));
    } finally {
      setScanning(false);
    }
  };

  const handleApplyCandidate = (candidate: ExternalTunnelCandidate) => {
    updateForm({
      enabled: true,
      entryPath: candidate.path,
      ...(candidate.suggestedLogPath ? { logPath: candidate.suggestedLogPath } : {}),
    });
    toastManager.add({
      type: "info",
      title: gt("Selected tunnel entry"),
      description: candidate.path,
    });
  };

  const handleOneClickInstall = async () => {
    if (environmentId === null) return;
    setInstalling(true);
    setActionError(null);
    setInstalledTools([]);
    setInstallProgress({ stage: "prepare", message: gt("Starting installer..."), percent: 2 });
    try {
      const outcome = await runTunnelInstall({
        environmentId,
        input: {
          installDir: installDir.trim() || "~/.t3/tunnel",
          tools: ["hysteria", "frpc"],
          mode: installMode,
          ...(installServerAddress.trim() ? { serverAddress: installServerAddress.trim() } : {}),
          ...(installSni.trim() ? { sni: installSni.trim() } : {}),
          ...(installHy2Auth.trim() ? { hy2Auth: installHy2Auth.trim() } : {}),
          ...(installFrpToken.trim() ? { frpToken: installFrpToken.trim() } : {}),
          remotePort: Number.parseInt(installRemotePort, 10) || 3773,
          localPort: Number.parseInt(installLocalPort, 10) || 3773,
          ...(installSshTarget.trim() ? { sshTarget: installSshTarget.trim() } : {}),
          ...(installHealthUrl.trim() ? { healthUrl: installHealthUrl.trim() } : {}),
          autoStart: installAutoStart,
        },
        onEvent: (event: ExternalTunnelInstallEvent) => {
          if (event.type === "progress") {
            setInstallProgress({
              stage: event.stage,
              message: event.message,
              percent: event.percent,
            });
          } else {
            setInstallProgress({
              stage: "complete",
              message: gt("Installation complete."),
              percent: 100,
            });
            setInstalledTools(event.installedTools);
          }
        },
      });
      if (!AsyncResult.isSuccess(outcome)) {
        setActionError(errorDisplayMessage(squashAtomCommandFailure(outcome), resolve));
      } else if (outcome.value?.type === "complete") {
        setDraftPatch({});
        toastManager.add({
          type: "success",
          title: gt("Tunnel tools installed"),
          description: outcome.value.entryPath,
        });
      }
    } catch (error) {
      setActionError(errorDisplayMessage(error, resolve));
    } finally {
      setInstalling(false);
    }
  };

  const handleExportBundle = async () => {
    if (environmentId === null) return;
    setActionError(null);
    try {
      const outcome = await runExportBundle({
        environmentId,
        input: {
          targetHostName: exportHostName.trim() || "new-host",
          remotePort: Number.parseInt(exportRemotePort, 10) || 3774,
          ...(exportSubdomain.trim() ? { subdomain: exportSubdomain.trim() } : {}),
          includeCredentials: exportIncludeCreds,
        },
      });
      if (!AsyncResult.isSuccess(outcome)) {
        setActionError(errorDisplayMessage(squashAtomCommandFailure(outcome), resolve));
      } else {
        setExportResult(outcome.value);
      }
    } catch (error) {
      setActionError(errorDisplayMessage(error, resolve));
    }
  };

  const handleImportBundle = async () => {
    if (environmentId === null || !importJson.trim()) return;
    setImporting(true);
    setActionError(null);
    setImportProgress({ message: gt("Importing host bundle..."), percent: 5 });
    try {
      const outcome = await runImportBundle({
        environmentId,
        input: {
          bundleJson: importJson.trim(),
          installDir: importDir.trim() || "~/.t3/tunnel",
          autoInstallTools: importAutoInstall,
          autoStart: importAutoStart,
        },
        onEvent: (event) => {
          if (event.type === "progress") {
            setImportProgress({ message: event.message, percent: event.percent });
          } else {
            setImportProgress({
              message: gt("Host bundle imported and configured."),
              percent: 100,
            });
            setInstalledTools(event.installedTools);
          }
        },
      });
      if (!AsyncResult.isSuccess(outcome)) {
        setActionError(errorDisplayMessage(squashAtomCommandFailure(outcome), resolve));
      } else if (outcome.value?.type === "complete") {
        setDraftPatch({});
        toastManager.add({
          type: "success",
          title: gt("Host bundle imported"),
          description: outcome.value.entryPath,
        });
      }
    } catch (error) {
      setActionError(errorDisplayMessage(error, resolve));
    } finally {
      setImporting(false);
    }
  };

  const copyText = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({ type: "success", title: gt("Copied {label}", { label }) });
    } catch {
      toastManager.add({ type: "error", title: gt("Could not copy to clipboard") });
    }
  };

  return (
    <SettingsPageContainer>
      <div className="space-y-6">
        {status?.alert ? (
          <Alert variant="error" controlAlignment="first-line">
            <AlertTriangleIcon aria-hidden className="size-4 shrink-0" />
            <AlertTitle>{status.alert.title}</AlertTitle>
            <AlertDescription>
              <div className="space-y-1 text-xs leading-relaxed">
                {status.alert.detail ? (
                  <p className="font-mono break-all opacity-90">{status.alert.detail}</p>
                ) : null}
                <p>{status.alert.hint}</p>
                <p className="opacity-70">
                  {gt("Detected at: {time}", {
                    time: new Date(status.alert.detectedAt).toLocaleString(),
                  })}
                  {status.alert.acknowledgedAt
                    ? ` · ${gt("Acknowledged (global banner muted until next failure)")}`
                    : ` · ${gt("Global banner active until recovered or acknowledged")}`}
                </p>
              </div>
            </AlertDescription>
            <AlertAction>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!canMaintain || actionBusy !== null}
                  onClick={() => void handleAction("restart")}
                >
                  <RefreshCwIcon aria-hidden className="size-3.5" />
                  {gt("Restart")}
                </Button>
                {status.alert.acknowledgedAt === null ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={!canMaintain || actionBusy !== null}
                    onClick={() => void handleAction("acknowledgeAlert")}
                  >
                    {gt("Acknowledge")}
                  </Button>
                ) : null}
              </div>
            </AlertAction>
          </Alert>
        ) : null}

        {actionError ? (
          <Alert variant="error">
            <AlertTriangleIcon aria-hidden className="size-4 shrink-0" />
            <AlertTitle>{gt("Operation failed")}</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        <SettingsSection
          id="external-tunnel-status"
          title={gt("External tunnel status")}
          icon={<NetworkIcon className="size-4" />}
          headerAction={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canMaintain}
                onClick={() => setInstallOpen(true)}
              >
                <DownloadIcon aria-hidden className="size-3.5" />
                {gt("One-click install")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canReadAccess}
                onClick={() => setExportOpen(true)}
              >
                <Share2Icon aria-hidden className="size-3.5" />
                {gt("Add new host")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canMaintain}
                onClick={() => setImportOpen(true)}
              >
                <UploadIcon aria-hidden className="size-3.5" />
                {gt("Import bundle")}
              </Button>
            </div>
          }
        >
          <SettingsRow
            title={gt("Detached tunnel process")}
            description={gt(
              "Runs detached from T3 Code so closing or updating the app will not drop your remote connection.",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={status?.running ? "success" : "secondary"}>
                {status?.running
                  ? gt("Running (PID {pid})", { pid: status.pid ?? 0 })
                  : gt("Stopped")}
              </Badge>
              <Badge variant={healthBadgeVariant(status?.healthState ?? "unknown")}>
                {status?.healthState ?? "unknown"}
                {status?.healthLatencyMs !== null && status?.healthLatencyMs !== undefined
                  ? gt(" · {ms} ms", { ms: status.healthLatencyMs })
                  : ""}
              </Badge>
              {status?.healthStatusCode ? (
                <Badge variant="outline">HTTP {status.healthStatusCode}</Badge>
              ) : null}
            </div>
          </SettingsRow>

          <SettingsRow
            title={gt("Lifecycle controls")}
            description={
              status?.lastCheckedAt
                ? gt("Last checked: {time}", {
                    time: new Date(status.lastCheckedAt).toLocaleTimeString(),
                  })
                : gt("Start, stop, restart, or run an immediate health check.")
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!canMaintain || actionBusy !== null || status?.running}
                onClick={() => void handleAction("start")}
              >
                {actionBusy === "start" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
                {gt("Start")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canMaintain || actionBusy !== null || !status?.running}
                onClick={() => void handleAction("stop")}
              >
                {actionBusy === "stop" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <SquareIcon className="size-3.5" />
                )}
                {gt("Stop")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canMaintain || actionBusy !== null}
                onClick={() => void handleAction("restart")}
              >
                {actionBusy === "restart" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
                {gt("Restart")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!canMaintain || actionBusy !== null}
                onClick={() => void handleAction("check")}
              >
                {actionBusy === "check" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <ActivityIcon className="size-3.5" />
                )}
                {gt("Check now")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          id="external-tunnel-scan"
          title={gt("Auto-detect local tunnel entry")}
          icon={<FolderSearchIcon className="size-4" />}
        >
          <div className="space-y-3 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {gt(
                "Enter an approximate directory (for example ~, C:\\Users\\you, or D:\\Tools). Scanning runs asynchronously in chunks so T3 Code never freezes.",
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={scanPath}
                onChange={(e) => setScanPath(e.target.value)}
                placeholder="~/.t3/tunnel"
                size="compact"
                font="mono"
                className="min-w-60 flex-1"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canScanFs || scanning}
                onClick={() => void handleScan()}
              >
                {scanning ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <FolderSearchIcon className="size-3.5" />
                )}
                {scanning ? gt("Scanning...") : gt("Scan path")}
              </Button>
            </div>

            {scanProgress ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">
                    {scanning
                      ? scanProgress.currentDir
                      : scanProgress.truncated
                        ? gt("Scan complete (limit reached)")
                        : gt("Scan complete")}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {gt("{percent}% · {dirs} dirs · {files} files", {
                      percent: scanProgress.percent,
                      dirs: scanProgress.scannedDirs,
                      files: scanProgress.scannedFiles,
                    })}
                  </span>
                </div>
                <progress
                  aria-label={gt("Tunnel path scan progress")}
                  className={PROGRESS_CLASS}
                  max={100}
                  value={scanProgress.percent}
                />
              </div>
            ) : null}

            {scanCandidates.length > 0 ? (
              <div className="divide-y divide-border/60 rounded-lg border border-border/70">
                {scanCandidates.map((candidate) => (
                  <div
                    key={candidate.path}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          size="sm"
                          variant={candidate.confidence === "high" ? "success" : "secondary"}
                        >
                          {candidate.kind}
                        </Badge>
                        <span className="font-medium text-foreground">{candidate.label}</span>
                      </div>
                      <p className="truncate font-mono text-muted-foreground">{candidate.path}</p>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => handleApplyCandidate(candidate)}
                    >
                      {gt("Use")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : scanProgress && !scanning ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "No tunnel scripts or binaries found under that directory. Use One-click install above to set up Hysteria2 + frpc.",
                )}
              </p>
            ) : null}
          </div>
        </SettingsSection>

        <SettingsSection id="external-tunnel-config" title={gt("Configuration & monitoring")}>
          <SettingsRow
            title={gt("Enable background tunnel monitoring")}
            description={gt(
              "Periodically checks process liveness, log diagnostics (e.g. hy2 auth/TLS errors), and public health URL.",
            )}
          >
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) => updateForm({ enabled: checked })}
            />
          </SettingsRow>

          <SettingsRow
            title={gt("Persistent failure alert banner")}
            description={gt(
              "Keeps a prominent warning banner visible across T3 Code when the tunnel drops or VPS credentials fail, until recovered or acknowledged.",
            )}
          >
            <Switch
              checked={form.alertOnFailure}
              onCheckedChange={(checked) => updateForm({ alertOnFailure: checked })}
            />
          </SettingsRow>

          <div className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">
                  {gt("Entry script or binary path")}
                </span>
                <Input
                  value={form.entryPath}
                  onChange={(e) => updateForm({ entryPath: e.target.value })}
                  placeholder="~/.t3/tunnel/t3-tunnel.ps1"
                  size="compact"
                  font="mono"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">{gt("Optional arguments")}</span>
                <Input
                  value={form.args}
                  onChange={(e) => updateForm({ args: e.target.value })}
                  placeholder={gt("-Mode auto")}
                  size="compact"
                  font="mono"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">{gt("Public health URL")}</span>
                <Input
                  value={form.healthUrl}
                  onChange={(e) => updateForm({ healthUrl: e.target.value })}
                  placeholder="https://t3.example.com/.well-known/t3/environment"
                  size="compact"
                  font="mono"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">{gt("Log file path")}</span>
                <Input
                  value={form.logPath}
                  onChange={(e) => updateForm({ logPath: e.target.value })}
                  placeholder="~/.t3/tunnel/logs/t3-tunnel.log"
                  size="compact"
                  font="mono"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">
                  {gt("Monitor interval (seconds)")}
                </span>
                <Input
                  type="number"
                  min={5}
                  max={3600}
                  value={String(form.monitorIntervalSec)}
                  onChange={(e) =>
                    updateForm({
                      monitorIntervalSec: Number.parseInt(e.target.value, 10) || 30,
                    })
                  }
                  size="compact"
                  font="mono"
                />
              </label>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void handleSaveSettings()}
              >
                {saving ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <CheckCircle2Icon className="size-3.5" />
                )}
                {gt("Save settings")}
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection id="external-tunnel-logs" title={gt("Recent tunnel logs")}>
          <div className="p-4">
            {status?.recentLogs && status.recentLogs.length > 0 ? (
              <pre className="max-h-64 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 font-mono text-2xs leading-relaxed text-foreground">
                {status.recentLogs.join("\n")}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                {gt("No tunnel logs recorded yet. Start the tunnel or configure a log file path.")}
              </p>
            )}
          </div>
        </SettingsSection>
      </div>

      {/* One-Click Install Dialog */}
      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{gt("One-click local tunnel install")}</DialogTitle>
            <DialogDescription>
              {gt(
                "Downloads standalone Hysteria2 + frpc into an external folder (never bundled into T3 Code) and generates a resilient launcher with automatic SSH-over-Hysteria2 fallback if Windows Defender flags frpc.exe.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3 text-xs">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="font-medium">{gt("Install directory")}</span>
                  <Input
                    value={installDir}
                    onChange={(e) => setInstallDir(e.target.value)}
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("Forwarding mode")}</span>
                  <select
                    value={installMode}
                    onChange={(e) => setInstallMode(e.target.value as ExternalTunnelMode)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="auto">{gt("Auto (frpc, fallback to SSH-over-Hy2)")}</option>
                    <option value="ssh">{gt("SSH over Hysteria2 (Defender-safe)")}</option>
                    <option value="frp">{gt("FRP over Hysteria2")}</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("VPS Hysteria2 address")}</span>
                  <Input
                    value={installServerAddress}
                    onChange={(e) => setInstallServerAddress(e.target.value)}
                    placeholder="vps.example.com:443"
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("TLS SNI")}</span>
                  <Input
                    value={installSni}
                    onChange={(e) => setInstallSni(e.target.value)}
                    placeholder="example.com"
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">
                    {gt("Hysteria2 auth (optional if already configured)")}
                  </span>
                  <Input
                    type="password"
                    value={installHy2Auth}
                    onChange={(e) => setInstallHy2Auth(e.target.value)}
                    placeholder="••••••••"
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("FRP token (optional)")}</span>
                  <Input
                    type="password"
                    value={installFrpToken}
                    onChange={(e) => setInstallFrpToken(e.target.value)}
                    placeholder="••••••••"
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("VPS remote port")}</span>
                  <Input
                    value={installRemotePort}
                    onChange={(e) => setInstallRemotePort(e.target.value)}
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("Local T3 port")}</span>
                  <Input
                    value={installLocalPort}
                    onChange={(e) => setInstallLocalPort(e.target.value)}
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("SSH host alias (for fallback)")}</span>
                  <Input
                    value={installSshTarget}
                    onChange={(e) => setInstallSshTarget(e.target.value)}
                    placeholder="my-vps"
                    size="compact"
                    font="mono"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("Health probe URL")}</span>
                  <Input
                    value={installHealthUrl}
                    onChange={(e) => setInstallHealthUrl(e.target.value)}
                    placeholder="https://t3.example.com/.well-known/t3/environment"
                    size="compact"
                    font="mono"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 pt-1">
                <Switch checked={installAutoStart} onCheckedChange={setInstallAutoStart} />
                <span>{gt("Start tunnel automatically after install")}</span>
              </label>

              {installProgress ? (
                <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{installProgress.message}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {installProgress.percent}%
                    </span>
                  </div>
                  <progress
                    aria-label={gt("Tunnel install progress")}
                    className={PROGRESS_CLASS}
                    max={100}
                    value={installProgress.percent}
                  />
                </div>
              ) : null}

              {installedTools.length > 0 ? (
                <div className="space-y-1.5 rounded-lg border border-border/70 p-3">
                  {installedTools.map((tool) => (
                    <div key={tool.tool} className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Badge variant={tool.blockedByAv ? "warning" : "success"}>
                          {tool.tool}{" "}
                          {tool.version ?? (tool.blockedByAv ? gt("AV blocked") : gt("OK"))}
                        </Badge>
                        <span className="truncate font-mono text-2xs text-muted-foreground">
                          {tool.path}
                        </span>
                      </div>
                      {tool.note ? (
                        <p className="text-2xs text-warning-foreground">{tool.note}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setInstallOpen(false)}>
              {gt("Close")}
            </Button>
            <Button
              type="button"
              disabled={installing}
              onClick={() => void handleOneClickInstall()}
            >
              {installing ? (
                <Spinner className="size-3.5" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
              {installing ? gt("Installing...") : gt("Install now")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Export New-Host Bundle Dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{gt("Export configuration for a new host")}</DialogTitle>
            <DialogDescription>
              {gt(
                "Generate a one-click import bundle for another computer (assigning a dedicated VPS port like 3774) plus the matching Caddy reverse-proxy snippet.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3 text-xs">
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="font-medium">{gt("New host name")}</span>
                  <Input
                    value={exportHostName}
                    onChange={(e) => setExportHostName(e.target.value)}
                    placeholder="macbook"
                  />
                </label>
                <label className="space-y-1">
                  <span className="font-medium">{gt("Dedicated VPS port")}</span>
                  <Input
                    value={exportRemotePort}
                    onChange={(e) => setExportRemotePort(e.target.value)}
                    placeholder="3774"
                    font="mono"
                  />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="font-medium">{gt("Subdomain (optional)")}</span>
                <Input
                  value={exportSubdomain}
                  onChange={(e) => setExportSubdomain(e.target.value)}
                  placeholder="t3-macbook.example.com"
                  font="mono"
                />
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={exportIncludeCreds} onCheckedChange={setExportIncludeCreds} />
                <span>{gt("Include hy2 auth & FRP token in exported bundle")}</span>
              </label>

              {exportResult ? (
                <div className="space-y-2.5">
                  <p className="text-muted-foreground">{exportResult.summary}</p>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{gt("Host import bundle (JSON)")}</span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => void copyText("bundle JSON", exportResult.bundleJson)}
                      >
                        <CopyIcon className="size-3" />
                        {gt("Copy")}
                      </Button>
                    </div>
                    <pre className="max-h-36 overflow-auto rounded border border-border/70 bg-muted/40 p-2 font-mono text-2xs">
                      {exportResult.bundleJson}
                    </pre>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{gt("VPS Caddyfile snippet")}</span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => void copyText("Caddy snippet", exportResult.caddySnippet)}
                      >
                        <CopyIcon className="size-3" />
                        {gt("Copy")}
                      </Button>
                    </div>
                    <pre className="max-h-36 overflow-auto rounded border border-border/70 bg-muted/40 p-2 font-mono text-2xs">
                      {exportResult.caddySnippet}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setExportOpen(false)}>
              {gt("Close")}
            </Button>
            <Button type="button" onClick={() => void handleExportBundle()}>
              <Share2Icon className="size-3.5" />
              {gt("Generate bundle")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Import Bundle Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{gt("Import host tunnel bundle")}</DialogTitle>
            <DialogDescription>
              {gt(
                "Paste a bundle JSON exported from your primary host to install tools, write configs, and configure this machine in one click.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3 text-xs">
              <label className="block space-y-1">
                <span className="font-medium">{gt("Install directory")}</span>
                <Input
                  value={importDir}
                  onChange={(e) => setImportDir(e.target.value)}
                  size="compact"
                  font="mono"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">{gt("Bundle JSON")}</span>
                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  rows={8}
                  placeholder={gt("Paste exported bundle JSON here...")}
                  className="w-full rounded-md border border-input bg-background p-2 font-mono text-2xs"
                />
              </label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2">
                  <Switch checked={importAutoInstall} onCheckedChange={setImportAutoInstall} />
                  <span>{gt("Download missing tools automatically")}</span>
                </label>
                <label className="flex items-center gap-2">
                  <Switch checked={importAutoStart} onCheckedChange={setImportAutoStart} />
                  <span>{gt("Start after import")}</span>
                </label>
              </div>
              {importProgress ? (
                <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{importProgress.message}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {importProgress.percent}%
                    </span>
                  </div>
                  <progress
                    aria-label={gt("Bundle import progress")}
                    className={PROGRESS_CLASS}
                    max={100}
                    value={importProgress.percent}
                  />
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportOpen(false)}>
              {gt("Close")}
            </Button>
            <Button
              type="button"
              disabled={importing || !importJson.trim()}
              onClick={() => void handleImportBundle()}
            >
              {importing ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
              {importing ? gt("Importing...") : gt("Import & install")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { DownloadIcon, PuzzleIcon, RefreshCwIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

import { connectionAtomRuntime } from "../../connection/runtime";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { PluginNodeRenderer } from "./PluginNodeRenderer";
import { PluginSandboxFrame } from "./PluginSandboxFrame";
import { closeByteDockModal, setByteDockModalTab, usePluginSlotState } from "./PluginSlotStore";

const pluginsListCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bytedock:plugins:list",
  tag: WS_METHODS.pluginsList,
});

const pluginsReloadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bytedock:plugins:reload",
  tag: WS_METHODS.pluginsReload,
});

const pluginsInvokeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bytedock:plugins:invoke",
  tag: WS_METHODS.pluginsInvoke,
});

interface PluginListItem {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly revision: number;
  readonly execution: string;
  readonly trust: string;
  readonly status: string;
}

interface EgressStatusPayload {
  readonly policy?: { readonly mode?: string };
  readonly blockedCount?: number;
  readonly allowedCount?: number;
  readonly disclosures?: {
    readonly coverageScope: string;
    readonly verifiablePromise: string;
    readonly tierMatrix: string;
  };
}

interface EgressProofSummary {
  readonly liveAttribution?: { readonly verdict?: string };
  readonly detachedAllBlock?: {
    readonly verdict?: string;
    readonly probes?: ReadonlyArray<{ readonly name: string; readonly blocked: boolean }>;
  };
}

type LegacyCategory =
  | "settings"
  | "keybindings"
  | "themes"
  | "stateDb"
  | "attachments"
  | "usageDb"
  | "secrets";

interface LegacyScanSource {
  readonly brand: "t3-plus" | "t3" | "custom";
  readonly baseDir: string;
  readonly userdataDir: string;
  readonly exists: boolean;
  readonly schemaCompatible: boolean;
  readonly projectCount: number | null;
  readonly threadCount: number | null;
  readonly categories: ReadonlyArray<{
    readonly category: LegacyCategory;
    readonly available: boolean;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly detail: string;
  }>;
  readonly excludedTelemetryItems: ReadonlyArray<string>;
}

interface LegacyImportOutcome {
  readonly category: LegacyCategory;
  readonly status: string;
  readonly filesCopied: number;
  readonly bytesCopied: number;
}

interface LegacyImportResultPayload {
  readonly sourceBrand?: string;
  readonly targetStateDir?: string;
  readonly restartRequired?: boolean;
  readonly outcomes?: ReadonlyArray<LegacyImportOutcome>;
  readonly error?: string;
}

const DEFAULT_SELECTED_CATEGORIES: ReadonlyArray<LegacyCategory> = [
  "settings",
  "keybindings",
  "themes",
  "stateDb",
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function buildEgressKpiNode(
  status: EgressStatusPayload | null,
  proof: EgressProofSummary | null,
): JsonNode {
  const proofVerdict =
    proof?.liveAttribution?.verdict === "pass" && proof?.detachedAllBlock?.verdict === "pass"
      ? "PASS"
      : proof
        ? "CHECK"
        : "IDLE";
  return {
    k: "bytedock-egress-overview",
    t: "Card",
    p: {
      titleI18n: "Egress Guard L1",
      kpiColumns: 4,
      kpi: [
        {
          labelI18n: "Mode",
          value: status?.policy?.mode ?? "audit-only",
          tone: "info",
        },
        {
          labelI18n: "Blocked",
          value: status?.blockedCount ?? 0,
          tone: (status?.blockedCount ?? 0) > 0 ? "warning" : "success",
        },
        {
          labelI18n: "Allowed",
          value: status?.allowedCount ?? 0,
          tone: "neutral",
        },
        {
          labelI18n: "EgressProof",
          value: proofVerdict,
          tone: proofVerdict === "PASS" ? "success" : "info",
        },
      ],
    },
  };
}

export function ByteDockControlCenterModal({ host }: { readonly host: "settings" | "chat" }) {
  const gt = useGT();
  const slotState = usePluginSlotState();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const runList = useAtomCommand(pluginsListCommand);
  const runReload = useAtomCommand(pluginsReloadCommand);
  const runInvoke = useAtomCommand(pluginsInvokeCommand);

  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [activeRevision, setActiveRevision] = useState<number | null>(null);
  const [plugins, setPlugins] = useState<ReadonlyArray<PluginListItem>>([]);
  const [egressStatus, setEgressStatus] = useState<EgressStatusPayload | null>(null);
  const [egressProof, setEgressProof] = useState<EgressProofSummary | null>(null);
  const [showSandboxDemo, setShowSandboxDemo] = useState(false);
  const [sandboxReady, setSandboxReady] = useState(false);

  const [targetStateDir, setTargetStateDir] = useState<string>("");
  const [scanSources, setScanSources] = useState<ReadonlyArray<LegacyScanSource>>([]);
  const [selectedSourceDir, setSelectedSourceDir] = useState<string>("");
  const [customSourceDir, setCustomSourceDir] = useState<string>("");
  const [selectedCategories, setSelectedCategories] = useState<ReadonlyArray<LegacyCategory>>(
    DEFAULT_SELECTED_CATEGORIES,
  );
  const [importResult, setImportResult] = useState<LegacyImportResultPayload | null>(null);

  if (!slotState.modalOpen || slotState.modalHost !== host) return null;

  const requireEnvId = (): EnvironmentId | null => {
    if (!environmentId) {
      setErrorText(gt("No connected ByteDock server environment."));
      return null;
    }
    return environmentId;
  };

  const handleLoadPlugins = async () => {
    const envId = requireEnvId();
    if (!envId) return;
    setBusy(true);
    setErrorText(null);
    const listRes = await runList({ environmentId: envId, input: {} });
    if (AsyncResult.isSuccess(listRes)) {
      setActiveRevision(listRes.value.activeRevision);
      setPlugins(listRes.value.plugins);
    } else {
      setErrorText(gt("Failed to load ByteDock plugin registry."));
    }
    const egressRes = await runInvoke({
      environmentId: envId,
      input: { pluginId: "builtin.egress-guard", method: "status", payload: {} },
    });
    if (AsyncResult.isSuccess(egressRes) && egressRes.value.result) {
      setEgressStatus(egressRes.value.result as EgressStatusPayload);
    }
    setBusy(false);
  };

  const handleReloadPlugins = async () => {
    const envId = requireEnvId();
    if (!envId) return;
    setBusy(true);
    setErrorText(null);
    const res = await runReload({ environmentId: envId, input: {} });
    if (AsyncResult.isSuccess(res)) {
      setActiveRevision(res.value.activeRevision);
      setPlugins(res.value.plugins);
    } else {
      setErrorText(gt("Plugin reload failed."));
    }
    setBusy(false);
  };

  const handleRunEgressProof = async () => {
    const envId = requireEnvId();
    if (!envId) return;
    setBusy(true);
    setErrorText(null);
    const res = await runInvoke({
      environmentId: envId,
      input: { pluginId: "builtin.egress-guard", method: "runProof", payload: {} },
    });
    if (AsyncResult.isSuccess(res) && res.value.result) {
      setEgressProof(res.value.result as EgressProofSummary);
    } else {
      setErrorText(gt("Failed to execute dual-segment EgressProof."));
    }
    setBusy(false);
  };

  const handleScanLegacy = async () => {
    const envId = requireEnvId();
    if (!envId) return;
    setBusy(true);
    setErrorText(null);
    setImportResult(null);
    const res = await runInvoke({
      environmentId: envId,
      input: {
        pluginId: "builtin.legacy-importer",
        method: "scan",
        payload: customSourceDir.trim() ? { customSourceDir: customSourceDir.trim() } : {},
      },
    });
    if (AsyncResult.isSuccess(res) && res.value.result) {
      const payload = res.value.result as {
        readonly targetStateDir?: string;
        readonly sources?: ReadonlyArray<LegacyScanSource>;
      };
      const sources = payload.sources ?? [];
      setTargetStateDir(payload.targetStateDir ?? "");
      setScanSources(sources);
      const firstExisting = sources.find((s) => s.exists);
      if (firstExisting) {
        setSelectedSourceDir(firstExisting.baseDir);
      }
    } else {
      setErrorText(gt("Failed to scan local T3 Code / T3 Code Plus directories."));
    }
    setBusy(false);
  };

  const toggleCategory = (category: LegacyCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category],
    );
  };

  const handleRunImport = async () => {
    const envId = requireEnvId();
    if (!envId || !selectedSourceDir || selectedCategories.length === 0) return;
    const chosenSource = scanSources.find((s) => s.baseDir === selectedSourceDir);
    setBusy(true);
    setErrorText(null);
    const res = await runInvoke({
      environmentId: envId,
      input: {
        pluginId: "builtin.legacy-importer",
        method: "import",
        payload: {
          sourceBaseDir: selectedSourceDir,
          sourceBrand: chosenSource?.brand,
          categories: selectedCategories,
          overwrite: true,
          deferLockedStateDb: true,
        },
      },
    });
    if (AsyncResult.isSuccess(res) && res.value.result) {
      setImportResult(res.value.result as LegacyImportResultPayload);
    } else {
      setErrorText(gt("Legacy read-only import failed."));
    }
    setBusy(false);
  };

  const activeSource = scanSources.find((s) => s.baseDir === selectedSourceDir) ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={gt("ByteDock Control Center")}
      data-bytedock-control-center="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">
              <T>ByteDock Plugins &amp; Data Importer</T>
            </h2>
          </div>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Close ByteDock Control Center")}
            onClick={closeByteDockModal}
          >
            <XIcon className="size-4" />
          </Button>
        </header>

        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
          <Button
            type="button"
            size="xs"
            variant={slotState.modalTab === "plugins" ? "default" : "ghost"}
            onClick={() => setByteDockModalTab("plugins")}
          >
            <PuzzleIcon className="size-3.5" />
            <T>Plugins &amp; Egress Guard</T>
          </Button>
          <Button
            type="button"
            size="xs"
            variant={slotState.modalTab === "import" ? "default" : "ghost"}
            onClick={() => setByteDockModalTab("import")}
          >
            <DownloadIcon className="size-3.5" />
            <T>Import T3 Code / Plus</T>
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {errorText ? (
            <div className="rounded-md border border-error/30 bg-error-surface px-3 py-2 text-xs text-error">
              {errorText}
            </div>
          ) : null}

          {slotState.modalTab === "plugins" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  <T>
                    Active revision: <Var>{activeRevision ?? "-"}</Var>
                  </T>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleLoadPlugins()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    <T>Refresh Registry</T>
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleReloadPlugins()}
                  >
                    <T>Hot Reload</T>
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="default"
                    disabled={busy}
                    onClick={() => void handleRunEgressProof()}
                  >
                    <T>Run EgressProof</T>
                  </Button>
                </div>
              </div>

              <PluginNodeRenderer node={buildEgressKpiNode(egressStatus, egressProof)} />

              {egressStatus?.disclosures ? (
                <section className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">
                    <T>Egress Security Boundaries (Honest Disclosures)</T>
                  </div>
                  <p>{egressStatus.disclosures.coverageScope}</p>
                  <p>{egressStatus.disclosures.verifiablePromise}</p>
                  <p>{egressStatus.disclosures.tierMatrix}</p>
                </section>
              ) : null}

              <section className="flex flex-col gap-2">
                <div className="text-xs font-medium text-foreground">
                  <T>Registered Plugins</T>
                </div>
                {plugins.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <T>Click Refresh Registry to inspect live plugins from the ByteDock server.</T>
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {plugins.map((plugin) => (
                      <div
                        key={plugin.id}
                        className="flex flex-col gap-1 rounded-md border border-border bg-background/60 p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">{plugin.name}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                            {`r${plugin.revision}`}
                          </span>
                        </div>
                        <div className="font-mono text-2xs text-muted-foreground">
                          {`${plugin.id} · ${plugin.trust} · ${plugin.execution}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">
                    <T>Track-2 Sandbox Frame Self-Check</T>
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setShowSandboxDemo((prev) => !prev)}
                  >
                    {showSandboxDemo ? gt("Hide Sandbox Preview") : gt("Test Sandbox Frame")}
                  </Button>
                </div>
                {showSandboxDemo ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      <T>
                        Handshake status: <Var>{sandboxReady ? "nonce-verified" : "waiting"}</Var>
                      </T>
                    </span>
                    <PluginSandboxFrame
                      pluginId="builtin.sandbox-selfcheck"
                      title={gt("ByteDock Sandbox Self-Check")}
                      html="<div style='font-family:sans-serif;padding:12px;font-size:12px;'>Track-2 opaque origin sandbox active (allow-scripts only, no allow-forms).</div>"
                      onMessage={(envelope) => {
                        if (envelope.type === "ready") setSandboxReady(true);
                      }}
                    />
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                <T>
                  Reads ~/.t3 (T3 Code) and ~/.t3-plus (T3 Code Plus) strictly read-only. Never
                  modifies source folders and excludes telemetry/Clerk artifacts.
                </T>
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={customSourceDir}
                  onChange={(e) => setCustomSourceDir(e.currentTarget.value)}
                  placeholder={gt("Optional custom T3 / T3 Plus folder path")}
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={busy}
                  onClick={() => void handleScanLegacy()}
                >
                  <T>Scan Local Sources</T>
                </Button>
              </div>

              {targetStateDir ? (
                <div className="text-xs text-muted-foreground">
                  <T>
                    Target ByteDock userdata: <Var>{targetStateDir}</Var>
                  </T>
                </div>
              ) : null}

              {scanSources.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {scanSources.map((src) => (
                    <label
                      key={src.baseDir}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/60 p-2.5 text-xs"
                    >
                      <input
                        type="radio"
                        name="legacy-source"
                        checked={selectedSourceDir === src.baseDir}
                        disabled={!src.exists}
                        onChange={() => setSelectedSourceDir(src.baseDir)}
                        className="mt-0.5"
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground">
                            {src.brand === "t3-plus"
                              ? gt("T3 Code Plus (~/.t3-plus)")
                              : src.brand === "t3"
                                ? gt("T3 Code (~/.t3)")
                                : src.baseDir}
                          </span>
                          <span className="font-mono text-2xs text-muted-foreground">
                            {src.exists
                              ? src.schemaCompatible
                                ? gt("Compatible")
                                : gt("Empty")
                              : gt("Not found")}
                          </span>
                        </div>
                        <span className="truncate font-mono text-2xs text-muted-foreground">
                          {src.userdataDir}
                        </span>
                        {src.exists ? (
                          <span className="text-2xs text-muted-foreground">
                            <T>
                              Projects: <Var>{src.projectCount ?? 0}</Var> · Threads:{" "}
                              <Var>{src.threadCount ?? 0}</Var>
                            </T>
                          </span>
                        ) : null}
                      </div>
                    </label>
                  ))}
                </div>
              ) : null}

              {activeSource && activeSource.exists ? (
                <section className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <div className="text-xs font-medium text-foreground">
                    <T>Select Categories to Import (Read-Only Source Copy)</T>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {activeSource.categories.map((cat) => (
                      <label
                        key={cat.category}
                        className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5 text-xs"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            disabled={!cat.available}
                            checked={selectedCategories.includes(cat.category)}
                            onChange={() => toggleCategory(cat.category)}
                          />
                          <span className="font-medium">{cat.category}</span>
                        </span>
                        <span className="font-mono text-2xs text-muted-foreground">
                          {cat.available ? formatBytes(cat.totalBytes) : "-"}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex justify-end pt-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      disabled={busy || selectedCategories.length === 0}
                      onClick={() => void handleRunImport()}
                    >
                      <DownloadIcon className="size-3.5" />
                      <T>Run Read-Only Import</T>
                    </Button>
                  </div>
                </section>
              ) : null}

              {importResult ? (
                <section className="flex flex-col gap-1.5 rounded-md border border-success/30 bg-success/10 p-3 text-xs">
                  <div className="font-medium text-success">
                    {importResult.error ? (
                      importResult.error
                    ) : importResult.restartRequired ? (
                      <T>
                        Import completed. Restart ByteDock to promote the staged statev2.sqlite
                        snapshot.
                      </T>
                    ) : (
                      <T>Import completed safely with zero writes to the source directory.</T>
                    )}
                  </div>
                  {importResult.outcomes?.map((item) => (
                    <div key={item.category} className="font-mono text-2xs text-foreground">
                      <T>
                        <Var>{item.category}</Var>: <Var>{item.status}</Var> (
                        <Var>{item.filesCopied}</Var> files,{" "}
                        <Var>{formatBytes(item.bytesCopied)}</Var>)
                      </T>
                    </div>
                  ))}
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

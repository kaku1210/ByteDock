import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { ActivityIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { cn } from "../../lib/utils";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { PluginNodeRenderer } from "./PluginNodeRenderer";
import {
  setTokenOptimizerRuntimeConfig,
  usePluginSlotState,
  type TokenOptimizerRuntimeConfig,
} from "./PluginSlotStore";
import {
  computeThreadObservability,
  formatCompactDurationMs,
  formatCompactTokens,
  hasActiveThreadRun,
  type ThreadObservabilitySummary,
} from "./tokenOptimizerMetrics";

const xrayInvokeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bytedock:token-optimizer:xray",
  tag: WS_METHODS.pluginsInvoke,
});

interface TokenOptimizerHostSummaryPayload {
  readonly tracked: boolean;
  readonly pinnedRevision: number | null;
  readonly lastModelId: string | null;
  readonly openSessionCount: number;
  readonly observedTurns: number;
  readonly compactCount: number;
  readonly modelSwitches: number;
  readonly prefixHashStable: boolean;
  readonly mcpSnapshotStable: boolean;
  readonly lastHookAt: string | null;
  readonly lastCompactAt: string | null;
}

interface TokenOptimizerThreadSummaryResult {
  readonly threadId?: string;
  readonly config?: Omit<TokenOptimizerRuntimeConfig, "enabled">;
  readonly summary?: TokenOptimizerHostSummaryPayload;
}

function buildXRayOverviewCard(
  summary: ThreadObservabilitySummary,
  hostSummary: TokenOptimizerHostSummaryPayload | null,
  gt: ReturnType<typeof useGT>,
): JsonNode {
  const cacheValue =
    summary.steadyStateCacheStatus === "measured" && summary.steadyStateCacheHitPct !== null
      ? `${summary.steadyStateCacheHitPct}%`
      : summary.steadyStateCacheStatus === "native"
        ? gt("native")
        : gt("N/A (opaque)");
  const cacheTone =
    summary.steadyStateCacheStatus === "measured" && summary.steadyStateCacheHitPct !== null
      ? summary.steadyStateCacheHitPct >= summary.steadyStateTargetPct
        ? "success"
        : "warning"
      : "neutral";

  const headline = summary.headlineTurn;
  const ttftValue = headline ? formatCompactDurationMs(headline.ttftMs) : "-";
  const tpsValue =
    headline?.tpsStatus === "measured" && headline.effectiveTps !== null
      ? `${headline.effectiveTps.toFixed(1)} tok/s`
      : headline?.tpsStatus === "streaming"
        ? gt("streaming…")
        : "-";

  const hostInvariantValue = hostSummary?.tracked
    ? hostSummary.prefixHashStable && hostSummary.mcpSnapshotStable
      ? gt("Stable")
      : gt("Drift")
    : gt("Idle");
  const hostInvariantTone = hostSummary?.tracked
    ? hostSummary.prefixHashStable && hostSummary.mcpSnapshotStable
      ? "success"
      : "error"
    : "neutral";

  return {
    k: "bytedock-xray-overview",
    t: "Card",
    p: {
      titleI18n: gt("Context X-Ray Summary"),
      kpiColumns: 4,
      kpi: [
        {
          labelI18n: gt("Cache Hit"),
          value: cacheValue,
          ...(summary.steadyStateCacheHitPct !== null
            ? { progressPct: summary.steadyStateCacheHitPct }
            : {}),
          tone: cacheTone,
          detailI18n:
            summary.steadyStateCacheStatus === "measured"
              ? gt("Target >= {pct}%", { pct: summary.steadyStateTargetPct })
              : gt("Strict no-fabrication"),
        },
        {
          labelI18n: gt("Latest TTFT"),
          value: ttftValue,
          tone: "info",
          detailI18n: headline
            ? gt("Total {dur}", { dur: formatCompactDurationMs(headline.totalDurationMs) })
            : gt("No turns yet"),
        },
        {
          labelI18n: gt("Effective TPS"),
          value: tpsValue,
          tone: headline?.tpsStatus === "measured" ? "info" : "neutral",
          detailI18n: gt("Output {tokens}", {
            tokens: formatCompactTokens(
              summary.totalOutputTokens > 0 ? summary.totalOutputTokens : null,
            ),
          }),
        },
        {
          labelI18n: gt("CacheGuard"),
          value: hostInvariantValue,
          tone: hostInvariantTone,
          detailI18n: hostSummary?.tracked
            ? gt("Turns: {turns} · Compacts: {compacts}", {
                turns: hostSummary.observedTurns,
                compacts: hostSummary.compactCount,
              })
            : gt("Waiting for hook"),
        },
      ],
    },
  };
}

export function TokenOptimizerXRayPanel({
  environmentId,
  configMtimeMs,
  onConfigSaved,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly configMtimeMs: number | undefined;
  readonly onConfigSaved: () => void;
}) {
  const gt = useGT();
  const slotState = usePluginSlotState();
  const activeThreadId = slotState.activeThreadId;
  const runInvoke = useAtomCommand(xrayInvokeCommand);

  const threadState = useEnvironmentThread(
    environmentId,
    activeThreadId ? (activeThreadId as ThreadId) : null,
  );
  const projection = Option.getOrNull(threadState.data);

  const [hostSummaryState, setHostSummaryState] = useState<{
    readonly threadId: string;
    readonly summary: TokenOptimizerHostSummaryPayload;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftOverrides, setDraftOverrides] = useState<{
    readonly showStatusBarMetrics?: boolean;
    readonly watchdogEnabled?: boolean;
    readonly steadyStateTargetPct?: string;
    readonly watchdogWarnAfterSec?: string;
    readonly watchdogCriticalAfterSec?: string;
  }>({});
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const cfg = slotState.tokenOptimizerConfig;
  const draftShowBar = draftOverrides.showStatusBarMetrics ?? cfg.showStatusBarMetrics;
  const draftWatchdogEnabled = draftOverrides.watchdogEnabled ?? cfg.watchdogEnabled;
  const draftTargetPct = draftOverrides.steadyStateTargetPct ?? String(cfg.steadyStateTargetPct);
  const draftWarnSec = draftOverrides.watchdogWarnAfterSec ?? String(cfg.watchdogWarnAfterSec);
  const draftCritSec =
    draftOverrides.watchdogCriticalAfterSec ?? String(cfg.watchdogCriticalAfterSec);

  const isLiveRunning = hasActiveThreadRun(projection);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks live elapsed duration inside X-Ray strictly while a run is active
  useEffect(() => {
    if (!isLiveRunning) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isLiveRunning]);

  const fetchHostSummary = async (envId: EnvironmentId, threadId: string, revision: number) => {
    const res = await runInvoke({
      environmentId: envId,
      input: {
        pluginId: "builtin.token-optimizer",
        method: "threadSummary",
        payload: { threadId, configRevision: revision },
      },
    });
    if (AsyncResult.isSuccess(res) && res.value.result && typeof res.value.result === "object") {
      const data = res.value.result as TokenOptimizerThreadSummaryResult;
      if (data.summary) {
        setHostSummaryState({ threadId, summary: data.summary });
      }
      if (data.config) {
        setTokenOptimizerRuntimeConfig({
          enabled: true,
          ...data.config,
        });
      }
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches host CacheGuard invariants for the active thread when X-Ray opens or config reloads
  useEffect(() => {
    if (!environmentId || !activeThreadId) return;
    let cancelled = false;
    const revision = slotState.configRevision;
    void (async () => {
      const res = await runInvoke({
        environmentId,
        input: {
          pluginId: "builtin.token-optimizer",
          method: "threadSummary",
          payload: { threadId: activeThreadId, configRevision: revision },
        },
      });
      if (cancelled) return;
      if (AsyncResult.isSuccess(res) && res.value.result && typeof res.value.result === "object") {
        const data = res.value.result as TokenOptimizerThreadSummaryResult;
        if (data.summary) {
          setHostSummaryState({ threadId: activeThreadId, summary: data.summary });
        }
        if (data.config) {
          setTokenOptimizerRuntimeConfig({
            enabled: true,
            ...data.config,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, activeThreadId, slotState.configRevision, runInvoke]);

  const hostSummary =
    activeThreadId && hostSummaryState?.threadId === activeThreadId
      ? hostSummaryState.summary
      : null;

  const summary = computeThreadObservability({
    projection,
    nowMs,
    config: slotState.tokenOptimizerConfig,
  });

  const handleSaveSettings = async () => {
    if (!environmentId) {
      setSaveError(gt("No connected ByteDock server environment."));
      return;
    }
    const targetPct = Math.trunc(Number(draftTargetPct));
    const warnSec = Math.trunc(Number(draftWarnSec));
    const critSec = Math.trunc(Number(draftCritSec));
    if (
      !Number.isFinite(targetPct) ||
      targetPct < 50 ||
      targetPct > 99 ||
      !Number.isFinite(warnSec) ||
      warnSec < 10 ||
      warnSec > 600 ||
      !Number.isFinite(critSec) ||
      critSec < 30 ||
      critSec > 1800 ||
      critSec <= warnSec
    ) {
      setSaveError(
        gt(
          "Watchdog critical threshold must be greater than warning threshold and within valid ranges.",
        ),
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    const patch = {
      showStatusBarMetrics: draftShowBar,
      watchdogEnabled: draftWatchdogEnabled,
      steadyStateTargetPct: targetPct,
      watchdogWarnAfterSec: warnSec,
      watchdogCriticalAfterSec: critSec,
    };
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.control-plane",
        method: "patchConfig",
        payload: {
          pluginId: "builtin.token-optimizer",
          patch,
          ...(configMtimeMs !== undefined ? { expectedMtimeMs: configMtimeMs } : {}),
        },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setTokenOptimizerRuntimeConfig({
        ...slotState.tokenOptimizerConfig,
        ...patch,
      });
      setDraftOverrides({});
      setSaveMessage(gt("Token Optimizer & Watchdog settings saved and hot-reloaded."));
      onConfigSaved();
    } else {
      setSaveError(gt("Failed to save plugin config (validation or concurrent edit conflict)."));
    }
    setSaving(false);
  };

  const totalInput = summary.totalInputTokens;
  const cachedPctOfInput =
    totalInput > 0
      ? Math.min(100, Math.round((summary.totalCachedInputTokens / totalInput) * 100))
      : 0;
  const cacheWritePctOfInput =
    totalInput > 0
      ? Math.min(
          100 - cachedPctOfInput,
          Math.round((summary.totalCacheCreationTokens / totalInput) * 100),
        )
      : 0;

  const contextLabel =
    summary.contextUsedTokens === null
      ? null
      : `${formatCompactTokens(summary.contextUsedTokens)}${
          summary.contextMaxTokens !== null
            ? ` / ${formatCompactTokens(summary.contextMaxTokens)}${
                summary.contextUsedPct !== null ? ` (${summary.contextUsedPct}%)` : ""
              }`
            : ""
        }`;

  return (
    <div data-bytedock-xray-panel="true" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <ActivityIcon className="size-3.5 text-primary" />
            <T>Thread Performance &amp; Context X-Ray</T>
          </div>
          <span className="font-mono text-2xs">
            {activeThreadId
              ? gt("Thread: {threadId}", { threadId: activeThreadId })
              : gt("Open a chat thread to inspect per-turn latency and token usage.")}
          </span>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!environmentId || !activeThreadId}
          onClick={() => {
            if (environmentId && activeThreadId) {
              setNowMs(Date.now());
              void fetchHostSummary(environmentId, activeThreadId, slotState.configRevision);
            }
          }}
        >
          <RefreshCwIcon className="size-3.5" />
          <T>Refresh X-Ray</T>
        </Button>
      </div>

      <PluginNodeRenderer node={buildXRayOverviewCard(summary, hostSummary, gt)} />

      <section className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <ShieldCheckIcon className="size-3.5 text-success" />
          <T>Tri-State X-Ray Honesty Guarantee</T>
        </div>
        <p>
          <T>
            measured = provider-reported cache read tokens; native = provider token totals without
            cache breakdown; opaque = provider did not expose counters (never fabricated).
          </T>
        </p>
      </section>

      {totalInput > 0 || summary.totalOutputTokens > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-foreground">
              <T>Cumulative Thread Token Breakdown</T>
            </span>
            {contextLabel !== null ? (
              <span className="font-mono text-2xs text-muted-foreground">
                <T>
                  Context: <Var>{contextLabel}</Var>
                </T>
              </span>
            ) : null}
          </div>
          {totalInput > 0 ? (
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-success transition-all"
                style={{ width: `${cachedPctOfInput}%` }}
              />
              <div
                className="h-full bg-info transition-all"
                style={{ width: `${cacheWritePctOfInput}%` }}
              />
              <div
                className="h-full bg-warning/70 transition-all"
                style={{ width: `${Math.max(0, 100 - cachedPctOfInput - cacheWritePctOfInput)}%` }}
              />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2 font-mono text-2xs sm:grid-cols-4">
            <div className="rounded border border-border/60 px-2 py-1">
              <span className="block text-muted-foreground">
                <T>Input Total</T>
              </span>
              <span className="font-medium text-foreground">{formatCompactTokens(totalInput)}</span>
            </div>
            <div className="rounded border border-border/60 px-2 py-1">
              <span className="block text-muted-foreground">
                <T>Cache Read</T>
              </span>
              <span className="font-medium text-success">
                {formatCompactTokens(
                  summary.measuredTurnCount > 0 ? summary.totalCachedInputTokens : null,
                )}
              </span>
            </div>
            <div className="rounded border border-border/60 px-2 py-1">
              <span className="block text-muted-foreground">
                <T>Cache Write</T>
              </span>
              <span className="font-medium text-info">
                {formatCompactTokens(
                  summary.totalCacheCreationTokens > 0 ? summary.totalCacheCreationTokens : null,
                )}
              </span>
            </div>
            <div className="rounded border border-border/60 px-2 py-1">
              <span className="block text-muted-foreground">
                <T>Output / Reasoning</T>
              </span>
              <span className="font-medium text-foreground">
                {`${formatCompactTokens(summary.totalOutputTokens > 0 ? summary.totalOutputTokens : null)} / ${formatCompactTokens(summary.totalReasoningTokens > 0 ? summary.totalReasoningTokens : null)}`}
              </span>
            </div>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">
            <T>Per-Turn Latency &amp; Token Ledger</T>
          </span>
          <span className="font-mono text-2xs text-muted-foreground">
            <T>
              <Var>{summary.turns.length}</Var> turns
            </T>
          </span>
        </div>
        {summary.turns.length === 0 ? (
          <p className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
            <T>
              No provider turns recorded in this thread yet. Send a message to see live TTFT,
              streaming TPS, and honest cache hit rates.
            </T>
          </p>
        ) : (
          <div className="max-h-60 overflow-auto rounded-md border border-border">
            <table className="w-full border-collapse text-left font-mono text-2xs tabular-nums">
              <thead className="sticky top-0 bg-muted/90 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">
                    <T>Model</T>
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    <T>TTFT</T>
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    <T>Total</T>
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    <T>TPS</T>
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    <T>In / Out</T>
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    <T>Cache</T>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {summary.turns.map((turn) => (
                  <tr key={turn.turnId} className="hover:bg-muted/20">
                    <td className="px-2 py-1.5 text-muted-foreground">{`#${turn.ordinal}`}</td>
                    <td className="max-w-36 truncate px-2 py-1.5 text-foreground">
                      {turn.model ?? "-"}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {`${formatCompactDurationMs(turn.ttftMs)}${turn.ttftPending ? "…" : ""}`}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {formatCompactDurationMs(turn.totalDurationMs)}
                    </td>
                    <td className="px-2 py-1.5 text-foreground">
                      {turn.tpsStatus === "measured" && turn.effectiveTps !== null
                        ? `${turn.effectiveTps.toFixed(1)}`
                        : turn.tpsStatus === "streaming"
                          ? gt("live")
                          : "-"}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {`${formatCompactTokens(turn.inputTokens)} / ${formatCompactTokens(turn.outputTokens)}`}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className={cn(
                          "inline-flex rounded px-1.5 py-0.5 text-3xs font-medium",
                          turn.cacheStatus === "measured"
                            ? turn.targetMet
                              ? "bg-success/15 text-success"
                              : "bg-warning/15 text-warning"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {turn.cacheStatus === "measured" && turn.cacheHitPct !== null
                          ? `${turn.cacheHitPct}%`
                          : turn.cacheStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-background/60 p-3 text-xs">
        <div className="font-medium text-foreground">
          <T>Status Bar &amp; Anti-Stall Watchdog Controls</T>
        </div>
        {saveError ? (
          <div className="rounded border border-error/30 bg-error-surface px-2.5 py-1.5 text-2xs text-error">
            {saveError}
          </div>
        ) : null}
        {saveMessage ? (
          <div className="rounded border border-success/30 bg-success/10 px-2.5 py-1.5 text-2xs text-success">
            {saveMessage}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={draftShowBar}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setDraftOverrides((prev) => ({ ...prev, showStatusBarMetrics: checked }));
              }}
            />
            <span>
              <T>Show TTFT/TPS/Cache in status bar</T>
            </span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={draftWatchdogEnabled}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setDraftOverrides((prev) => ({ ...prev, watchdogEnabled: checked }));
              }}
            />
            <span>
              <T>Enable gentle anti-stall Watchdog</T>
            </span>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              <T>Cache Target (%)</T>
            </span>
            <input
              type="number"
              min={50}
              max={99}
              value={draftTargetPct}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraftOverrides((prev) => ({ ...prev, steadyStateTargetPct: value }));
              }}
              className="rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              <T>Watchdog Warn (sec)</T>
            </span>
            <input
              type="number"
              min={10}
              max={600}
              value={draftWarnSec}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraftOverrides((prev) => ({ ...prev, watchdogWarnAfterSec: value }));
              }}
              className="rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              <T>Watchdog Critical (sec)</T>
            </span>
            <input
              type="number"
              min={30}
              max={1800}
              value={draftCritSec}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraftOverrides((prev) => ({ ...prev, watchdogCriticalAfterSec: value }));
              }}
              className="rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={saving || !environmentId}
            onClick={() => void handleSaveSettings()}
          >
            <T>Save &amp; Hot Reload</T>
          </Button>
        </div>
      </section>
    </div>
  );
}

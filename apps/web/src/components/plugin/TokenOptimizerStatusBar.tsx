import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import { ActivityIcon, AlertTriangleIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { cn } from "../../lib/utils";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
  openByteDockModal,
  setActiveObservabilityThreadId,
  setTokenOptimizerRuntimeConfig,
  usePluginSlotState,
  type TokenOptimizerRuntimeConfig,
} from "./PluginSlotStore";
import {
  computeThreadObservability,
  formatCompactDurationMs,
  hasActiveThreadRun,
  type ThreadObservabilitySummary,
} from "./tokenOptimizerMetrics";

const tokenOptimizerStatusCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bytedock:token-optimizer:status",
  tag: WS_METHODS.pluginsInvoke,
});

interface TokenOptimizerStatusResponse {
  readonly cacheGuardActive?: boolean;
  readonly steadyStateTargetPct?: number;
  readonly xrayHonestyMode?: "strict-no-fabrication";
  readonly showStatusBarMetrics?: boolean;
  readonly watchdogEnabled?: boolean;
  readonly watchdogWarnAfterSec?: number;
  readonly watchdogCriticalAfterSec?: number;
}

function parseTokenOptimizerConfig(
  payload: TokenOptimizerStatusResponse | undefined,
  enabled: boolean,
): TokenOptimizerRuntimeConfig {
  const base = DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG;
  if (!payload) return { ...base, enabled };
  return {
    enabled,
    cacheGuardActive: payload.cacheGuardActive ?? base.cacheGuardActive,
    steadyStateTargetPct: payload.steadyStateTargetPct ?? base.steadyStateTargetPct,
    xrayHonestyMode: payload.xrayHonestyMode ?? base.xrayHonestyMode,
    showStatusBarMetrics: payload.showStatusBarMetrics ?? base.showStatusBarMetrics,
    watchdogEnabled: payload.watchdogEnabled ?? base.watchdogEnabled,
    watchdogWarnAfterSec: payload.watchdogWarnAfterSec ?? base.watchdogWarnAfterSec,
    watchdogCriticalAfterSec: payload.watchdogCriticalAfterSec ?? base.watchdogCriticalAfterSec,
  };
}

/** Syncs builtin.token-optimizer hot-reloaded settings from the connected server environment. */
export function useTokenOptimizerObservability(threadId: string): {
  readonly environmentId: EnvironmentId | null;
  readonly summary: ThreadObservabilitySummary;
  readonly config: TokenOptimizerRuntimeConfig;
} {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const slotState = usePluginSlotState();
  const runInvoke = useAtomCommand(tokenOptimizerStatusCommand);
  const threadState = useEnvironmentThread(environmentId, threadId as ThreadId);
  const projection = Option.getOrNull(threadState.data);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks active chat thread so Control Center X-Ray targets the live thread
  useEffect(() => {
    setActiveObservabilityThreadId(threadId);
  }, [threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches builtin.token-optimizer config on connect and control-plane hot reload
  useEffect(() => {
    if (!environmentId) return;
    let cancelled = false;
    const revision = slotState.configRevision;
    void (async () => {
      const res = await runInvoke({
        environmentId,
        input: {
          pluginId: "builtin.token-optimizer",
          method: "status",
          payload: { configRevision: revision },
        },
      });
      if (cancelled) return;
      if (AsyncResult.isSuccess(res) && res.value.result && typeof res.value.result === "object") {
        setTokenOptimizerRuntimeConfig(
          parseTokenOptimizerConfig(res.value.result as TokenOptimizerStatusResponse, true),
        );
      } else if (AsyncResult.isFailure(res)) {
        const message = String(res.cause);
        if (message.includes("currently disabled")) {
          setTokenOptimizerRuntimeConfig(parseTokenOptimizerConfig(undefined, false));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, slotState.configRevision, runInvoke]);

  const isLiveRunning = hasActiveThreadRun(projection);
  const [tickNowMs, setTickNowMs] = useState<number>(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs a 1s clock strictly while a turn is actively streaming so TTFT/elapsed/Watchdog tick live
  useEffect(() => {
    if (!isLiveRunning) return;
    const timer = window.setInterval(() => {
      setTickNowMs(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isLiveRunning]);

  const summary = computeThreadObservability({
    projection,
    nowMs: tickNowMs,
    config: slotState.tokenOptimizerConfig,
  });

  return {
    environmentId,
    summary,
    config: slotState.tokenOptimizerConfig,
  };
}

/** Gentle anti-stall Watchdog banner rendered only when a live run has gone silent past threshold. */
export function TokenOptimizerWatchdogBanner({
  threadId,
  environmentId,
  summary,
}: {
  readonly threadId: string;
  readonly environmentId: EnvironmentId | null;
  readonly summary: ThreadObservabilitySummary;
}) {
  const gt = useGT();
  const [dismissedStallKey, setDismissedStallKey] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const { watchdog } = summary;
  const shouldShow =
    (watchdog.level === "warn" || watchdog.level === "critical") &&
    watchdog.stallKey !== null &&
    dismissedStallKey !== watchdog.stallKey;

  if (!shouldShow) return null;

  const canStop =
    environmentId !== null && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const durationLabel = formatCompactDurationMs(watchdog.silenceMs);

  const handleStopTurn = async () => {
    if (!environmentId || !canStop || stopping) return;
    setStopping(true);
    try {
      await interruptThreadTurn({
        environmentId,
        input: { threadId: threadId as ThreadId },
      });
    } finally {
      setStopping(false);
    }
  };

  const phaseText =
    watchdog.phase === "tool-execution"
      ? watchdog.activeToolLabel
        ? gt("Tool running without new output ({tool})", { tool: watchdog.activeToolLabel })
        : gt("Tool execution has produced no new output")
      : watchdog.phase === "streaming-stalled"
        ? gt("Stream paused mid-response")
        : gt("Awaiting first model token");

  return (
    <div
      data-bytedock-watchdog-banner="true"
      data-bytedock-watchdog-level={watchdog.level}
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1 text-2xs",
        watchdog.level === "critical"
          ? "border-error/40 bg-error-surface text-error"
          : "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AlertTriangleIcon className="size-3 shrink-0" />
        <span className="truncate font-medium">
          <T>
            Watchdog: silent for <Var>{durationLabel}</Var>
          </T>
        </span>
        <span className="hidden truncate text-muted-foreground sm:inline">{phaseText}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => openByteDockModal("xray", "chat", threadId)}
          className="rounded border border-current/25 px-1.5 py-0.5 font-medium hover:bg-background/60"
        >
          <T>X-Ray</T>
        </button>
        {canStop ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => void handleStopTurn()}
            className="inline-flex items-center gap-1 rounded border border-current/25 px-1.5 py-0.5 font-medium hover:bg-background/60 disabled:opacity-60"
          >
            <SquareIcon className="size-2.5 fill-current" />
            <T>Stop</T>
          </button>
        ) : null}
        <button
          type="button"
          aria-label={gt("Dismiss watchdog alert")}
          onClick={() => setDismissedStallKey(watchdog.stallKey)}
          className="rounded p-0.5 hover:bg-background/60"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}

/** Compact single-line bottom status metrics pill (TTFT / Total / Effective TPS / Honest Cache Hit). */
export function TokenOptimizerMetricsPill({
  threadId,
  summary,
  config,
}: {
  readonly threadId: string;
  readonly summary: ThreadObservabilitySummary;
  readonly config: TokenOptimizerRuntimeConfig;
}) {
  const gt = useGT();
  if (!config.enabled || !config.showStatusBarMetrics) return null;

  const turn = summary.headlineTurn;
  const ttftLabel = turn
    ? `${formatCompactDurationMs(turn.ttftMs)}${turn.ttftPending ? "…" : ""}`
    : "-";
  const totalLabel = turn ? formatCompactDurationMs(turn.totalDurationMs) : "-";
  const tpsLabel =
    turn?.tpsStatus === "measured" && turn.effectiveTps !== null
      ? `${turn.effectiveTps.toFixed(1)} tok/s`
      : turn?.tpsStatus === "streaming"
        ? gt("streaming…")
        : "-";

  const cacheStatus = turn?.cacheStatus ?? summary.steadyStateCacheStatus;
  const cacheHitPct = turn?.cacheHitPct ?? summary.steadyStateCacheHitPct;
  const cacheToneClass =
    cacheStatus === "measured" && cacheHitPct !== null
      ? cacheHitPct >= config.steadyStateTargetPct
        ? "text-success"
        : "text-warning"
      : "text-muted-foreground";

  const cacheLabel =
    cacheStatus === "measured" && cacheHitPct !== null
      ? `${cacheHitPct}%`
      : cacheStatus === "native"
        ? gt("native")
        : gt("opaque");

  return (
    <button
      type="button"
      data-bytedock-token-metrics="true"
      data-bytedock-cache-status={cacheStatus}
      onClick={() => openByteDockModal("xray", "chat", threadId)}
      aria-label={gt("Open Context X-Ray performance breakdown")}
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1.5 py-0.5 font-mono text-2xs tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <span className="inline-flex items-center gap-1">
        <ActivityIcon
          className={cn(
            "size-3 shrink-0",
            summary.isLiveRunning ? "animate-pulse text-primary" : "text-muted-foreground",
          )}
        />
        {summary.hasTurns ? (
          <span>
            <T>
              TTFT <Var>{ttftLabel}</Var>
            </T>
          </span>
        ) : (
          <span>
            <T>X-Ray</T>
          </span>
        )}
      </span>
      {summary.hasTurns ? (
        <>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
          <span>
            <T>
              Total <Var>{totalLabel}</Var>
            </T>
          </span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
          <span>{tpsLabel}</span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
          <span className={cn("font-medium", cacheToneClass)}>
            <T>
              Cache <Var>{cacheLabel}</Var>
            </T>
          </span>
        </>
      ) : null}
    </button>
  );
}

import "~/index.css";

import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
  getPluginSlotSnapshot,
  resetPluginSlotStoreForTest,
} from "./PluginSlotStore";
import { TokenOptimizerMetricsPill, TokenOptimizerWatchdogBanner } from "./TokenOptimizerStatusBar";
import type { ThreadObservabilitySummary } from "./tokenOptimizerMetrics";

function pluginSlotStoreScope(): Disposable {
  resetPluginSlotStoreForTest();
  return {
    [Symbol.dispose]() {
      resetPluginSlotStoreForTest();
    },
  };
}

function makeSummary(
  overrides: Partial<ThreadObservabilitySummary> = {},
): ThreadObservabilitySummary {
  return {
    hasTurns: true,
    isLiveRunning: false,
    activeRunId: null,
    activeModel: "claude-opus-4-6",
    headlineTurn: {
      turnId: "turn-1",
      ordinal: 1,
      runId: null,
      status: "completed",
      model: "claude-opus-4-6",
      startedAtMs: 0,
      completedAtMs: 5_000,
      firstOutputAtMs: 1_200,
      ttftMs: 1_200,
      ttftPending: false,
      totalDurationMs: 5_000,
      streamDurationMs: 3_800,
      effectiveTps: 63.2,
      tpsStatus: "measured",
      inputTokens: 10_000,
      cachedInputTokens: 9_400,
      cacheCreationTokens: 200,
      uncachedInputTokens: 400,
      outputTokens: 240,
      reasoningTokens: 40,
      toolCallCount: 1,
      cacheStatus: "measured",
      cacheHitPct: 94,
      targetMet: true,
    },
    turns: [],
    steadyStateCacheStatus: "measured",
    steadyStateCacheHitPct: 94,
    steadyStateTargetPct: 90,
    measuredTurnCount: 1,
    totalInputTokens: 10_000,
    totalCachedInputTokens: 9_400,
    totalCacheCreationTokens: 200,
    totalOutputTokens: 240,
    totalReasoningTokens: 40,
    contextUsedTokens: 10_240,
    contextMaxTokens: 200_000,
    contextUsedPct: 5,
    watchdog: {
      level: "idle",
      phase: "idle",
      silenceMs: 0,
      activeRunId: null,
      activeToolLabel: null,
      stallKey: null,
      warnAfterSec: 45,
      criticalAfterSec: 120,
    },
    ...overrides,
  };
}

describe("TokenOptimizerStatusBar", () => {
  it("renders TTFT/Total/TPS/Cache metrics and opens Context X-Ray tab on click", async () => {
    using _store = pluginSlotStoreScope();
    await page.viewport(1024, 600);
    await using _screen = await render(
      <TokenOptimizerMetricsPill
        threadId="thread-browser-1"
        summary={makeSummary()}
        config={DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG}
      />,
    );

    const pill = page.getByRole("button", { name: "Open Context X-Ray performance breakdown" });
    await expect.element(pill).toBeVisible();
    expect(pill.element().textContent).toContain("1.2s");
    expect(pill.element().textContent).toContain("5.0s");
    expect(pill.element().textContent).toContain("63.2 tok/s");
    expect(pill.element().textContent).toContain("94%");

    await userEvent.click(pill);
    expect(getPluginSlotSnapshot().modalOpen).toBe(true);
    expect(getPluginSlotSnapshot().modalTab).toBe("xray");
    expect(getPluginSlotSnapshot().activeThreadId).toBe("thread-browser-1");
  });

  it("renders gentle Watchdog warn banner and allows dismissing the current stall episode", async () => {
    using _store = pluginSlotStoreScope();
    await page.viewport(1024, 600);
    const stalledSummary = makeSummary({
      isLiveRunning: true,
      watchdog: {
        level: "warn",
        phase: "awaiting-first-token",
        silenceMs: 52_000,
        activeRunId: null,
        activeToolLabel: null,
        stallKey: "run-9:1000",
        warnAfterSec: 45,
        criticalAfterSec: 120,
      },
    });

    await using _screen = await render(
      <TokenOptimizerWatchdogBanner
        threadId="thread-browser-2"
        environmentId={null}
        summary={stalledSummary}
      />,
    );

    const dismiss = page.getByRole("button", { name: "Dismiss watchdog alert" });
    await expect.element(dismiss).toBeVisible();
    await expect.element(page.getByText("Watchdog: silent for 52.0s")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "X-Ray" }));
    expect(getPluginSlotSnapshot().modalTab).toBe("xray");
    expect(getPluginSlotSnapshot().activeThreadId).toBe("thread-browser-2");

    await userEvent.click(dismiss);
    await expect.element(dismiss).not.toBeInTheDocument();
  });
});

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PluginKernel from "@bytedock/plugin-kernel";

import { makeTokenOptimizerTelemetry } from "./TokenOptimizerTelemetry.ts";

describe("TokenOptimizerTelemetry", () => {
  it.effect("tracks open, turn, model-switch, and compact boundaries via PluginKernel hooks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const kernel = yield* PluginKernel.makePluginKernel();
        const telemetry = makeTokenOptimizerTelemetry();
        yield* telemetry.attachKernelHooks(kernel, 1);

        yield* kernel.hooks.runOpenPrepare({
          threadId: "thread-1",
          revision: 1,
          modelId: "claude-opus-4-6",
        });
        yield* kernel.hooks.runOpenAfterPrepare({
          threadId: "thread-1",
          providerSessionId: "psess-1",
          revision: 1,
        });
        yield* kernel.hooks.runTurnBefore({
          threadId: "thread-1",
          revision: 1,
          projectedMessage: "hello",
        });
        yield* kernel.hooks.runOpenPrepare({
          threadId: "thread-1",
          revision: 1,
          modelId: "gpt-5.4",
        });
        yield* kernel.hooks.runTurnBefore({
          threadId: "thread-1",
          revision: 2,
          projectedMessage: "after hot reload revision drift",
        });

        const drifted = telemetry.getThreadSummary("thread-1");
        expect(drifted.tracked).toBe(true);
        expect(drifted.openSessionCount).toBe(1);
        expect(drifted.observedTurns).toBe(2);
        expect(drifted.modelSwitches).toBe(1);
        expect(drifted.lastModelId).toBe("gpt-5.4");
        expect(drifted.prefixHashStable).toBe(false);
        expect(telemetry.getOverview().prefixViolations).toBe(1);

        // Compaction legally resets the pinned revision and prefix stability.
        yield* kernel.hooks.runCompactBefore({
          threadId: "thread-1",
          revision: 2,
        });
        const compacted = telemetry.getThreadSummary("thread-1");
        expect(compacted.compactCount).toBe(1);
        expect(compacted.prefixHashStable).toBe(true);
        expect(compacted.pinnedRevision).toBe(2);
        expect(compacted.recentEvents.at(-1)?.kind).toBe("compact-before");

        const untracked = telemetry.getThreadSummary("thread-unknown");
        expect(untracked.tracked).toBe(false);
        expect(untracked.observedTurns).toBe(0);
      }),
    ),
  );
});

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as PluginKernel from "@bytedock/plugin-kernel";
import { getInstalledEgressGuard, installEgressGuardedFetchDispatcher } from "./outboundHttp.ts";

describe("Phase 1 server seams (Seam 6 / 7 / 8)", () => {
  it("installs the dual-gate Egress Guard dispatcher and enforces deny policy", () => {
    const guard = installEgressGuardedFetchDispatcher({
      mode: "strict",
      deniedDomains: ["telemetry.posthog.com", "*.mixpanel.com"],
      allowedHosts: ["*"],
      allowLoopbackHosts: ["127.0.0.1", "localhost", "::1"],
      allowUdp: false,
    });

    assert.strictEqual(getInstalledEgressGuard(), guard);
    const blocked = PluginKernel.evaluateHostPolicy("telemetry.posthog.com", guard.getPolicy());
    assert.strictEqual(blocked.allowed, false);
    assert.include(blocked.reason, "denied-domain");

    const allowed = PluginKernel.evaluateHostPolicy("api.openai.com", guard.getPolicy());
    assert.strictEqual(allowed.allowed, true);
  });

  it.effect(
    "enforces deterministic prefix hash, 500ms turn timeout isolation, /compact reset legality, and fail-closed egress hooks",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* PluginKernel.PluginKernel;

          // 1. Open stage: deterministic sorted prefix hash across registration order
          yield* kernel.hooks.register({
            pluginId: "plugin-b",
            revision: 1,
            name: "agent.open.before",
            priority: 20,
            onError: "pass",
            timeoutMs: 1_000,
            handler: () =>
              Effect.succeed({
                verdict: "pass",
                contribution: {
                  stablePrefixBlocks: [
                    { id: "z-block", hash: "hz", body: "Z stable" },
                    { id: "a-block", hash: "ha", body: "A stable" },
                  ],
                  mcpExposure: { directTools: ["search_tools"], deferred: true },
                },
              }),
          });

          const openAfter = yield* kernel.hooks.runOpenAfterPrepare({
            threadId: "thread-seam6",
            providerSessionId: "sess-seam6",
            revision: 1,
          });
          assert.deepStrictEqual(
            openAfter.contribution.stablePrefixBlocks.map((b) => b.id),
            ["a-block", "z-block"],
          );
          assert.strictEqual(openAfter.prefixHash.length, 64);

          // 2. Turn stage: fast hook contributes, hung hook times out under TestClock, forceCacheReset rejected
          yield* kernel.hooks.register({
            pluginId: "fast-optimizer",
            revision: 1,
            name: "agent.turn.before",
            priority: 10,
            onError: "pass",
            timeoutMs: 200,
            handler: () =>
              Effect.succeed({
                verdict: "pass",
                contribution: {
                  appendContext: "Delta note: 1 file changed.",
                  forceCacheReset: {
                    reason: "illegal-test",
                    compactProof: "illegal-outside-compact",
                  },
                },
              }),
          });

          yield* kernel.hooks.register({
            pluginId: "slow-plugin",
            revision: 1,
            name: "agent.turn.before",
            priority: 20,
            onError: "pass",
            timeoutMs: 500,
            handler: () => Effect.never,
          });

          const turnFiber = yield* Effect.forkChild(
            kernel.hooks.runTurnBefore({
              threadId: "thread-seam7",
              revision: 1,
              projectedMessage: "Fix the bug",
              totalBudgetMs: 120,
            }),
          );
          yield* TestClock.adjust("200 millis");
          const turnResult = yield* Fiber.join(turnFiber);

          assert.strictEqual(turnResult.payload.projectedMessage, "Fix the bug");
          assert.include(turnResult.payload.outboundUserText, "Delta note: 1 file changed.");
          assert.include(turnResult.timedOutPlugins, "slow-plugin");
          assert.include(turnResult.rejectedResets, "fast-optimizer");

          // 3. Compact stage: handoffSummary + legal reset
          yield* kernel.hooks.register({
            pluginId: "token-optimizer",
            revision: 1,
            name: "agent.compact.before",
            priority: 10,
            onError: "pass",
            timeoutMs: 500,
            handler: () =>
              Effect.succeed({
                verdict: "pass",
                contribution: {
                  handoffSummary: "Completed Seam 6-8.",
                  forceCacheReset: { reason: "manual-compact", compactProof: "compact-seq-1" },
                },
              }),
          });

          const compactResult = yield* kernel.hooks.runCompactBefore({
            threadId: "thread-seam7",
            revision: 1,
          });
          assert.strictEqual(compactResult.resetAuthorized, true);
          assert.deepStrictEqual(compactResult.handoffSummaries, [
            { pluginId: "token-optimizer", summary: "Completed Seam 6-8." },
          ]);

          // 4. Security hook: fail-closed when hook throws
          yield* kernel.hooks.register({
            pluginId: "egress-guard",
            revision: 1,
            name: "egress.request.before",
            priority: 1,
            onError: "deny",
            timeoutMs: 500,
            handler: () => Effect.die(new Error("egress policy evaluator crashed")),
          });

          const egressDecision = yield* kernel.hooks.runEgressBefore({
            host: "evil.example.com",
            port: 443,
            protocol: "https:",
            revision: 1,
          });
          assert.strictEqual(egressDecision.allowed, false);
          assert.strictEqual(egressDecision.deniedBy, "egress-guard");
          assert.include(egressDecision.reason ?? "", "fail-closed");
        }),
      ).pipe(Effect.provide(PluginKernel.PluginKernelLive)),
  );
});

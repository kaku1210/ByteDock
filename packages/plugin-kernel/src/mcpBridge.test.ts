import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { makeHookRegistry } from "./hooks.ts";
import { makePluginMcpBridge } from "./mcpBridge.ts";

describe("W5-1 Seam 5: PluginMcpBridge per-session snapshot isolation", () => {
  it.effect(
    "flushes Session A at turn boundary while keeping mid-turn Session B frozen, and records tool.after artifactRef",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const hooks = yield* makeHookRegistry();
          const bridge = makePluginMcpBridge({ hooks });

          let sessionANotifies = 0;
          let sessionBNotifies = 0;
          const unsubA = bridge.subscribeSession("sess-A", () => {
            sessionANotifies += 1;
          });
          const unsubB = bridge.subscribeSession("sess-B", () => {
            sessionBNotifies += 1;
          });

          // Session B enters a turn; Session A stays at turn boundary.
          bridge.markTurnStarted("sess-B");

          const toolScope = yield* Scope.make();
          yield* bridge
            .registerTool({
              pluginId: "builtin.bots-core",
              revision: 2,
              name: "bot_dispatch",
              description: "Dispatch a bot command",
              direct: true,
              handler: () => Effect.succeed({ text: "x".repeat(32_000) }),
            })
            .pipe(Effect.provideService(Scope.Scope, toolScope));

          // Session A immediately sees the new direct tool; mid-turn Session B remains frozen.
          assert.isTrue(bridge.isVisibleForSession("sess-A", "bot_dispatch"));
          assert.strictEqual(sessionANotifies, 1);
          assert.isFalse(bridge.isVisibleForSession("sess-B", "bot_dispatch"));
          assert.strictEqual(sessionBNotifies, 0);

          // Register an agent.tool.after hook that tags oversized outputs with an artifactRef.
          yield* hooks.register({
            pluginId: "builtin.token-optimizer",
            revision: 2,
            name: "agent.tool.after",
            priority: 10,
            onError: "pass",
            timeoutMs: 500,
            handler: (inv) => {
              const payload = inv.input as { readonly outputBytes: number };
              return Effect.succeed(
                payload.outputBytes > 16_000
                  ? {
                      verdict: "pass" as const,
                      contribution: { artifactRef: "artifacts/thread-1/tool-1.txt" },
                    }
                  : { verdict: "pass" as const },
              );
            },
          });

          const callResult = yield* bridge.invokeTool({
            name: "bot_dispatch",
            args: { ping: true },
            threadId: "thread-1",
            providerSessionId: "sess-A",
            revision: 2,
          });
          assert.deepStrictEqual(callResult.artifactRefs, ["artifacts/thread-1/tool-1.txt"]);

          // When Session B reaches its own turn boundary, its deferred list_changed drains cleanly.
          const flushed = bridge.flushAtTurnBoundary("sess-B");
          assert.isTrue(flushed);
          assert.isTrue(bridge.isVisibleForSession("sess-B", "bot_dispatch"));
          assert.strictEqual(sessionBNotifies, 1);

          // Closing the plugin revision scope removes the tool cleanly.
          yield* Scope.close(toolScope, Exit.void);
          assert.strictEqual(bridge.listTools().length, 0);

          unsubA();
          unsubB();
        }),
      ),
  );
});

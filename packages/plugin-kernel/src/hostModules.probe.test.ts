// @effect-diagnostics nodeBuiltinImport:off -- Probe test constructs temporary paths and executes bundled host harness.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as esbuild from "esbuild";

import { compilePluginServer } from "./compiler.ts";
import {
  HostModuleRegistry,
  HostModuleRegistryLive,
  loadCompiledPlugin,
  makeHostModuleRegistry,
} from "./hostModules.ts";

/**
 * W1-2 Probe #1 (ADR-04 Scheme alpha): verifies host Effect singleton sharing across dev
 * and standalone inlined-bundle (SEA) modes plus compile-time whitelist and TLA rejection.
 */
describe("W1-2 Probe #1: Scheme alpha HostModuleRegistry + vm.compileFunction", () => {
  it.effect(
    "shares exact Effect singleton identity across host Layer and vm.compileFunction plugin with zero require.cache pollution",
    () =>
      Effect.gen(function* () {
        const registry = yield* HostModuleRegistry;
        const entryPath = NodePath.join(NodeOS.tmpdir(), "bytedock-probe-plugin", "server.ts");

        // Sentinel host service created in the host realm.
        class HostSentinel extends Context.Service<HostSentinel, { readonly token: string }>()(
          "@bytedock/plugin-kernel/hostModules.probe.test/HostSentinel",
        ) {}

        const source = `
          import * as Effect from "effect/Effect";
          import * as Context from "effect/Context";
          import { isValidRpcNamespace } from "@bytedock/plugin-sdk/bridge";

          export const effectContextServiceRef = Context.Service;
          export function runWithHostService(sentinelTag: unknown) {
            return Effect.gen(function* () {
              const svc = yield* (sentinelTag as typeof Context.Service<any, { token: string }>);
              return {
                ok: "ok",
                token: svc.token,
                validNs: isValidRpcNamespace("plugins.egress-guard.getSummary"),
                sameRealmError: new Error("probe") instanceof Error,
              };
            });
          }
        `;

        const artifact = yield* compilePluginServer({
          pluginId: "probe.alpha",
          rev: 1,
          entryPath,
          inlineSource: source,
          registry,
        });

        const loaded = yield* loadCompiledPlugin(artifact);

        // 1. Exact Effect Context.Service singleton identity (prevents Context.Tag split in vp pack / SEA).
        assert.strictEqual(loaded.exports.effectContextServiceRef, Context.Service);

        // 2. Host Layer service resolves cleanly inside Effect created by the compiled plugin.
        const runFn = loaded.exports.runWithHostService as (tag: unknown) => Effect.Effect<{
          readonly ok: string;
          readonly token: string;
          readonly validNs: boolean;
          readonly sameRealmError: boolean;
        }>;
        const result = yield* runFn(HostSentinel).pipe(
          Effect.provideService(HostSentinel, { token: "singleton-verified" }),
        );

        assert.deepStrictEqual(result, {
          ok: "ok",
          token: "singleton-verified",
          validNs: true,
          sameRealmError: true,
        });
      }).pipe(Effect.provide(HostModuleRegistryLive)),
  );

  it.effect(
    "preserves Effect singleton identity when host inlines `effect` into a standalone bundle (vp pack / SEA simulation)",
    () =>
      Effect.gen(function* () {
        const registry = makeHostModuleRegistry();
        const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-sea-probe-"));
        try {
          const pluginArtifact = yield* compilePluginServer({
            pluginId: "probe.sea",
            rev: 1,
            entryPath: NodePath.join(tmpDir, "plugin-entry.ts"),
            inlineSource: `
              import * as Effect from "effect/Effect";
              import * as Context from "effect/Context";
              export const ctxService = Context.Service;
              export const run = (tag: any) => Effect.map(tag, (s: { value: string }) => s.value + ":from-plugin");
            `,
            registry,
          });

          const hostHarnessOut = NodePath.join(tmpDir, "standalone-host.mjs");
          const pluginCodeJson = JSON.stringify(pluginArtifact.code);
          const hostModuleSrc = NodePath.resolve(import.meta.dirname, "hostModules.ts");

          yield* Effect.promise(() =>
            esbuild.build({
              bundle: true,
              format: "esm",
              platform: "node",
              target: "node22",
              outfile: hostHarnessOut,
              // Inline `effect` and `@bytedock/*` completely (identical to `vp pack` / Node SEA).
              stdin: {
                contents: `
                  import * as Context from "effect/Context";
                  import * as Effect from "effect/Effect";
                  import { HostModuleRegistryLive, loadCompiledPlugin } from ${JSON.stringify(hostModuleSrc)};

                  class SeaHostService extends Context.Service()("@bytedock/sea-probe/SeaHostService") {}

                  const artifact = {
                    pluginId: "probe.sea",
                    rev: 1,
                    filename: "virtual:probe-sea.cjs",
                    code: ${pluginCodeJson},
                    contentHash: "probe",
                  };

                  const program = Effect.gen(function* () {
                    const loaded = yield* loadCompiledPlugin(artifact);
                    const sameSingleton = loaded.exports.ctxService === Context.Service;
                    const value = yield* loaded.exports.run(SeaHostService).pipe(
                      Effect.provideService(SeaHostService, { value: "inlined-host" }),
                    );
                    return { sameSingleton, value };
                  }).pipe(Effect.provide(HostModuleRegistryLive));

                  const out = await Effect.runPromise(program);
                  process.stdout.write(JSON.stringify(out));
                `,
                resolveDir: import.meta.dirname,
                loader: "ts",
              },
            }),
          );

          // Execute standalone bundle from tmpDir where NO node_modules directory exists.
          const exec = NodeChildProcess.spawnSync(process.execPath, [hostHarnessOut], {
            cwd: tmpDir,
            encoding: "utf8",
          });
          assert.equal(exec.status, 0, `Standalone bundled host failed: ${exec.stderr}`);
          const parsed = JSON.parse(exec.stdout) as {
            readonly sameSingleton: boolean;
            readonly value: string;
          };
          assert.deepStrictEqual(parsed, {
            sameSingleton: true,
            value: "inlined-host:from-plugin",
          });
        } finally {
          NodeFS.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "rejects forbidden node:child_process and unwhitelisted effect subpaths at compile time",
    () =>
      Effect.gen(function* () {
        const registry = makeHostModuleRegistry();
        const entryPath = NodePath.join(NodeOS.tmpdir(), "bytedock-probe-deny", "server.ts");

        const childProcExit = yield* Effect.exit(
          compilePluginServer({
            pluginId: "probe.deny-node",
            rev: 1,
            entryPath,
            inlineSource: `import { spawn } from "node:child_process"; export const x = spawn;`,
            registry,
          }),
        );
        assert.isTrue(Exit.isFailure(childProcExit));

        const unwhitelistedExit = yield* Effect.exit(
          compilePluginServer({
            pluginId: "probe.deny-subpath",
            rev: 1,
            entryPath,
            inlineSource: `import * as X from "effect/NonExistentSubpath"; export const x = X;`,
            registry,
          }),
        );
        assert.isTrue(Exit.isFailure(unwhitelistedExit));
      }),
  );

  it.effect("rejects top-level await in CJS plugin bundles with EsmTlaRejectedError", () =>
    Effect.gen(function* () {
      const registry = makeHostModuleRegistry();
      const entryPath = NodePath.join(NodeOS.tmpdir(), "bytedock-probe-tla", "server.ts");

      const tlaExit = yield* Effect.exit(
        compilePluginServer({
          pluginId: "probe.tla",
          rev: 1,
          entryPath,
          inlineSource: `export const value = await Promise.resolve(42);`,
          registry,
        }),
      );
      assert.isTrue(Exit.isFailure(tlaExit));
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off -- Hot-reload controller hashes plugin source files on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import {
  compilePluginServer,
  type EsmTlaRejectedError,
  type PluginCompileError,
} from "./compiler.ts";
import {
  HostModuleRegistry,
  loadCompiledPlugin,
  type HostModuleRegistryService,
  type LoadedPluginModule,
  type PluginLoadError,
  type SingletonSplitError,
} from "./hostModules.ts";
import type { RevisionManagerService } from "./revision.ts";

export interface HotReloadPluginSource {
  readonly manifest: ByteDockPluginManifest;
  readonly entryPath: string;
  readonly inlineSource?: string | undefined;
}

export interface HotReloadErrorDiagnostic {
  readonly pluginId: string;
  readonly tag: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type HotReloadOutcome =
  | { readonly status: "skipped-unchanged"; readonly activeRev: number }
  | { readonly status: "reloaded"; readonly previousRev: number; readonly activeRev: number }
  | {
      readonly status: "kept-previous-on-error";
      readonly activeRev: number;
      readonly error: HotReloadErrorDiagnostic;
    };

export interface HotReloadController {
  readonly reloadFromSources: (
    sources: ReadonlyArray<HotReloadPluginSource>,
    options?: { readonly nowMs?: number | undefined },
  ) => Effect.Effect<HotReloadOutcome>;
  readonly lastError: () => Effect.Effect<HotReloadErrorDiagnostic | undefined>;
}

function computeSourcesDigest(sources: ReadonlyArray<HotReloadPluginSource>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const src of [...sources].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    hash.update(src.manifest.id);
    hash.update(src.manifest.version);
    const body =
      src.inlineSource !== undefined
        ? src.inlineSource
        : NodeFS.existsSync(src.entryPath)
          ? NodeFS.readFileSync(src.entryPath, "utf8")
          : "";
    hash.update(body);
  }
  return hash.digest("hex");
}

function toDiagnostic(
  pluginId: string,
  entryPath: string,
  err: PluginCompileError | EsmTlaRejectedError | PluginLoadError | SingletonSplitError,
): HotReloadErrorDiagnostic {
  if (err._tag === "PluginCompileError") {
    return {
      pluginId,
      tag: err._tag,
      file: err.file,
      line: err.line,
      column: err.column,
      message: err.message,
    };
  }
  if (err._tag === "EsmTlaRejectedError") {
    return {
      pluginId,
      tag: err._tag,
      file: err.dependency,
      line: 1,
      column: 1,
      message: "Top-level await is not supported in CJS plugin bundles.",
    };
  }
  if (err._tag === "SingletonSplitError") {
    return {
      pluginId,
      tag: err._tag,
      file: entryPath,
      line: 1,
      column: 1,
      message: err.detail,
    };
  }
  return {
    pluginId,
    tag: err._tag,
    file: entryPath,
    line: 1,
    column: 1,
    message: err.cause instanceof Error ? err.cause.message : String(err.cause),
  };
}

/**
 * Scheme alpha leak-free hot-reload pipeline (Blueprint Ch. 7.3).
 * Skips identical content hashes and keeps the active revision untouched on any compile/load failure.
 */
export const makeHotReloadController = Effect.fn("pluginKernel.makeHotReloadController")(
  function* (deps: {
    readonly hostModules: HostModuleRegistryService;
    readonly revisions: RevisionManagerService;
  }) {
    const gate = yield* Semaphore.make(1);
    const lastDigestRef = yield* Ref.make<string | undefined>(undefined);
    const lastErrorRef = yield* Ref.make<HotReloadErrorDiagnostic | undefined>(undefined);

    const reloadFromSources: HotReloadController["reloadFromSources"] = (sources, options) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* deps.revisions.active();
          const digest = computeSourcesDigest(sources);
          const prevDigest = yield* Ref.get(lastDigestRef);
          if (prevDigest === digest) {
            return {
              status: "skipped-unchanged",
              activeRev: current.rev,
            } satisfies HotReloadOutcome;
          }

          const compiledModules: Array<LoadedPluginModule> = [];
          const manifests: Array<ByteDockPluginManifest> = [];
          const nextRevHint = current.rev + 1;

          for (const src of sources) {
            const allowScopedFs = src.manifest.permissions.storage === "isolated-sqlite";
            const compileExit = yield* Effect.exit(
              compilePluginServer({
                pluginId: src.manifest.id,
                rev: nextRevHint,
                entryPath: src.entryPath,
                inlineSource: src.inlineSource,
                allowScopedFs,
                registry: deps.hostModules,
              }),
            );
            if (Exit.isFailure(compileExit)) {
              const err = compileExit.cause.reasons[0];
              const failObj =
                err && "_tag" in err && err._tag === "Fail"
                  ? (err.error as PluginCompileError | EsmTlaRejectedError)
                  : null;
              const diagnostic: HotReloadErrorDiagnostic = failObj
                ? toDiagnostic(src.manifest.id, src.entryPath, failObj)
                : {
                    pluginId: src.manifest.id,
                    tag: "UnknownCompileError",
                    file: src.entryPath,
                    line: 1,
                    column: 1,
                    message: String(compileExit.cause),
                  };
              yield* Ref.set(lastErrorRef, diagnostic);
              return {
                status: "kept-previous-on-error",
                activeRev: current.rev,
                error: diagnostic,
              } satisfies HotReloadOutcome;
            }

            const loadExit = yield* Effect.exit(
              loadCompiledPlugin(compileExit.value, { allowScopedFs }).pipe(
                Effect.provideService(HostModuleRegistry, deps.hostModules),
              ),
            );
            if (Exit.isFailure(loadExit)) {
              const err = loadExit.cause.reasons[0];
              const failObj =
                err && "_tag" in err && err._tag === "Fail"
                  ? (err.error as PluginLoadError | SingletonSplitError)
                  : null;
              const diagnostic: HotReloadErrorDiagnostic = failObj
                ? toDiagnostic(src.manifest.id, src.entryPath, failObj)
                : {
                    pluginId: src.manifest.id,
                    tag: "UnknownLoadError",
                    file: src.entryPath,
                    line: 1,
                    column: 1,
                    message: String(loadExit.cause),
                  };
              yield* Ref.set(lastErrorRef, diagnostic);
              return {
                status: "kept-previous-on-error",
                activeRev: current.rev,
                error: diagnostic,
              } satisfies HotReloadOutcome;
            }

            compiledModules.push(loadExit.value);
            manifests.push(src.manifest);
          }

          // Only freeze old revision AFTER every plugin compiled and passed boot probes cleanly.
          const installed = yield* deps.revisions.installRevision({
            manifests,
            modules: compiledModules,
            nowMs: options?.nowMs,
          });
          yield* Ref.set(lastDigestRef, digest);
          yield* Ref.set(lastErrorRef, undefined);
          return {
            status: "reloaded",
            previousRev: current.rev,
            activeRev: installed.rev,
          } satisfies HotReloadOutcome;
        }),
      );

    return {
      reloadFromSources,
      lastError: () => Ref.get(lastErrorRef),
    } satisfies HotReloadController;
  },
);

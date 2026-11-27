// @effect-diagnostics nodeBuiltinImport:off -- Scheme alpha plugin loader binds host Node builtins and vm.compileFunction.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";

import * as EffectAll from "effect";
import * as EffectCause from "effect/Cause";
import * as EffectChannel from "effect/Channel";
import * as EffectChunk from "effect/Chunk";
import * as EffectClock from "effect/Clock";
import * as EffectContext from "effect/Context";
import * as EffectData from "effect/Data";
import * as EffectDeferred from "effect/Deferred";
import * as EffectDuration from "effect/Duration";
import * as EffectEffect from "effect/Effect";
import * as EffectExit from "effect/Exit";
import * as EffectFiber from "effect/Fiber";
import * as EffectHashMap from "effect/HashMap";
import * as EffectHashSet from "effect/HashSet";
import * as EffectLayer from "effect/Layer";
import * as EffectLogger from "effect/Logger";
import * as EffectOption from "effect/Option";
import * as EffectPubSub from "effect/PubSub";
import * as EffectQueue from "effect/Queue";
import * as EffectRedacted from "effect/Redacted";
import * as EffectRef from "effect/Ref";
import * as EffectResult from "effect/Result";
import * as EffectSchema from "effect/Schema";
import * as EffectScope from "effect/Scope";
import * as EffectSemaphore from "effect/Semaphore";
import * as EffectStream from "effect/Stream";
import * as EffectTracer from "effect/Tracer";

import * as PluginSdk from "@bytedock/plugin-sdk";
import * as PluginSdkBridge from "@bytedock/plugin-sdk/bridge";
import * as PluginSdkCacheGuard from "@bytedock/plugin-sdk/cacheGuard";
import * as PluginSdkManifest from "@bytedock/plugin-sdk/manifest";
import * as PluginSdkServer from "@bytedock/plugin-sdk/server";
import * as PluginUiProtocol from "@bytedock/plugin-ui-renderer/protocol";
import * as PluginUiSandboxBridge from "@bytedock/plugin-ui-renderer/sandboxBridge";

/**
 * Scheme alpha (ADR-04): injects host in-memory Effect singletons into vm.compileFunction
 * so bundled/SEA hosts share exact Context.Service identity without require.cache leaks.
 */
export interface CompiledPluginArtifact {
  readonly pluginId: string;
  readonly rev: number;
  readonly filename: string;
  readonly code: string;
  readonly contentHash: string;
  readonly cachedData?: Uint8Array | undefined;
}

export interface HostModuleRegistryService {
  readonly get: (id: string) => unknown;
  readonly has: (id: string) => boolean;
  readonly subpathWhitelist: ReadonlySet<string>;
  readonly allowedNodeBuiltins: ReadonlySet<string>;
  readonly createPluginRequire: (options?: {
    readonly pluginDataDir?: string | undefined;
    readonly allowScopedFs?: boolean | undefined;
  }) => (id: string) => unknown;
}

export class HostModuleRegistry extends EffectContext.Service<
  HostModuleRegistry,
  HostModuleRegistryService
>()("@bytedock/plugin-kernel/hostModules/HostModuleRegistry") {}

export class SingletonSplitError extends EffectSchema.TaggedError<SingletonSplitError>()(
  "SingletonSplitError",
  {
    pluginId: EffectSchema.String,
    detail: EffectSchema.String,
  },
) {}

export class PluginLoadError extends EffectSchema.TaggedError<PluginLoadError>()(
  "PluginLoadError",
  {
    pluginId: EffectSchema.String,
    cause: EffectSchema.Defect(),
  },
) {}

const DEFAULT_ALLOWED_NODE_BUILTINS = new Set<string>(["node:path", "node:url", "node:events"]);

function createScopedFsPromises(allowedRoot: string) {
  const resolvedRoot = NodePath.resolve(allowedRoot);
  const assertWithinRoot = (target: NodeFSPathLike): string => {
    const resolved = NodePath.resolve(String(target));
    const relative = NodePath.relative(resolvedRoot, resolved);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
      throw new Error(`Path "${resolved}" escapes plugin data directory "${resolvedRoot}".`);
    }
    return resolved;
  };
  return {
    readFile: (p: NodeFSPathLike, opts?: Parameters<typeof NodeFSP.readFile>[1]) =>
      NodeFSP.readFile(assertWithinRoot(p), opts),
    writeFile: (
      p: NodeFSPathLike,
      data: Parameters<typeof NodeFSP.writeFile>[1],
      opts?: Parameters<typeof NodeFSP.writeFile>[2],
    ) => NodeFSP.writeFile(assertWithinRoot(p), data, opts),
    mkdir: (p: NodeFSPathLike, opts?: Parameters<typeof NodeFSP.mkdir>[1]) =>
      NodeFSP.mkdir(assertWithinRoot(p), opts),
    readdir: (p: NodeFSPathLike) => NodeFSP.readdir(assertWithinRoot(p)),
    rm: (p: NodeFSPathLike, opts?: Parameters<typeof NodeFSP.rm>[1]) =>
      NodeFSP.rm(assertWithinRoot(p), opts),
    stat: (p: NodeFSPathLike) => NodeFSP.stat(assertWithinRoot(p)),
  };
}

type NodeFSPathLike = string | Buffer | URL;

export function createDefaultHostModuleMap(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ["effect", EffectAll],
    ["effect/Cause", EffectCause],
    ["effect/Channel", EffectChannel],
    ["effect/Chunk", EffectChunk],
    ["effect/Clock", EffectClock],
    ["effect/Context", EffectContext],
    ["effect/Data", EffectData],
    ["effect/Deferred", EffectDeferred],
    ["effect/Duration", EffectDuration],
    ["effect/Effect", EffectEffect],
    ["effect/Exit", EffectExit],
    ["effect/Fiber", EffectFiber],
    ["effect/HashMap", EffectHashMap],
    ["effect/HashSet", EffectHashSet],
    ["effect/Layer", EffectLayer],
    ["effect/Logger", EffectLogger],
    ["effect/Option", EffectOption],
    ["effect/PubSub", EffectPubSub],
    ["effect/Queue", EffectQueue],
    ["effect/Redacted", EffectRedacted],
    ["effect/Ref", EffectRef],
    ["effect/Result", EffectResult],
    ["effect/Schema", EffectSchema],
    ["effect/Scope", EffectScope],
    ["effect/Semaphore", EffectSemaphore],
    ["effect/Stream", EffectStream],
    ["effect/Tracer", EffectTracer],
    ["@bytedock/plugin-sdk", PluginSdk],
    ["@bytedock/plugin-sdk/bridge", PluginSdkBridge],
    ["@bytedock/plugin-sdk/cacheGuard", PluginSdkCacheGuard],
    ["@bytedock/plugin-sdk/manifest", PluginSdkManifest],
    ["@bytedock/plugin-sdk/server", PluginSdkServer],
    ["@bytedock/plugin-ui-renderer/protocol", PluginUiProtocol],
    ["@bytedock/plugin-ui-renderer/sandboxBridge", PluginUiSandboxBridge],
    ["node:path", NodePath],
    ["node:url", NodeURL],
    ["node:events", NodeEvents],
  ]);
}

export function makeHostModuleRegistry(
  overrides?: ReadonlyMap<string, unknown>,
): HostModuleRegistryService {
  const modules = new Map(createDefaultHostModuleMap());
  if (overrides) {
    for (const [k, v] of overrides.entries()) {
      modules.set(k, v);
    }
  }
  const subpathWhitelist = new Set<string>(modules.keys());
  const allowedNodeBuiltins = new Set<string>([
    ...DEFAULT_ALLOWED_NODE_BUILTINS,
    "node:fs/promises",
  ]);

  const createPluginRequire: HostModuleRegistryService["createPluginRequire"] = (options) => {
    const scopedFs =
      options?.allowScopedFs && options.pluginDataDir
        ? createScopedFsPromises(options.pluginDataDir)
        : undefined;

    return (id: string): unknown => {
      if (id === "node:fs/promises") {
        if (!scopedFs) {
          throw new Error(
            `Module "node:fs/promises" requires storage: "isolated-sqlite" permission.`,
          );
        }
        return scopedFs;
      }
      if (!modules.has(id)) {
        throw new Error(
          `Module "${id}" is not in ByteDock HostModuleRegistry whitelist (Scheme alpha).`,
        );
      }
      return modules.get(id);
    };
  };

  return {
    get: (id) => modules.get(id),
    has: (id) => modules.has(id),
    subpathWhitelist,
    allowedNodeBuiltins,
    createPluginRequire,
  };
}

export const HostModuleRegistryLive = EffectLayer.sync(HostModuleRegistry, () =>
  makeHostModuleRegistry(),
);

export interface LoadedPluginModule {
  readonly pluginId: string;
  readonly rev: number;
  readonly exports: Record<string, unknown>;
  readonly compiledFn: ReturnType<typeof NodeVM.compileFunction>;
}

/**
 * Loads a single-file CJS plugin bundle directly in the host V8 realm via vm.compileFunction.
 * Never touches Node's require.cache and asserts Effect singleton identity before returning.
 */
export const loadCompiledPlugin = EffectEffect.fn("pluginKernel.loadCompiledPlugin")(function* (
  artifact: CompiledPluginArtifact,
  options?: {
    readonly pluginDataDir?: string | undefined;
    readonly allowScopedFs?: boolean | undefined;
  },
) {
  const registry = yield* HostModuleRegistry;
  const pluginRequire = registry.createPluginRequire(options);

  // Boot singleton probe: verifies the plugin sees the exact host Effect Context.Service reference.
  const injectedContext = pluginRequire("effect/Context") as typeof EffectContext;
  const hostContext = registry.get("effect/Context") as typeof EffectContext;
  if (injectedContext !== hostContext || injectedContext.Service !== hostContext.Service) {
    return yield* new SingletonSplitError({
      pluginId: artifact.pluginId,
      detail: "Injected effect/Context singleton does not match host module identity.",
    });
  }

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const filename = artifact.filename;
  const dirname = NodePath.dirname(filename);

  const compiledFn = yield* EffectEffect.try({
    try: () =>
      NodeVM.compileFunction(
        artifact.code,
        ["exports", "require", "module", "__filename", "__dirname"],
        {
          filename,
          ...(artifact.cachedData ? { cachedData: artifact.cachedData } : {}),
        },
      ),
    catch: (cause) => new PluginLoadError({ pluginId: artifact.pluginId, cause }),
  });

  yield* EffectEffect.try({
    try: () => {
      compiledFn(moduleObj.exports, pluginRequire, moduleObj, filename, dirname);
    },
    catch: (cause) => new PluginLoadError({ pluginId: artifact.pluginId, cause }),
  });

  return {
    pluginId: artifact.pluginId,
    rev: artifact.rev,
    exports: moduleObj.exports,
    compiledFn,
  } satisfies LoadedPluginModule;
});

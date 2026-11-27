import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { HookDecision, HookInvocation, PluginScopeBrokerService } from "./bridge.ts";
import type { ByteDockPluginManifest, PluginHookName } from "./manifest.ts";

export interface PluginKvStore {
  readonly get: (ns: string, key: string) => Effect.Effect<string | undefined>;
  readonly set: (
    ns: string,
    key: string,
    jsonValue: string,
    expiresAt?: number,
  ) => Effect.Effect<void, Error>;
  readonly delete: (ns: string, key: string) => Effect.Effect<void>;
}

export interface PluginScheduleHandle {
  readonly schedule: (input: {
    readonly id: string;
    readonly intervalMs: number;
    readonly run: () => Effect.Effect<void>;
  }) => Effect.Effect<void, never, Scope.Scope>;
}

export interface PluginServerContext<TConfig = Readonly<Record<string, unknown>>> {
  readonly pluginId: string;
  readonly manifest: ByteDockPluginManifest;
  readonly getConfig: () => Effect.Effect<TConfig>;
  readonly hooks: {
    readonly register: (
      name: PluginHookName,
      handler: (inv: HookInvocation) => Effect.Effect<HookDecision>,
      options?: {
        readonly priority?: number;
        readonly onError?: "pass" | "deny";
        readonly timeoutMs?: number;
      },
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly storage: {
    readonly kv: PluginKvStore;
  };
  readonly scheduler: PluginScheduleHandle;
  readonly broker: PluginScopeBrokerService;
}

export interface ByteDockServerPlugin<TConfig = Readonly<Record<string, unknown>>> {
  readonly manifest: ByteDockPluginManifest;
  readonly activate: (
    ctx: PluginServerContext<TConfig>,
  ) => Effect.Effect<void, unknown, Scope.Scope>;
}

export function defineServerPlugin<TConfig = Readonly<Record<string, unknown>>>(
  plugin: ByteDockServerPlugin<TConfig>,
): ByteDockServerPlugin<TConfig> {
  return plugin;
}

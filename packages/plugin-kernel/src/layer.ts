import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PluginRuntimeDescriptor } from "@bytedock/plugin-sdk/manifest";
import { makePluginScopeBroker, type PluginScopeBrokerAdmin } from "./broker.ts";
import {
  createEgressGuard,
  DEFAULT_DENIED_DOMAINS,
  type EgressGuardController,
} from "./egressGuard.ts";
import { makeHookRegistry, type HookRegistryService } from "./hooks.ts";
import { makeHostModuleRegistry, type HostModuleRegistryService } from "./hostModules.ts";
import { makeHotReloadController, type HotReloadController } from "./hotReload.ts";
import { makePluginMcpBridge, type PluginMcpBridgeService } from "./mcpBridge.ts";
import { makeRevisionManager, type RevisionManagerService } from "./revision.ts";
import { makeThreadSessionGate, type ThreadSessionGateService } from "./sessionGate.ts";

export interface PluginKernelService {
  readonly hostModules: HostModuleRegistryService;
  readonly revisions: RevisionManagerService;
  readonly sessionGate: ThreadSessionGateService;
  readonly broker: PluginScopeBrokerAdmin;
  readonly hooks: HookRegistryService;
  readonly egress: EgressGuardController;
  readonly hotReload: HotReloadController;
  readonly mcpBridge: PluginMcpBridgeService;
  readonly listDescriptors: () => Effect.Effect<ReadonlyArray<PluginRuntimeDescriptor>>;
}

export class PluginKernel extends Context.Service<PluginKernel, PluginKernelService>()(
  "@bytedock/plugin-kernel/layer/PluginKernel",
) {}

export const makePluginKernel = Effect.fn("pluginKernel.make")(function* () {
  const hostModules = makeHostModuleRegistry();
  const revisions = yield* makeRevisionManager();
  const sessionGate = yield* makeThreadSessionGate();
  const broker = yield* makePluginScopeBroker();
  const hooks = yield* makeHookRegistry();
  const egress = createEgressGuard({
    policy: {
      mode: "audit-only",
      deniedDomains: DEFAULT_DENIED_DOMAINS,
      allowedHosts: ["*"],
      allowLoopbackHosts: ["127.0.0.1", "localhost", "::1"],
      allowUdp: false,
    },
  });
  const hotReload = yield* makeHotReloadController({ hostModules, revisions });
  const mcpBridge = makePluginMcpBridge({ hooks });

  const listDescriptors = () =>
    revisions.active().pipe(
      Effect.map((rev) =>
        rev.manifests.map((manifest): PluginRuntimeDescriptor => ({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          revision: rev.rev,
          execution: manifest.execution,
          trust: manifest.trust,
          status: "active",
        })),
      ),
    );

  return {
    hostModules,
    revisions,
    sessionGate,
    broker,
    hooks,
    egress,
    hotReload,
    mcpBridge,
    listDescriptors,
  } satisfies PluginKernelService;
});

export const PluginKernelLive = Layer.effect(PluginKernel, makePluginKernel());

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { ByteDockPluginManifest } from "@bytedock/plugin-kernel";

export const BUILTIN_PLUGIN_MANIFESTS: ReadonlyArray<ByteDockPluginManifest> = [
  {
    id: "builtin.egress-guard",
    name: "ByteDock Egress Guard",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      networkHosts: ["**"],
      secretNamespaces: ["bytedock.egress"],
      storage: "kv",
      hooks: [{ name: "egress.request.before", onError: "deny", timeoutMs: 2_000 }],
    },
    contributes: {
      panels: [
        {
          id: "egress-guard",
          titleI18n: "Egress Guard",
          icon: "shield",
          mode: "declarative",
          defaultArea: "right",
        },
      ],
      statusBarItems: [{ id: "egress-shield", align: "right", priority: 10 }],
    },
  },
  {
    id: "builtin.token-optimizer",
    name: "ByteDock Token Optimizer & X-Ray",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      storage: "isolated-sqlite",
      hooks: [
        { name: "agent.open.before", onError: "pass", timeoutMs: 2_000 },
        { name: "agent.turn.before", onError: "pass", timeoutMs: 500 },
        { name: "agent.compact.before", onError: "pass", timeoutMs: 2_000 },
        { name: "agent.tool.after", onError: "pass", timeoutMs: 500 },
      ],
    },
    contributes: {
      statusBarItems: [{ id: "ttft-tps-cache", align: "right", priority: 20 }],
      timelineRenderers: [{ id: "xray-bill", matchType: "plugin-card" }],
    },
  },
  {
    id: "builtin.bots-core",
    name: "ByteDock Bots Core",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      storage: "isolated-sqlite",
      hooks: [
        { name: "agent.open.before", onError: "pass", timeoutMs: 2_000 },
        { name: "agent.turn.before", onError: "pass", timeoutMs: 300 },
        { name: "agent.compact.before", onError: "pass", timeoutMs: 2_000 },
      ],
    },
    contributes: {
      panels: [
        {
          id: "bots-manager",
          titleI18n: "Bots Manager",
          icon: "bot",
          mode: "declarative",
          defaultArea: "right",
        },
      ],
      timelineRenderers: [{ id: "decision-gate-card", matchType: "plugin-card" }],
    },
  },
  {
    id: "community.napcat-qq",
    name: "NapCatQQ OneBot v11 Channel",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "local-dev",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      secretNamespaces: ["bytedock.napcat"],
      networkHosts: ["127.0.0.1", "localhost"],
      storage: "kv",
      hooks: [{ name: "egress.request.before", onError: "deny", timeoutMs: 2_000 }],
    },
    contributes: {
      settingsSection: {
        id: "napcat-qq",
        titleI18n: "NapCatQQ Channel",
        group: "plugins",
        icon: "message-square",
      },
      statusBarItems: [{ id: "napcat-status", align: "right", priority: 40 }],
    },
  },
  {
    id: "builtin.legacy-importer",
    name: "T3 Code / T3 Code Plus Read-Only Importer",
    version: "0.1.0",
    apiVersion: "0.1",
    execution: "trusted-worker",
    trust: "builtin",
    permissions: {
      rpcScopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      storage: "none",
    },
    contributes: {
      settingsSection: {
        id: "legacy-import",
        titleI18n: "Import from T3 Code / Plus",
        group: "plugins",
        icon: "download",
      },
    },
  },
];

export const BUILTIN_METHODS: ReadonlyArray<{
  readonly pluginId: string;
  readonly method: string;
  readonly minScopes: ReadonlyArray<string>;
}> = [
  { pluginId: "builtin.egress-guard", method: "status", minScopes: [AuthOrchestrationReadScope] },
  {
    pluginId: "builtin.egress-guard",
    method: "runProof",
    minScopes: [AuthOrchestrationOperateScope],
  },
  {
    pluginId: "builtin.token-optimizer",
    method: "status",
    minScopes: [AuthOrchestrationReadScope],
  },
  { pluginId: "builtin.bots-core", method: "status", minScopes: [AuthOrchestrationReadScope] },
  { pluginId: "community.napcat-qq", method: "status", minScopes: [AuthOrchestrationReadScope] },
  { pluginId: "builtin.legacy-importer", method: "scan", minScopes: [AuthOrchestrationReadScope] },
  {
    pluginId: "builtin.legacy-importer",
    method: "import",
    minScopes: [AuthOrchestrationOperateScope],
  },
];

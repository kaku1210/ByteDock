import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostControlService from "../../../plugins/HostControlService.ts";
import * as PluginControlPlane from "../../../plugins/PluginControlPlane.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ApprovalSummarySchema = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals([
    "plugin-toggle",
    "plugin-config-patch",
    "local-plugin-enable",
    "host-settings-patch",
    "provider-mutation",
    "legacy-import",
    "system-action",
  ]),
  pluginId: Schema.String,
  riskLevel: Schema.Literals(["high"]),
  reasons: Schema.Array(Schema.String),
  summary: Schema.String,
  diffPreview: Schema.Struct({
    before: Schema.Unknown,
    after: Schema.Unknown,
  }),
  status: Schema.Literals(["pending", "approved", "rejected", "expired"]),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  resolvedAt: Schema.optionalKey(Schema.String),
  resolutionNote: Schema.optionalKey(Schema.String),
});

const PluginSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  revision: Schema.Int,
  execution: Schema.String,
  trust: Schema.String,
  status: Schema.Literals(["active", "degraded", "disabled"]),
  enabled: Schema.Boolean,
  approved: Schema.Boolean,
  config: Schema.Record(Schema.String, Schema.Unknown),
  sourcePath: Schema.optionalKey(Schema.String),
});

const ConfigDiagnosticSchema = Schema.Struct({
  filePath: Schema.String,
  pluginId: Schema.optionalKey(Schema.String),
  message: Schema.String,
  observedAt: Schema.String,
});

const ReloadDiagnosticSchema = Schema.Struct({
  pluginId: Schema.String,
  tag: Schema.String,
  file: Schema.String,
  line: Schema.Int,
  column: Schema.Int,
  message: Schema.String,
});

const HostActionOutcomeSchema = Schema.Struct({
  status: Schema.Literals(["ok", "applied", "approval_required"]),
  applied: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  approval: Schema.optionalKey(ApprovalSummarySchema),
  message: Schema.optionalKey(Schema.String),
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PluginControlPlane.PluginControlPlane,
    HostControlService.HostControlService,
  ],
};

const ByteDockConfigReadTool = Tool.make("bytedock_config_read", {
  ...shared,
  description:
    "Read ByteDock plugins.yml path, default ~/.bytedock/plugins path, active revision, every plugin's enabled/status/config, current Egress Guard firewall policy, recent hot-reload diagnostics, and pending human approval requests.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    pluginConfigPath: Schema.String,
    pluginsDir: Schema.String,
    mtimeMs: Schema.Number,
    activeRevision: Schema.Int,
    plugins: Schema.Array(PluginSummarySchema),
    egressPolicy: Schema.Struct({
      mode: Schema.Literals(["strict", "audit-only"]),
      allowedHosts: Schema.Array(Schema.String),
      allowLoopbackHosts: Schema.Array(Schema.String),
      deniedDomains: Schema.Array(Schema.String),
      allowUdp: Schema.Boolean,
    }),
    lastConfigDiagnostic: Schema.optionalKey(ConfigDiagnosticSchema),
    lastReloadDiagnostic: Schema.optionalKey(ReloadDiagnosticSchema),
    approvals: Schema.Array(ApprovalSummarySchema),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MutationResultSchema = Schema.Struct({
  status: Schema.Literals(["applied", "approval_required"]),
  pluginId: Schema.String,
  applied: Schema.Boolean,
  enabled: Schema.optionalKey(Schema.Boolean),
  pluginStatus: Schema.optionalKey(Schema.Literals(["active", "degraded", "disabled"])),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  activeRevision: Schema.optionalKey(Schema.Int),
  mtimeMs: Schema.optionalKey(Schema.Number),
  approval: Schema.optionalKey(ApprovalSummarySchema),
  message: Schema.optionalKey(Schema.String),
});

const ByteDockPluginSetEnabledTool = Tool.make("bytedock_plugin_set_enabled", {
  ...shared,
  description:
    "Enable or disable a ByteDock plugin and hot-reload immediately via plugins.yml. Normal plugins apply right away. Disabling builtin.egress-guard or enabling an unapproved local plugin in ~/.bytedock/plugins requires a live local main session and human approval in ByteDock Control Center.",
  parameters: Schema.Struct({
    pluginId: Schema.String.check(Schema.isMinLength(1)),
    enabled: Schema.Boolean,
    expectedMtimeMs: Schema.optionalKey(Schema.Number),
  }),
  success: MutationResultSchema,
}).annotate(Tool.Destructive, true);

const ByteDockPluginConfigPatchTool = Tool.make("bytedock_plugin_config_patch", {
  ...shared,
  description:
    "Patch a ByteDock plugin's declarative config in plugins.yml with schema validation and immediate hot-reload. Plaintext secrets are forbidden. Firewall (builtin.egress-guard) changes require a live local main session; firewall relaxations/mode changes and sensitive permission expansions return approval_required for human review.",
  parameters: Schema.Struct({
    pluginId: Schema.String.check(Schema.isMinLength(1)),
    patch: Schema.Record(Schema.String, Schema.Unknown),
    expectedMtimeMs: Schema.optionalKey(Schema.Number),
  }),
  success: MutationResultSchema,
}).annotate(Tool.Destructive, true);

const ByteDockPluginsReloadTool = Tool.make("bytedock_plugins_reload", {
  ...shared,
  description:
    "Re-read ByteDock plugins.yml and scan default ~/.bytedock/plugins directory for immediate hot-reload, returning activeRevision or exact file/line/column diagnostics if compilation or config validation failed.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    status: Schema.Literals(["reloaded", "skipped-unchanged", "kept-previous-on-error"]),
    previousRevision: Schema.Int,
    activeRevision: Schema.Int,
    mtimeMs: Schema.Number,
    pluginCount: Schema.Int,
    configDiagnostic: Schema.optionalKey(ConfigDiagnosticSchema),
    reloadDiagnostic: Schema.optionalKey(ReloadDiagnosticSchema),
  }),
}).annotate(Tool.Destructive, false);

const ByteDockCapabilitiesCatalogTool = Tool.make("bytedock_capabilities_catalog", {
  ...shared,
  description:
    "List every ByteDock AI control domain, MCP tool, action, risk tier (read-only/low-risk/high-risk), approval policy, live host service availability, active plugin revision, and pending approvals count.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    version: Schema.Literal("1.0"),
    policy: Schema.Struct({
      lowRisk: Schema.String,
      highRisk: Schema.String,
      secrets: Schema.String,
    }),
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        domain: Schema.String,
        riskTier: Schema.Literals(["read-only", "low-risk", "mixed", "high-risk"]),
        actions: Schema.Array(
          Schema.Struct({
            action: Schema.String,
            risk: Schema.Literals(["read-only", "low-risk", "high-risk", "conditional"]),
            description: Schema.String,
          }),
        ),
      }),
    ),
    services: Schema.Struct({
      pluginControlPlane: Schema.Boolean,
      serverSettings: Schema.Boolean,
      keybindings: Schema.Boolean,
      hostResources: Schema.Boolean,
      storageCleanup: Schema.Boolean,
      databaseStorage: Schema.Boolean,
      externalTunnel: Schema.Boolean,
      externalLauncher: Schema.Boolean,
      terminalManager: Schema.Boolean,
    }),
    activeRevision: Schema.Int,
    pendingApprovalsCount: Schema.Int,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ByteDockSettingsControlTool = Tool.make("bytedock_settings_control", {
  ...shared,
  description:
    "Read redacted ByteDock ServerSettings, keybindings, and available editors, or apply tiered updates: low-risk settings and keybinding upserts/removals apply directly; high-risk settings (providers, models, tunnel, sharing, device, browser, runtime mode, scripts, observability) and update_provider require a live local main session and human approval. Plaintext secrets are always forbidden.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "read",
      "patch_settings",
      "upsert_keybinding",
      "remove_keybinding",
      "update_provider",
    ]),
    patch: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    rule: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    mutation: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: HostActionOutcomeSchema,
}).annotate(Tool.Destructive, true);

const ByteDockPluginActionTool = Tool.make("bytedock_plugin_action", {
  ...shared,
  description:
    "Execute ByteDock plugin actions: egress_audit (read firewall audit & policy), egress_proof (run dual-segment EgressProof), legacy_scan (read-only scan of T3 Code / T3 Code Plus data), legacy_import (main-session + human approval required), invoke (call an enabled non-privileged plugin RPC), or scaffold_local_plugin (safely create a disabled/unapproved plugin skeleton in ~/.bytedock/plugins).",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "egress_proof",
      "egress_audit",
      "legacy_scan",
      "legacy_import",
      "invoke",
      "scaffold_local_plugin",
    ]),
    pluginId: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.String),
    payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    customSourceDir: Schema.optionalKey(Schema.String),
    sourceBaseDir: Schema.optionalKey(Schema.String),
    sourceBrand: Schema.optionalKey(Schema.Literals(["t3-plus", "t3", "custom"])),
    categories: Schema.optionalKey(Schema.Array(Schema.String)),
    overwrite: Schema.optionalKey(Schema.Boolean),
    deferLockedStateDb: Schema.optionalKey(Schema.Boolean),
    displayName: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int),
  }),
  success: HostActionOutcomeSchema,
}).annotate(Tool.Destructive, true);

const ByteDockUiControlTool = Tool.make("bytedock_ui_control", {
  ...shared,
  description:
    "Control ByteDock Web/Desktop UI in real time via the control-plane event bus: open/close ByteDock Control Center ('plugins' or 'import' tab), open/close the right plugin dock panel with a validated 12-primitive JsonNode, navigate to a safe internal '/' route, or display a notification banner.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "open_control_center",
      "close_control_center",
      "open_dock_panel",
      "close_dock_panel",
      "navigate",
      "notify",
    ]),
    tab: Schema.optionalKey(Schema.Literals(["plugins", "import"])),
    pluginId: Schema.optionalKey(Schema.String),
    node: Schema.optionalKey(Schema.Unknown),
    path: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    level: Schema.optionalKey(Schema.Literals(["info", "success", "warning", "error"])),
  }),
  success: HostActionOutcomeSchema,
}).annotate(Tool.Destructive, false);

const ByteDockSystemControlTool = Tool.make("bytedock_system_control", {
  ...shared,
  description:
    "Inspect and control ByteDock host system capabilities: status (CPU/RAM, storage cleanup report, DB storage, external tunnel, editors), open_editor (low-risk direct launch), or high-risk actions requiring a live local main session and human approval (storage_cleanup, database_reclaim, tunnel_action, terminal_open, terminal_write, terminal_close).",
  parameters: Schema.Struct({
    action: Schema.Literals([
      "status",
      "open_editor",
      "storage_cleanup",
      "database_reclaim",
      "tunnel_action",
      "terminal_open",
      "terminal_write",
      "terminal_close",
    ]),
    payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: HostActionOutcomeSchema,
}).annotate(Tool.Destructive, true);

export const ByteDockControlToolkit = Toolkit.make(
  ByteDockConfigReadTool,
  ByteDockPluginSetEnabledTool,
  ByteDockPluginConfigPatchTool,
  ByteDockPluginsReloadTool,
  ByteDockCapabilitiesCatalogTool,
  ByteDockSettingsControlTool,
  ByteDockPluginActionTool,
  ByteDockUiControlTool,
  ByteDockSystemControlTool,
);

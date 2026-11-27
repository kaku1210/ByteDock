import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PluginControlPlane from "../../../plugins/PluginControlPlane.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ApprovalSummarySchema = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals(["plugin-toggle", "plugin-config-patch", "local-plugin-enable"]),
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

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PluginControlPlane.PluginControlPlane,
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

export const ByteDockControlToolkit = Toolkit.make(
  ByteDockConfigReadTool,
  ByteDockPluginSetEnabledTool,
  ByteDockPluginConfigPatchTool,
  ByteDockPluginsReloadTool,
);

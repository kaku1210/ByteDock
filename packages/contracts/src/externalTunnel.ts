import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ExternalTunnelSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  entryPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  args: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  healthUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  logPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  monitorIntervalSec: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  alertOnFailure: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ExternalTunnelSettings = typeof ExternalTunnelSettings.Type;

export const DEFAULT_EXTERNAL_TUNNEL_SETTINGS: ExternalTunnelSettings = Schema.decodeSync(
  ExternalTunnelSettings,
)({});

export const ExternalTunnelHealthStateSchema = Schema.Literals([
  "unknown",
  "healthy",
  "degraded",
  "unhealthy",
]);
export type ExternalTunnelHealthState = typeof ExternalTunnelHealthStateSchema.Type;

export const ExternalTunnelAlertCodeSchema = Schema.Literals([
  "hy2_auth_or_handshake",
  "frp_auth_or_connect",
  "av_blocked",
  "process_exited",
  "health_check_failed",
  "config_missing",
  "unknown",
]);
export type ExternalTunnelAlertCode = typeof ExternalTunnelAlertCodeSchema.Type;

export const ExternalTunnelAlertSchema = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
  code: ExternalTunnelAlertCodeSchema,
  title: Schema.String,
  detail: Schema.String,
  hint: Schema.String,
  detectedAt: Schema.String,
  acknowledgedAt: Schema.NullOr(Schema.String),
});
export type ExternalTunnelAlert = typeof ExternalTunnelAlertSchema.Type;

export const ExternalTunnelStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  running: Schema.Boolean,
  pid: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.String),
  entryPath: Schema.String,
  healthUrl: Schema.String,
  logPath: Schema.String,
  healthState: ExternalTunnelHealthStateSchema,
  healthLatencyMs: Schema.NullOr(Schema.Number),
  healthStatusCode: Schema.NullOr(Schema.Number),
  lastCheckedAt: Schema.NullOr(Schema.String),
  alert: Schema.NullOr(ExternalTunnelAlertSchema),
  recentLogs: Schema.Array(Schema.String),
});
export type ExternalTunnelStatus = typeof ExternalTunnelStatusSchema.Type;

export const ExternalTunnelCandidateKindSchema = Schema.Literals([
  "launcher",
  "frpc",
  "hysteria",
  "ssh_script",
  "cloudflared",
  "other",
]);
export type ExternalTunnelCandidateKind = typeof ExternalTunnelCandidateKindSchema.Type;

export const ExternalTunnelCandidateSchema = Schema.Struct({
  path: Schema.String,
  kind: ExternalTunnelCandidateKindSchema,
  label: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
  suggestedLogPath: Schema.NullOr(Schema.String),
});
export type ExternalTunnelCandidate = typeof ExternalTunnelCandidateSchema.Type;

export const ExternalTunnelScanInput = Schema.Struct({
  searchPath: Schema.String,
  maxDepth: Schema.optionalKey(Schema.Int),
});
export type ExternalTunnelScanInput = typeof ExternalTunnelScanInput.Type;

export const ExternalTunnelScanEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    scannedDirs: Schema.Number,
    scannedFiles: Schema.Number,
    currentDir: Schema.String,
    percent: Schema.Number,
    candidates: Schema.Array(ExternalTunnelCandidateSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    scannedDirs: Schema.Number,
    scannedFiles: Schema.Number,
    truncated: Schema.Boolean,
    candidates: Schema.Array(ExternalTunnelCandidateSchema),
  }),
]);
export type ExternalTunnelScanEvent = typeof ExternalTunnelScanEventSchema.Type;

export const ExternalTunnelToolNameSchema = Schema.Literals(["hysteria", "frpc"]);
export type ExternalTunnelToolName = typeof ExternalTunnelToolNameSchema.Type;

export const ExternalTunnelModeSchema = Schema.Literals(["auto", "frp", "ssh"]);
export type ExternalTunnelMode = typeof ExternalTunnelModeSchema.Type;

export const ExternalTunnelInstallInput = Schema.Struct({
  installDir: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(Schema.Array(ExternalTunnelToolNameSchema)),
  serverAddress: Schema.optionalKey(Schema.String),
  sni: Schema.optionalKey(Schema.String),
  hy2Auth: Schema.optionalKey(Schema.String),
  frpToken: Schema.optionalKey(Schema.String),
  remotePort: Schema.optionalKey(Schema.Int),
  localPort: Schema.optionalKey(Schema.Int),
  sshTarget: Schema.optionalKey(Schema.String),
  healthUrl: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(ExternalTunnelModeSchema),
  autoStart: Schema.optionalKey(Schema.Boolean),
});
export type ExternalTunnelInstallInput = typeof ExternalTunnelInstallInput.Type;

export const ExternalTunnelInstalledToolSchema = Schema.Struct({
  tool: ExternalTunnelToolNameSchema,
  path: Schema.String,
  version: Schema.NullOr(Schema.String),
  blockedByAv: Schema.Boolean,
  note: Schema.optionalKey(Schema.String),
});
export type ExternalTunnelInstalledTool = typeof ExternalTunnelInstalledToolSchema.Type;

export const ExternalTunnelInstallEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: Schema.String,
    message: Schema.String,
    percent: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    installDir: Schema.String,
    entryPath: Schema.String,
    logPath: Schema.String,
    installedTools: Schema.Array(ExternalTunnelInstalledToolSchema),
    status: ExternalTunnelStatusSchema,
  }),
]);
export type ExternalTunnelInstallEvent = typeof ExternalTunnelInstallEventSchema.Type;

export const ExternalTunnelActionInput = Schema.Struct({
  action: Schema.Literals(["start", "stop", "restart", "check", "acknowledgeAlert"]),
});
export type ExternalTunnelActionInput = typeof ExternalTunnelActionInput.Type;

export const ExternalTunnelBundleExportInput = Schema.Struct({
  targetHostName: Schema.String,
  remotePort: Schema.Int,
  subdomain: Schema.optionalKey(Schema.String),
  includeCredentials: Schema.optionalKey(Schema.Boolean),
});
export type ExternalTunnelBundleExportInput = typeof ExternalTunnelBundleExportInput.Type;

export const ExternalTunnelBundleExportResult = Schema.Struct({
  bundleJson: Schema.String,
  caddySnippet: Schema.String,
  summary: Schema.String,
});
export type ExternalTunnelBundleExportResult = typeof ExternalTunnelBundleExportResult.Type;

export const ExternalTunnelBundleImportInput = Schema.Struct({
  bundleJson: Schema.String,
  installDir: Schema.optionalKey(Schema.String),
  autoInstallTools: Schema.optionalKey(Schema.Boolean),
  autoStart: Schema.optionalKey(Schema.Boolean),
});
export type ExternalTunnelBundleImportInput = typeof ExternalTunnelBundleImportInput.Type;

export class ExternalTunnelOperationError extends Schema.TaggedError<ExternalTunnelOperationError>()(
  "ExternalTunnelOperationError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

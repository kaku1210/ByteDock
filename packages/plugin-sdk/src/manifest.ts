import * as Schema from "effect/Schema";

export const PluginExecutionTier = Schema.Literals([
  "data",
  "declarative",
  "sandboxed-ui",
  "trusted-worker",
]);
export type PluginExecutionTier = typeof PluginExecutionTier.Type;

export const PluginTrustLevel = Schema.Literals(["builtin", "local-dev", "community"]);
export type PluginTrustLevel = typeof PluginTrustLevel.Type;

export const PluginHookName = Schema.Literals([
  "agent.open.before",
  "agent.turn.before",
  "agent.compact.before",
  "agent.tool.before",
  "agent.tool.after",
  "egress.request.before",
  "worktree.create.before",
]);
export type PluginHookName = typeof PluginHookName.Type;

export const PluginStoragePolicy = Schema.Literals(["none", "kv", "isolated-sqlite"]);
export type PluginStoragePolicy = typeof PluginStoragePolicy.Type;

export const PluginHookDeclaration = Schema.Struct({
  name: PluginHookName,
  onError: Schema.Literals(["pass", "deny"]),
  timeoutMs: Schema.optionalKey(Schema.Number),
});
export type PluginHookDeclaration = typeof PluginHookDeclaration.Type;

export const PluginWebhookAuthMode = Schema.Literals(["none", "token", "host-session"]);
export type PluginWebhookAuthMode = typeof PluginWebhookAuthMode.Type;

export const PluginWebhookContribution = Schema.Struct({
  route: Schema.String,
  auth: PluginWebhookAuthMode,
  tokenSecretRef: Schema.optionalKey(Schema.String),
  hmac: Schema.optionalKey(
    Schema.Struct({
      algorithm: Schema.Literals(["sha1", "sha256"]),
      mode: Schema.Literals(["onebot-custom", "standard-hex"]),
      rawBody: Schema.Boolean,
    }),
  ),
  replayDefense: Schema.optionalKey(
    Schema.Struct({
      requireMonotonicSeq: Schema.Boolean,
      windowSeconds: Schema.Number,
    }),
  ),
  rateLimitPerMin: Schema.optionalKey(Schema.Number),
  frameOptions: Schema.optionalKey(Schema.Literals(["DENY"])),
});
export type PluginWebhookContribution = typeof PluginWebhookContribution.Type;

export const PluginPanelContribution = Schema.Struct({
  id: Schema.String,
  titleI18n: Schema.String,
  icon: Schema.String,
  mode: Schema.Literals(["declarative", "sandbox-iframe", "native"]),
  defaultArea: Schema.optionalKey(Schema.Literals(["right", "bottom", "tab"])),
});
export type PluginPanelContribution = typeof PluginPanelContribution.Type;

export const ByteDockPluginManifest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  apiVersion: Schema.String,
  execution: PluginExecutionTier,
  trust: PluginTrustLevel,
  entry: Schema.optionalKey(
    Schema.Struct({
      server: Schema.optionalKey(Schema.String),
      client: Schema.optionalKey(Schema.String),
      sandboxHtml: Schema.optionalKey(Schema.String),
    }),
  ),
  permissions: Schema.Struct({
    rpcScopes: Schema.optionalKey(Schema.Array(Schema.String)),
    networkHosts: Schema.optionalKey(Schema.Array(Schema.String)),
    secretNamespaces: Schema.optionalKey(Schema.Array(Schema.String)),
    storage: Schema.optionalKey(PluginStoragePolicy),
    hooks: Schema.optionalKey(Schema.Array(PluginHookDeclaration)),
  }),
  contributes: Schema.optionalKey(
    Schema.Struct({
      panels: Schema.optionalKey(Schema.Array(PluginPanelContribution)),
      settingsSection: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          titleI18n: Schema.String,
          group: Schema.String,
          icon: Schema.String,
        }),
      ),
      statusBarItems: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            align: Schema.Literals(["left", "right"]),
            priority: Schema.optionalKey(Schema.Number),
          }),
        ),
      ),
      timelineRenderers: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            matchType: Schema.String,
          }),
        ),
      ),
      commands: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            titleI18n: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      webhooks: Schema.optionalKey(Schema.Array(PluginWebhookContribution)),
    }),
  ),
});
export type ByteDockPluginManifest = typeof ByteDockPluginManifest.Type;

export const decodePluginManifest = Schema.decodeUnknownEffect(ByteDockPluginManifest);

export const PluginRuntimeDescriptor = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  revision: Schema.Number,
  execution: PluginExecutionTier,
  trust: PluginTrustLevel,
  status: Schema.Literals(["active", "degraded", "disabled"]),
  localeHash: Schema.optionalKey(Schema.String),
});
export type PluginRuntimeDescriptor = typeof PluginRuntimeDescriptor.Type;

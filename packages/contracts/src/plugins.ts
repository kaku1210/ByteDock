import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Runtime descriptor published in ExecutionEnvironmentCapabilities.plugins (Seam 3)
 * and returned by plugins.list (Seam 1). Always carries `revision` so clients track
 * hot-reload transitions without reading closed ServerSettings (ADR-05).
 */
export const PluginRuntimeDescriptorSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  revision: Schema.Int,
  execution: Schema.Literals(["data", "declarative", "sandboxed-ui", "trusted-worker"]),
  trust: Schema.Literals(["builtin", "local-dev", "community"]),
  status: Schema.Literals(["active", "degraded", "disabled"]),
  localeHash: Schema.optionalKey(Schema.String),
});
export type PluginRuntimeDescriptorSchema = typeof PluginRuntimeDescriptorSchema.Type;

export const PluginStreamQos = Schema.Literals(["interactive", "log", "diagnostic"]);
export type PluginStreamQos = typeof PluginStreamQos.Type;

export class PluginRpcError extends Schema.TaggedError<PluginRpcError>()("PluginRpcError", {
  code: Schema.Literals([
    "unknown_namespace",
    "unauthorized",
    "plugin_not_found",
    "reload_failed",
    "invoke_failed",
  ]),
  message: Schema.String,
  pluginId: Schema.optionalKey(Schema.String),
}) {}

export const PluginsListInput = Schema.Struct({});
export type PluginsListInput = typeof PluginsListInput.Type;

export const PluginsListResult = Schema.Struct({
  activeRevision: Schema.Int,
  plugins: Schema.Array(PluginRuntimeDescriptorSchema),
});
export type PluginsListResult = typeof PluginsListResult.Type;

export const PluginsReloadInput = Schema.Struct({
  pluginId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PluginsReloadInput = typeof PluginsReloadInput.Type;

export const PluginsReloadResult = Schema.Struct({
  previousRevision: Schema.Int,
  activeRevision: Schema.Int,
  plugins: Schema.Array(PluginRuntimeDescriptorSchema),
});
export type PluginsReloadResult = typeof PluginsReloadResult.Type;

export const PluginsInvokeInput = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  method: TrimmedNonEmptyString,
  payload: Schema.optionalKey(Schema.Unknown),
  expectedRevision: Schema.optionalKey(Schema.Int),
});
export type PluginsInvokeInput = typeof PluginsInvokeInput.Type;

export const PluginsInvokeResult = Schema.Struct({
  revision: Schema.Int,
  auditId: TrimmedNonEmptyString,
  result: Schema.Unknown,
});
export type PluginsInvokeResult = typeof PluginsInvokeResult.Type;

export const PluginsSubscribeInput = Schema.Struct({
  pluginId: TrimmedNonEmptyString,
  topic: TrimmedNonEmptyString,
  /** Optional cursor for reconnect resumption (since(cursor) contract, Seam 1 / Seam 12). */
  sinceCursor: Schema.optionalKey(Schema.String),
  /** Stream QoS tier; mobile cellular clients may suppress "log" / "diagnostic" tiers. */
  qos: Schema.optionalKey(PluginStreamQos),
});
export type PluginsSubscribeInput = typeof PluginsSubscribeInput.Type;

export const PluginsStreamEvent = Schema.Struct({
  cursor: Schema.String,
  revision: Schema.Int,
  pluginId: TrimmedNonEmptyString,
  topic: TrimmedNonEmptyString,
  qos: PluginStreamQos,
  payload: Schema.Unknown,
});
export type PluginsStreamEvent = typeof PluginsStreamEvent.Type;

import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema"; // bytedock-seam-import:secret-ns-broker

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    return SecretResolverCore.layer({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
    });
  }),
);

// bytedock-seam:secret-ns-broker
const SECRET_REF_PATTERN = /^([a-z0-9][a-z0-9._-]{0,63})\.([A-Za-z0-9._-]{1,128})$/;

export class PluginSecretNamespaceError extends Schema.TaggedError<PluginSecretNamespaceError>()(
  "PluginSecretNamespaceError",
  {
    pluginId: Schema.String,
    secretRef: Schema.String,
    reason: Schema.Literals(["invalid_format", "namespace_not_declared"]),
  },
) {}

/**
 * Validates that a plugin's `secretRef` (`<ns>.<name>`) belongs to its Manifest `secretNamespaces`
 * allowlist before any secret lookup occurs (Seam 16 / ADR-08).
 */
export const assertPluginSecretRefAllowed = Effect.fn(
  "SecretResolver.assertPluginSecretRefAllowed",
)(function* (input: {
  readonly pluginId: string;
  readonly declaredNamespaces: ReadonlyArray<string>;
  readonly secretRef: string;
}) {
  const match = SECRET_REF_PATTERN.exec(input.secretRef);
  if (!match?.[1] || !match[2]) {
    return yield* new PluginSecretNamespaceError({
      pluginId: input.pluginId,
      secretRef: input.secretRef,
      reason: "invalid_format",
    });
  }
  const namespace = match[1];
  if (!input.declaredNamespaces.includes(namespace)) {
    return yield* new PluginSecretNamespaceError({
      pluginId: input.pluginId,
      secretRef: input.secretRef,
      reason: "namespace_not_declared",
    });
  }
  return { namespace, key: match[2] } as const;
});
// end-bytedock-seam:secret-ns-broker

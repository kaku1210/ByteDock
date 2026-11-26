import Constants from "expo-constants";
import * as RelayTracing from "@t3tools/shared/relayTracing";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

/** Outbound mobile relay OTLP/Axiom tracing is removed in T3 Code Plus. */
export function resolveTracingConfig(): TracingConfig | null {
  return null;
}

export function layerFromConfig(_config: TracingConfig | null, resource: TracingResource) {
  return RelayTracing.layer(null, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    serviceInstanceId: resource.serviceInstanceId,
    client: `mobile-${resource.appVariant}`,
  });
}

export const layer = layerFromConfig(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  serviceInstanceId: Constants.sessionId,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});

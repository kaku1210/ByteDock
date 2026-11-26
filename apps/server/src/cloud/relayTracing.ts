import type { ManagedPolicySummary } from "@t3tools/contracts";
import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";

/** Outbound relay tracing export is removed in T3 Code Plus; always returns false. */
export const allowedFor = (
  _env: Readonly<Record<string, string | undefined>>,
  _policy: ManagedPolicySummary | undefined,
) => false;

/** Outbound relay tracing export is removed in T3 Code Plus; always provides a no-op tracer. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  _tracingConfig: RelayTracing.RelayClientTracingConfig | null = null,
) => RelayTracing.layer(null, { ...resource, serviceInstanceId: processServiceInstanceId() });

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});

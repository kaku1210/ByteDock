import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TelemetryOwnerSource = Schema.Literals(["connect", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  readonly ownerId: string;
}

/**
 * Product telemetry identity collection is removed in T3 Code Plus:
 * never generates or reads `anonymous-id` or links provider/Connect accounts.
 */
export const getTelemetryIdentity = Effect.succeed({
  distinctId: null as string | null,
  installId: null as string | null,
});

export const getServerOwners = Effect.succeed<ReadonlyArray<TelemetryOwner>>([]);

import { assert, it, vi } from "@effect/vitest";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import { allowedFor, relayLayer } from "./relayTracing.ts";

it.effect("relayLayer never attaches an external relay tracer or sends requests", () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layer = Layer.mergeAll(
    relayLayer(
      { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
      { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
    ),
    FetchHttpClient.layer,
  );
  return Effect.gen(function* () {
    const tracer = yield* RelayTracing.RelayClientTracer;
    assert.isTrue(Option.isNone(tracer));
    yield* Effect.void.pipe(Effect.withSpan("relay.request"), RelayTracing.withRelayClientTracing);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(FetchHttpClient.Fetch, fetchFn),
    Effect.andThen(Effect.sync(() => assert.strictEqual(fetchFn.mock.calls.length, 0))),
  );
});

it("always reports relay tracing as disabled to clients", () => {
  assert.isFalse(allowedFor({}, undefined));
  assert.isFalse(allowedFor({ T3CODE_TELEMETRY_ENABLED: "true" }, undefined));
  assert.isFalse(allowedFor({ T3CODE_TELEMETRY_ENABLED: "false" }, undefined));
  assert.isFalse(allowedFor({ CI: "true", T3CODE_TELEMETRY_ENABLED: "true" }, undefined));
});

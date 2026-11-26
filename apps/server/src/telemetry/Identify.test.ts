import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Identify from "./Identify.ts";

it.effect("returns empty telemetry identity and no owners", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* Identify.getTelemetryIdentity, {
      distinctId: null,
      installId: null,
    });
    assert.deepEqual(yield* Identify.getServerOwners, []);
  }),
);

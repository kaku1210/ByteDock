import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(AnalyticsService.layer)("AnalyticsService test", (it) => {
  it.effect("is a permanent no-op and never records or sends telemetry", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      assert.isFalse(yield* analytics.record("server.boot.heartbeat", { projectCount: 1 }));
      assert.isFalse(yield* analytics.record("agent.feedback", {}, { anonymous: true }));
      yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
      yield* analytics.flush;
    }),
  );
});

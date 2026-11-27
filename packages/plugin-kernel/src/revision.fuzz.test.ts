import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { computeRevisionPolicy, makeRevisionManager } from "./revision.ts";
import { makeThreadSessionGate } from "./sessionGate.ts";

describe("W1-5 Revision Pinning state machine + 1000-step fuzz (I1-I5)", () => {
  it.effect(
    "anchors drainDeadline to frozenAt (never installedAt) and survives sleep wakeup calibration",
    () =>
      Effect.gen(function* () {
        const mgr = yield* makeRevisionManager({
          graceMs: 30_000,
          forceReapMs: 5 * 60_000, // Short 5-min dev forceReapMs verifies linked touch throttle!
        });

        // Verify R3 Target 1.4 linked throttle formula: forceReapMs=5min -> maxIntervalMs=75s.
        assert.equal(mgr.policy.touch.maxIntervalMs, 75_000);

        const t0 = 1_000_000;
        const rev1 = yield* mgr.pin("sess-A", t0);
        assert.equal(rev1, 1);

        // Rev 1 runs for 48 hours before a reload freezes it.
        const freezeTime = t0 + 48 * 60 * 60_000;
        const rev2 = yield* mgr.installRevision({ manifests: [], nowMs: freezeTime });
        assert.equal(rev2.rev, 2);

        const all = yield* mgr.revisions();
        const oldRev = all.find((r) => r.rev === 1);
        assert.isDefined(oldRev);
        assert.equal(oldRev.frozenAt, freezeTime);
        assert.equal(oldRev.drainDeadline, freezeTime + 30_000);
        assert.equal(oldRev.forceReapAt, freezeTime + 5 * 60_000);

        // Even after unpinning, rev1 must NOT evict before frozenAt + graceMs.
        yield* mgr.unpin("sess-A", "closed", freezeTime + 1_000);
        const earlyEvicted = yield* mgr.sweep(freezeTime + 10_000);
        assert.deepStrictEqual(earlyEvicted, []);

        // After frozenAt + graceMs with refCount=0, rev1 closes cleanly.
        const evicted = yield* mgr.sweep(freezeTime + 31_000);
        assert.deepStrictEqual(evicted, [1]);
        assert.equal(yield* mgr.stateOf(1), "closed");

        // Simulate 8h OS sleep wakeup calibration on active pin.
        yield* mgr.pin("sess-B", freezeTime + 32_000);
        const calibrated = yield* mgr.touchPin("sess-B", freezeTime + 8 * 60 * 60_000, {
          isWakeupCalibration: true,
        });
        assert.isTrue(calibrated);
        assert.equal((yield* mgr.getPin("sess-B"))?.state, "live");
        yield* mgr.assertInvariants();
      }),
  );

  it.effect("holds invariants I1-I5 across 1000 randomized interleaved events", () =>
    Effect.gen(function* () {
      const policy = computeRevisionPolicy({ graceMs: 1_000, forceReapMs: 60_000 });
      const mgr = yield* makeRevisionManager(policy);
      const gate = yield* makeThreadSessionGate();

      let seed = 0x5eed1234;
      const nextRand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };

      const sessions = ["t-1", "t-2", "t-3", "t-4", "t-5"];
      let nowMs = 10_000_000;

      for (let step = 0; step < 1000; step += 1) {
        nowMs += Math.floor(nextRand() * 4_000);
        const r = nextRand();
        const sid = sessions[Math.floor(nextRand() * sessions.length)]!;

        if (r < 0.3) {
          yield* gate.withGate(sid, () => mgr.pin(sid, nowMs));
        } else if (r < 0.5) {
          yield* gate.withGate(sid, () =>
            mgr.unpin(sid, nextRand() < 0.5 ? "closed" : "idle-detach", nowMs),
          );
        } else if (r < 0.65) {
          yield* mgr.touchPin(sid, nowMs, { isWakeupCalibration: nextRand() < 0.1 });
        } else if (r < 0.8) {
          yield* mgr.installRevision({ manifests: [], nowMs });
        } else {
          yield* mgr.sweep(nowMs);
        }

        yield* mgr.assertInvariants();
      }
    }),
  );
});

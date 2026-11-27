// @effect-diagnostics nodeBuiltinImport:off -- Hot-reload test creates temp entry paths under os.tmpdir.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import { makeHostModuleRegistry } from "./hostModules.ts";
import { makeHotReloadController } from "./hotReload.ts";
import { makeRevisionManager } from "./revision.ts";

const SAMPLE_MANIFEST: ByteDockPluginManifest = {
  id: "local.reload-sample",
  name: "Reload Sample",
  version: "0.1.0",
  apiVersion: "0.1.0",
  execution: "trusted-worker",
  trust: "local-dev",
  entry: { server: "index.ts" },
  permissions: {},
};

/**
 * W3-3 Hot-reload MVP verification: contentHash idempotency, keep-previous-on-error with exact
 * file:line:column diagnostics, atomic revision swap, and revision drain/evict cleanup.
 */
describe("W3-3 Scheme alpha leak-free hot-reload controller", () => {
  it.effect(
    "skips unchanged hashes, preserves active revision on syntax/whitelist errors, and drains old revision cleanly",
    () =>
      Effect.gen(function* () {
        const hostModules = makeHostModuleRegistry();
        const revisions = yield* makeRevisionManager({ graceMs: 1_000, forceReapMs: 60_000 });
        const controller = yield* makeHotReloadController({ hostModules, revisions });
        const entryPath = NodePath.join(NodeOS.tmpdir(), "bytedock-hotreload", "index.ts");

        // 1. Initial valid load -> rev 2 becomes active.
        const first = yield* controller.reloadFromSources(
          [
            {
              manifest: SAMPLE_MANIFEST,
              entryPath,
              inlineSource: `export const version = "v1";`,
            },
          ],
          { nowMs: 1_000 },
        );
        assert.deepStrictEqual(first, { status: "reloaded", previousRev: 1, activeRev: 2 });

        // 2. Identical save storm -> idempotent skip (no new revision).
        const dup = yield* controller.reloadFromSources(
          [
            {
              manifest: SAMPLE_MANIFEST,
              entryPath,
              inlineSource: `export const version = "v1";`,
            },
          ],
          { nowMs: 1_100 },
        );
        assert.deepStrictEqual(dup, { status: "skipped-unchanged", activeRev: 2 });

        // Pin a live session onto rev 2.
        const pinned = yield* revisions.pin("session-A", 1_200);
        assert.strictEqual(pinned, 2);

        // 3. Broken edit (forbidden node:child_process) -> rev 2 stays active, exact diagnostic returned.
        const broken = yield* controller.reloadFromSources(
          [
            {
              manifest: SAMPLE_MANIFEST,
              entryPath,
              inlineSource: `import { execSync } from "node:child_process";\nexport const bad = execSync;`,
            },
          ],
          { nowMs: 1_500 },
        );
        assert.strictEqual(broken.status, "kept-previous-on-error");
        if (broken.status === "kept-previous-on-error") {
          assert.strictEqual(broken.activeRev, 2);
          assert.strictEqual(broken.error.pluginId, "local.reload-sample");
          assert.isTrue(broken.error.line >= 1);
        }
        assert.strictEqual((yield* revisions.active()).rev, 2);

        // 4. Fixed v2 edit -> rev 3 becomes active; rev 2 freezes while session-A still pinned.
        const v2 = yield* controller.reloadFromSources(
          [
            {
              manifest: SAMPLE_MANIFEST,
              entryPath,
              inlineSource: `export const version = "v2";`,
            },
          ],
          { nowMs: 2_000 },
        );
        assert.deepStrictEqual(v2, { status: "reloaded", previousRev: 2, activeRev: 3 });
        assert.strictEqual(yield* revisions.stateOf(2), "draining");

        // 5. Unpin session-A and sweep past graceMs -> rev 2 closes and drops module refs (I4).
        yield* revisions.unpin("session-A", "closed", 2_500);
        const evicted = yield* revisions.sweep(3_500);
        assert.include(evicted, 2);
        assert.strictEqual(yield* revisions.stateOf(2), "closed");
        yield* revisions.assertInvariants();
      }),
  );
});

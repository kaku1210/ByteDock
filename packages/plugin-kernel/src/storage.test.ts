// @effect-diagnostics nodeBuiltinImport:off -- Storage test exercises temporary files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { makePluginConfigService } from "./configService.ts";
import {
  openHashChainedAuditLog,
  openIsolatedPluginSqlite,
  openPluginKvPool,
  PLUGIN_KV_MAX_VALUE_BYTES,
} from "./storage.ts";

describe("W1-6 Four-tier storage + plugins.yml CAS + hash-chained JSONL", () => {
  it.effect("enforces plugin_kv 64KB hard limit, TTL expiry, and isolated-sqlite separation", () =>
    Effect.gen(function* () {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-storage-"));
      try {
        const kv = openPluginKvPool(NodePath.join(tmp, "statev2.sqlite"));
        yield* kv.set("builtin.egress-guard", "pin", "s1", JSON.stringify({ rev: 1 }), 5000);
        assert.equal(kv.get("builtin.egress-guard", "pin", "s1", 4000), '{"rev":1}');
        assert.isUndefined(kv.get("builtin.egress-guard", "pin", "s1", 6000));

        // Reject values > 64KB instead of truncating.
        const oversized = JSON.stringify({ pad: "x".repeat(PLUGIN_KV_MAX_VALUE_BYTES + 10) });
        const failExit = yield* Effect.exit(
          kv.set("builtin.egress-guard", "state", "big", oversized),
        );
        assert.isTrue(Exit.isFailure(failExit));

        // Isolated SQLite opens cleanly in its own WAL file.
        const iso = openIsolatedPluginSqlite(
          NodePath.join(tmp, "plugins-data"),
          "builtin.egress-guard",
        );
        iso.db.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, count INTEGER)");
        iso.db.prepare("INSERT INTO metrics VALUES (1, 42)").run();
        const row = iso.db.prepare("SELECT count FROM metrics WHERE id = 1").get() as {
          count: number;
        };
        assert.equal(row.count, 42);
        iso.db.close();

        // Hash-chained audit log verifies cleanly and detects tampering.
        const auditPath = NodePath.join(tmp, "audit", "egress-audit.jsonl");
        const log = openHashChainedAuditLog({
          filePath: auditPath,
          streamId: "egress",
          kvPool: kv,
        });
        log.append({ host: "127.0.0.1", verdict: "allow" });
        log.append({ host: "posthog.com", verdict: "deny" });
        assert.equal(log.verify().state, "verified");
        assert.equal(log.verify().count, 2);

        // Tamper one character -> must flip to "broken".
        const tampered = NodeFS.readFileSync(auditPath, "utf8").replace(
          "posthog.com",
          "example.com",
        );
        NodeFS.writeFileSync(auditPath, tampered, "utf8");
        assert.equal(log.verify().state, "broken");
        kv.close();
      } finally {
        NodeFS.rmSync(tmp, { recursive: true, force: true });
      }
    }),
  );

  it.effect("protects user manual edits to plugins.yml via mtime CAS (user wins)", () =>
    Effect.gen(function* () {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-cfg-"));
      try {
        const ymlPath = NodePath.join(tmp, "plugins.yml");
        const svc = yield* makePluginConfigService(ymlPath);
        const initial = yield* svc.read();
        const first = yield* svc.updatePluginConfig({
          pluginId: "builtin.egress-guard",
          expectedMtimeMs: initial.mtimeMs,
          enabled: true,
          config: { strictMode: true },
        });
        assert.equal(first.document.plugins["builtin.egress-guard"]?.enabled, true);

        // Simulate user editing plugins.yml manually with a newer mtime.
        NodeFS.writeFileSync(
          ymlPath,
          "schemaVersion: 1\nplugins:\n  builtin.egress-guard:\n    enabled: false\n",
          "utf8",
        );
        const bumpedSec = (first.mtimeMs + 5_000) / 1000;
        NodeFS.utimesSync(ymlPath, bumpedSec, bumpedSec);

        const staleExit = yield* Effect.exit(
          svc.updatePluginConfig({
            pluginId: "builtin.egress-guard",
            expectedMtimeMs: first.mtimeMs,
            enabled: true,
          }),
        );
        assert.isTrue(Exit.isFailure(staleExit));
        const latest = yield* svc.read();
        assert.equal(latest.document.plugins["builtin.egress-guard"]?.enabled, false);
      } finally {
        NodeFS.rmSync(tmp, { recursive: true, force: true });
      }
    }),
  );
});

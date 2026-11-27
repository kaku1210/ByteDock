// @effect-diagnostics nodeBuiltinImport:off -- Importer tests construct isolated temp trees and WAL SQLite fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import {
  applyPendingStateDbImportIfPresent,
  discoverLegacySourcesReadOnly,
  runLegacyReadOnlyImport,
  scanLegacySourceReadOnly,
} from "./LegacyT3Importer.ts";

function hashFile(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

function createLegacyFixture(baseDir: string, label: string) {
  const userdata = NodePath.join(baseDir, "userdata");
  NodeFS.mkdirSync(NodePath.join(userdata, "themes"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(userdata, "attachments"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(userdata, "secrets"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(userdata, "clerk"), { recursive: true });

  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify({ theme: "dark", sourceLabel: label }),
    "utf8",
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "client-settings.json"),
    JSON.stringify({ fontSize: 14, sourceLabel: label }),
    "utf8",
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "keybindings.json"),
    JSON.stringify([{ key: "ctrl+k", command: "commandPalette.toggle" }]),
    "utf8",
  );
  NodeFS.writeFileSync(
    NodePath.join(userdata, "themes", "zest-dark.json"),
    JSON.stringify({ name: `Zest (${label})` }),
    "utf8",
  );
  NodeFS.writeFileSync(NodePath.join(userdata, "attachments", "note.txt"), `att-${label}`, "utf8");
  NodeFS.writeFileSync(
    NodePath.join(userdata, "secrets", "provider-env-test.bin"),
    "local-provider-secret",
    "utf8",
  );
  // Telemetry & commercial auth artifacts that MUST NEVER be imported.
  NodeFS.writeFileSync(NodePath.join(userdata, "clerk", "session.json"), '{"clerk":true}', "utf8");
  NodeFS.writeFileSync(NodePath.join(userdata, "anonymous-id"), "anon-123", "utf8");
  NodeFS.writeFileSync(NodePath.join(userdata, "usage-host-id"), "host-456", "utf8");

  // Real WAL-mode SQLite DB mirroring T3 Code & T3 Code Plus schema.
  const dbPath = NodePath.join(userdata, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projection_projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL);
    INSERT INTO projection_projects (id, title) VALUES ('proj-1', 'AgentLearn-${label}');
    INSERT INTO orchestration_v2_projection_threads (id, project_id, title) VALUES
      ('thr-1', 'proj-1', 'Thread A (${label})'),
      ('thr-2', 'proj-1', 'Thread B (${label})');
  `);
  db.close();
  return userdata;
}

describe("Unified T3 Code & T3 Code Plus Read-Only Importer", () => {
  it("auto-discovers both ~/.t3 and ~/.t3-plus, verifies shared compatibility, excludes telemetry, and leaves source strictly read-only", () => {
    const fakeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-import-home-"));
    try {
      const t3Dir = NodePath.join(fakeHome, ".t3");
      const t3PlusDir = NodePath.join(fakeHome, ".t3-plus");
      const t3Userdata = createLegacyFixture(t3Dir, "t3code");
      const plusUserdata = createLegacyFixture(t3PlusDir, "t3code-plus");

      // 1. Auto-discovery finds BOTH ~/.t3-plus and ~/.t3 via the exact same schema scanner
      const discovered = discoverLegacySourcesReadOnly(fakeHome);
      assert.strictEqual(discovered.length, 2);
      assert.strictEqual(discovered[0]?.brand, "t3-plus");
      assert.strictEqual(discovered[0]?.exists, true);
      assert.strictEqual(discovered[0]?.schemaCompatible, true);
      assert.strictEqual(discovered[0]?.projectCount, 1);
      assert.strictEqual(discovered[0]?.threadCount, 2);
      assert.include(discovered[0]?.excludedTelemetryItems ?? [], "clerk");
      assert.include(discovered[0]?.excludedTelemetryItems ?? [], "anonymous-id");

      assert.strictEqual(discovered[1]?.brand, "t3");
      assert.strictEqual(discovered[1]?.exists, true);
      assert.strictEqual(discovered[1]?.schemaCompatible, true);
      assert.strictEqual(discovered[1]?.projectCount, 1);
      assert.strictEqual(discovered[1]?.threadCount, 2);

      // Snapshot source hashes BEFORE import to verify zero mutation
      const beforePlusSettingsHash = hashFile(NodePath.join(plusUserdata, "settings.json"));
      const beforeT3SettingsHash = hashFile(NodePath.join(t3Userdata, "settings.json"));

      // 2. Import from T3 Code Plus into isolated ByteDock target (online staged DB mode)
      const targetPlus = NodePath.join(fakeHome, ".bytedock-from-plus", "userdata");
      const plusReport = runLegacyReadOnlyImport({
        sourceBaseDir: t3PlusDir,
        sourceBrand: "t3-plus",
        targetStateDir: targetPlus,
        categories: ["settings", "keybindings", "themes", "stateDb", "attachments", "secrets"],
        overwrite: true,
        deferLockedStateDb: true,
      });

      assert.strictEqual(plusReport.sourceReadOnlyVerified, true);
      assert.strictEqual(plusReport.restartRequired, true);
      assert.isTrue(NodeFS.existsSync(NodePath.join(targetPlus, "settings.json")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(targetPlus, "keybindings.json")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(targetPlus, "themes", "zest-dark.json")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(targetPlus, "attachments", "note.txt")));
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(targetPlus, "secrets", "provider-env-test.bin")),
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(targetPlus, "statev2.sqlite.pending-import")));

      // Telemetry artifacts MUST NOT exist in target
      assert.isFalse(NodeFS.existsSync(NodePath.join(targetPlus, "clerk")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(targetPlus, "anonymous-id")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(targetPlus, "usage-host-id")));

      // Promote pending DB on startup and verify all threads migrated intact
      assert.isTrue(applyPendingStateDbImportIfPresent(targetPlus));
      const promotedScan = scanLegacySourceReadOnly({ baseDir: targetPlus, brand: "custom" });
      assert.strictEqual(promotedScan.projectCount, 1);
      assert.strictEqual(promotedScan.threadCount, 2);

      // 3. Import from standard T3 Code (~/.t3) with the exact same importer (direct offline DB mode)
      const targetT3 = NodePath.join(fakeHome, ".bytedock-from-t3", "userdata");
      const t3Report = runLegacyReadOnlyImport({
        sourceBaseDir: t3Dir,
        sourceBrand: "t3",
        targetStateDir: targetT3,
        categories: ["settings", "keybindings", "themes", "stateDb"],
        overwrite: true,
        deferLockedStateDb: false,
      });
      assert.strictEqual(t3Report.restartRequired, false);
      const t3TargetScan = scanLegacySourceReadOnly({ baseDir: targetT3, brand: "custom" });
      assert.strictEqual(t3TargetScan.projectCount, 1);
      assert.strictEqual(t3TargetScan.threadCount, 2);

      // 4. Verify source directories were NEVER mutated
      assert.strictEqual(
        hashFile(NodePath.join(plusUserdata, "settings.json")),
        beforePlusSettingsHash,
      );
      assert.strictEqual(
        hashFile(NodePath.join(t3Userdata, "settings.json")),
        beforeT3SettingsHash,
      );
    } finally {
      NodeFS.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

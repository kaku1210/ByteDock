// @effect-diagnostics nodeBuiltinImport:off -- Unit test passes node:path.posix.join into pure path helpers.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  BYTEDOCK_AUMID_DEV,
  BYTEDOCK_AUMID_PROD,
  BYTEDOCK_BRAND_NAME,
  BYTEDOCK_GITHUB_REPOSITORY,
  BYTEDOCK_HOME_DIR_NAME,
  BYTEDOCK_HOME_ENV_VAR,
  BYTEDOCK_PROTOCOL_SCHEME,
  BYTEDOCK_WEBSITE_URL,
  resolveByteDockDirectoryLayout,
  resolveLegacyReadOnlyImportCandidates,
} from "./bytedockPaths.ts";

describe("bytedockPaths", () => {
  it("defines independent ByteDock identity constants", () => {
    assert.equal(BYTEDOCK_BRAND_NAME, "ByteDock");
    assert.equal(BYTEDOCK_WEBSITE_URL, "https://byte.didyou.eat");
    assert.equal(BYTEDOCK_PROTOCOL_SCHEME, "bytedock");
    assert.equal(BYTEDOCK_HOME_DIR_NAME, ".bytedock");
    assert.equal(BYTEDOCK_HOME_ENV_VAR, "BYTEDOCK_HOME");
    assert.equal(BYTEDOCK_AUMID_PROD, "dev.bytedock.desktop");
    assert.equal(BYTEDOCK_AUMID_DEV, "dev.bytedock.desktop.dev");
    assert.equal(BYTEDOCK_GITHUB_REPOSITORY, "kaku1210/ByteDock");
  });

  it("resolves isolated ~/.bytedock plugin and audit directories", () => {
    const layout = resolveByteDockDirectoryLayout("/Users/alice/.bytedock", NodePath.posix.join);
    assert.deepStrictEqual(layout, {
      baseDir: "/Users/alice/.bytedock",
      pluginsDir: "/Users/alice/.bytedock/plugins",
      pluginsDevDir: "/Users/alice/.bytedock/plugins-dev",
      pluginsConfigPath: "/Users/alice/.bytedock/plugins.yml",
      pluginsDataDir: "/Users/alice/.bytedock/plugins-data",
      auditDir: "/Users/alice/.bytedock/audit",
      artifactsDir: "/Users/alice/.bytedock/artifacts",
    });
  });

  it("enumerates read-only legacy import candidates without pointing into ~/.bytedock", () => {
    const candidates = resolveLegacyReadOnlyImportCandidates("/Users/alice", NodePath.posix.join);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]?.sourceBrand, "t3-plus");
    assert.equal(candidates[0]?.settingsPath, "/Users/alice/.t3-plus/userdata/settings.json");
    assert.equal(candidates[1]?.sourceBrand, "t3");
    assert.equal(candidates[1]?.settingsPath, "/Users/alice/.t3/userdata/settings.json");
  });
});

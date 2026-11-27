import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { runZeroTelemetryScan, scanSourceForTelemetryViolations } from "./check-zero-telemetry.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const config = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repoRoot, "scripts", "egress-denied-domains.json"), "utf8"),
);

describe("check-zero-telemetry", () => {
  it("flags prohibited telemetry domains, packages, and unauthorized CLI credential reads", () => {
    const sample = [
      'import posthog from "posthog-js";',
      'const url = "https://ingest.t3.codes/v1/events";',
      'const auth = fs.readFileSync(path.join(home, ".claude.json"), "utf8");',
      "// posthog.com comment should be ignored",
    ].join("\n");

    const violations = scanSourceForTelemetryViolations(
      "apps/server/src/example.ts",
      sample,
      config,
    );
    assert.equal(violations.length, 3);
    assert.deepStrictEqual(
      violations.map((v) => v.kind),
      ["package", "domain", "credential-read"],
    );
  });

  it("passes cleanly on the current ByteDock repository", () => {
    const violations = runZeroTelemetryScan(repoRoot);
    assert.deepStrictEqual(violations, []);
  });
});

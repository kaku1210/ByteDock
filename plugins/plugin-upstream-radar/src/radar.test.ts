// @effect-diagnostics nodeBuiltinImport:off -- Test reads repo manifest, shared egress policy, and writes temp ledger files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodePluginManifest } from "@bytedock/plugin-sdk/manifest";

import {
  classifyUpstreamChange,
  loadDeniedTelemetryPolicy,
  readUpstreamLedger,
  recordUpstreamLedgerEntry,
} from "./radar.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const SHARED_POLICY_PATH = NodePath.join(REPO_ROOT, "scripts/egress-denied-domains.json");
const MANIFEST_PATH = NodePath.resolve(import.meta.dirname, "../bytedock-plugin.json");

describe("W1-8 Plugin #0: plugin-upstream-radar Stage 1 D-class gate & idempotent ledger", () => {
  it.effect("validates bytedock-plugin.json against @bytedock/plugin-sdk manifest schema", () =>
    Effect.gen(function* () {
      const raw = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8")) as unknown;
      const manifest = yield* decodePluginManifest(raw);
      assert.equal(manifest.id, "builtin.upstream-radar");
      assert.equal(manifest.execution, "declarative");
      assert.equal(manifest.trust, "builtin");
    }),
  );

  it("blocks 3 real-world D-class fixtures (PostHog, Sentry, Clerk/Credential read) 100% via shared policy", () => {
    const policy = loadDeniedTelemetryPolicy(SHARED_POLICY_PATH);

    const posthogPr = classifyUpstreamChange(
      {
        prSha: "sha-posthog-001",
        prNumber: 9001,
        title: "chore: send startup metrics to PostHog",
        touchedFiles: ["apps/web/src/main.tsx"],
        diffText: `+import posthog from "posthog-js";\n+posthog.init("phc_x", { api_host: "https://us.i.posthog.com" });`,
      },
      policy,
    );
    assert.equal(posthogPr.classification, "D");
    assert.equal(posthogPr.recommendedStrategy, "skipped");
    assert.isTrue(posthogPr.dClassHits.length > 0);

    const sentryPr = classifyUpstreamChange(
      {
        prSha: "sha-sentry-002",
        prNumber: 9002,
        title: "feat: wire @sentry/electron crash reporting",
        touchedFiles: ["apps/desktop/src/main.ts"],
        diffText: `+import * as Sentry from "@sentry/electron";\n+Sentry.init({ dsn: "https://abc@ingest.sentry.io/1" });`,
      },
      policy,
    );
    assert.equal(sentryPr.classification, "D");
    assert.equal(sentryPr.recommendedStrategy, "skipped");

    const clerkAndCredPr = classifyUpstreamChange(
      {
        prSha: "sha-clerk-003",
        prNumber: 9003,
        title: "feat: sync cloud token from .claude.json via Clerk",
        touchedFiles: ["apps/server/src/auth/login.ts"],
        diffText: `+const key = process.env.CLERK_PUBLISHABLE_KEY;\n+const raw = fs.readFileSync("~/.claude.json");`,
      },
      policy,
    );
    assert.equal(clerkAndCredPr.classification, "D");
    assert.equal(clerkAndCredPr.recommendedStrategy, "skipped");
  });

  it("recommends idea-sync for Class A manual-review seams and keeps upstream-ledger.jsonl idempotent by prSha", () => {
    const policy = loadDeniedTelemetryPolicy(SHARED_POLICY_PATH);
    const result = classifyUpstreamChange(
      {
        prSha: "sha-outbound-h2-004",
        prNumber: 9004,
        title: "fix(server): tune HTTP/1.1 connection pool keepalive",
        touchedFiles: ["apps/server/src/outboundHttp.ts"],
        diffText: `+const keepAliveTimeout = 15_000;`,
      },
      policy,
      [
        {
          id: "egress-guard-mount",
          files: ["apps/server/src/outboundHttp.ts"],
          review: "manual",
        },
      ],
    );

    assert.equal(result.classification, "A");
    assert.equal(result.recommendedStrategy, "idea-sync");
    assert.isTrue(result.requiresManualReview);

    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-radar-"));
    try {
      const ledgerPath = NodePath.join(tmp, "upstream-ledger.jsonl");
      const entry = {
        prSha: result.prSha,
        prNumber: 9004,
        title: "fix(server): tune HTTP/1.1 connection pool keepalive",
        classification: result.classification,
        strategy: "idea-sync" as const,
        dClassHits: result.dClassHits,
        touchedSeams: result.touchedSeams,
        recordedAt: "2026-11-27T00:00:00.000Z",
        notes: "Adopted keepalive idea natively inside ByteDock egress guard.",
      };

      const first = recordUpstreamLedgerEntry(ledgerPath, entry);
      const second = recordUpstreamLedgerEntry(ledgerPath, entry);
      assert.isTrue(first.appended);
      assert.isFalse(second.appended);
      assert.equal(readUpstreamLedger(ledgerPath).length, 1);
      assert.equal(readUpstreamLedger(ledgerPath)[0]?.strategy, "idea-sync");
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

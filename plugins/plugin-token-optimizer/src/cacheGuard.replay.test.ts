// @effect-diagnostics nodeBuiltinImport:off -- Replay test reads manifest and writes temporary artifact & SQLite fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AdapterCacheProfile } from "@bytedock/plugin-sdk/cacheGuard";
import { decodePluginManifest } from "@bytedock/plugin-sdk/manifest";

import {
  buildTokenOptimizerXRayCard,
  CacheGuardEngine,
  openXRayBillStore,
  spillOversizedToolOutput,
} from "./index.ts";

const MANIFEST_PATH = NodePath.resolve(import.meta.dirname, "../bytedock-plugin.json");

const STATELESS_API_PROFILE: AdapterCacheProfile = {
  track: "stateless-api",
  prefixChannel: "request-prefix",
  turnAppend: "suffix-request",
  compaction: "host-boundary",
  usageVisibility: "full",
};

const STATEFUL_CLI_PROFILE: AdapterCacheProfile = {
  track: "stateful-cli",
  prefixChannel: "open-params",
  turnAppend: "payload-wrap",
  compaction: "native-command",
  usageVisibility: "opaque",
};

/**
 * Matrix 2 (Blueprint Ch. 10.1): Dual-track CacheGuard replay suite.
 * Verifies API >=90% steady-state cache hit, prefix mutation detection, CLI/ACP zero projection
 * pollution & /compact immunity, mid-thread ProfileShiftEvent, and isolated-sqlite X-Ray bills.
 */
describe("W5-2 Matrix 2: Dual-track CacheGuard & Context X-Ray replay suite", () => {
  it.effect("validates bytedock-plugin.json against @bytedock/plugin-sdk manifest schema", () =>
    Effect.gen(function* () {
      const raw = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8")) as unknown;
      const manifest = yield* decodePluginManifest(raw);
      assert.strictEqual(manifest.id, "builtin.token-optimizer");
      assert.strictEqual(manifest.permissions.storage, "isolated-sqlite");
    }),
  );

  it("maintains >=90% steady-state cache hit on stateless-api 20-turn replay and catches prefix mutation", () => {
    const engine = new CacheGuardEngine();
    const stableBlocks = [
      { id: "soul", body: "You are a ByteDock coding agent." },
      { id: "repo-rules", body: "Follow Effect 4 idioms." },
    ];

    for (let turn = 1; turn <= 20; turn += 1) {
      const res = engine.evaluateTurn({
        threadId: "thread-api",
        turnOrdinal: turn,
        revision: 1,
        profile: STATELESS_API_PROFILE,
        // Intentionally reverse block array order on odd turns to verify canonical sort stability.
        prefixBlocks: turn % 2 === 0 ? stableBlocks : [...stableBlocks].reverse(),
        mcpToolNames: ["read_file", "edit_file"],
        projectedMessage: `Implement step ${turn}`,
        usage:
          turn === 1
            ? { cachedInput: 0, input: 100, cacheCreation: 10_000 }
            : { cachedInput: 10_000 + turn * 50, input: 200, cacheCreation: 0 },
      });
      assert.isUndefined(res.violation);
      assert.isTrue(res.report.hostInvariants.prefixHashStable);
      assert.strictEqual(res.report.status, "measured");
    }

    const ratio = engine.computeSteadyStateCacheRatio("thread-api");
    assert.isDefined(ratio);
    assert.isTrue((ratio ?? 0) >= 0.9, `Expected >= 0.90 steady-state cache hit, got ${ratio}`);

    // Deliberate prefix mutation outside compact boundary -> exact PrefixImmutabilityViolation.
    const mutated = engine.evaluateTurn({
      threadId: "thread-api",
      turnOrdinal: 21,
      revision: 1,
      profile: STATELESS_API_PROFILE,
      prefixBlocks: [{ id: "soul", body: "Mutated warm prefix!" }],
      mcpToolNames: ["read_file", "edit_file"],
      projectedMessage: "Next step",
    });
    assert.strictEqual(mutated.violation?._tag, "PrefixImmutabilityViolation");
    assert.isFalse(mutated.report.hostInvariants.prefixHashStable);
  });

  it("enforces CLI/ACP host invariants, zero projection pollution, /compact immunity, and honest opaque X-Ray", () => {
    const engine = new CacheGuardEngine();
    const userPrompt = "Explain the caching strategy";
    const originalHash = NodeCrypto.createHash("sha256").update(userPrompt).digest("hex");

    const res = engine.evaluateTurn({
      threadId: "thread-cli",
      turnOrdinal: 1,
      revision: 1,
      profile: STATEFUL_CLI_PROFILE,
      prefixBlocks: [{ id: "soul", body: "SOUL.md" }],
      mcpToolNames: ["tool_search"],
      projectedMessage: userPrompt,
      // Wrap string deliberately mentions /compact — must NEVER trigger false compact detection.
      appendContext: "[Memory Note] Run /compact only when explicitly requested by user.",
      usage: { cachedInput: 9_999, input: 100 },
    });

    assert.strictEqual(
      NodeCrypto.createHash("sha256").update(res.payload.projectedMessage).digest("hex"),
      originalHash,
    );
    assert.include(res.payload.outboundUserText, "[Memory Note]");
    assert.isFalse(res.isCompactCommand);
    assert.isTrue(res.report.hostInvariants.prefixHashStable);
    assert.isTrue(res.report.hostInvariants.mcpSnapshotStable);
    assert.isTrue(res.report.hostInvariants.contributionInBounds);

    // Law #6: opaque track NEVER fabricates or leaks provider cache numbers.
    assert.strictEqual(res.report.status, "opaque");
    assert.isUndefined(res.report.cachedInput);
    const card = buildTokenOptimizerXRayCard(res.report);
    assert.strictEqual(card.p.kpi?.[0]?.value, "N/A (opaque)");
  });

  it("handles mid-thread stateless-api -> stateful-cli switch with 0 violations and 1 ProfileShiftEvent", () => {
    const engine = new CacheGuardEngine();
    const first = engine.evaluateTurn({
      threadId: "thread-switch",
      turnOrdinal: 1,
      revision: 1,
      profile: STATELESS_API_PROFILE,
      prefixBlocks: [{ id: "soul", body: "v1" }],
      mcpToolNames: ["read_file"],
      projectedMessage: "Start on API model",
    });
    assert.isUndefined(first.violation);

    const switched = engine.evaluateTurn({
      threadId: "thread-switch",
      turnOrdinal: 2,
      revision: 1,
      profile: STATEFUL_CLI_PROFILE,
      prefixBlocks: [{ id: "soul", body: "v2-reopened" }],
      mcpToolNames: ["tool_search"],
      projectedMessage: "Switch to CLI adapter mid-thread",
      shiftTrigger: "provider-switch",
    });
    assert.isUndefined(switched.violation);
    assert.strictEqual(switched.profileShift?.trigger, "provider-switch");
    assert.strictEqual(switched.xrayNote, "profile-shift re-open");
    assert.strictEqual(engine.getViolations().length, 0);
    assert.strictEqual(engine.getProfileShifts().length, 1);
  });

  it("spills oversized tool output to artifacts dir and persists X-Ray bills in isolated-sqlite", () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-token-opt-"));
    try {
      const spill = spillOversizedToolOutput({
        strategy: {
          thresholdTokens: 100,
          boundaryOnly: true,
          idempotentToolsOnly: true,
          artifactDir: NodePath.join(tmp, "artifacts"),
        },
        threadId: "thread-spill",
        toolCallId: "call-42",
        outputText: "A".repeat(2_000),
      });
      assert.isTrue(spill.spilled);
      assert.isDefined(spill.artifactRef);
      assert.isTrue(NodeFS.existsSync(spill.artifactRef!));

      const store = openXRayBillStore(NodePath.join(tmp, "plugins-data"));
      store.record({
        threadId: "thread-spill",
        turnOrdinal: 1,
        status: "measured",
        cachedInput: 9_500,
        input: 500,
        cacheCreation: 0,
        hostInvariants: {
          prefixHashStable: true,
          mcpSnapshotStable: true,
          contributionInBounds: true,
        },
      });
      assert.strictEqual(store.countForThread("thread-spill"), 1);
      store.close();
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

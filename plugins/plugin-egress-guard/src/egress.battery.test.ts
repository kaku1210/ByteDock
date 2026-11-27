// @effect-diagnostics nodeBuiltinImport:off -- Red-team battery tests Node DNS, dgram, temp files, and isolated child probes.
import type * as NodeDgram from "node:dgram";
import * as NodeDns from "node:dns";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  DEFAULT_DENIED_DOMAINS,
  EGRESS_HONEST_DISCLOSURES,
  openHashChainedAuditLog,
  verifyResolvedAddresses,
  type UndiciDispatcherLike,
  type UndiciModuleLike,
} from "@bytedock/plugin-kernel";
import { decodePluginManifest } from "@bytedock/plugin-sdk/manifest";

import { buildEgressGuardPanelTree, createEgressGuardPluginRuntime } from "./index.ts";

const MANIFEST_PATH = NodePath.resolve(import.meta.dirname, "../bytedock-plugin.json");

/**
 * Matrix 3 (Blueprint Ch. 10.1): Egress Guard L1 attack-defense battery.
 * Verifies dual-gate dispatcher hijack, AsyncLocalStorage DNS anti-recursion, SSRF rebinding,
 * dual-stack all-or-nothing rejection, UDP deny-by-default, dual-segment EgressProof, and disclosures.
 */
describe("W3-2/W3-4 Matrix 3: Egress Guard L1 attack-defense battery", () => {
  it.effect(
    "validates Manifest, verbatim honest disclosures, and 12-primitive panel KPI separation",
    () =>
      Effect.gen(function* () {
        const raw = JSON.parse(NodeFS.readFileSync(MANIFEST_PATH, "utf8")) as unknown;
        const manifest = yield* decodePluginManifest(raw);
        assert.strictEqual(manifest.id, "builtin.egress-guard");
        assert.strictEqual(manifest.permissions.hooks?.[0]?.onError, "deny");

        // Honest disclosure sentences must never claim absolute "100% zero outbound" across native addons.
        assert.include(EGRESS_HONEST_DISCLOSURES.coverageScope, "N-API addon");
        assert.include(EGRESS_HONEST_DISCLOSURES.verifiablePromise, "uncovered-native");
        assert.include(EGRESS_HONEST_DISCLOSURES.tierMatrix, 'kind: "pipe"');

        const tree = buildEgressGuardPanelTree({
          blockedCount: 3,
          allowedCount: 12,
          uncoveredNativeCount: 1,
          namedPipeCount: 2,
          proofVerdict: "pass",
          auditChainState: "verified",
        });
        assert.strictEqual(tree.t, "Stack");
        const card = tree.c?.find((n) => n.t === "Card");
        assert.strictEqual(card?.p.kpi?.length, 4);
        assert.strictEqual(card?.p.kpi?.[2]?.value, 1);
      }),
  );

  it("blocks denied domains via Gate 1 and wraps post-boot setGlobalDispatcher swaps via Gate 2", () => {
    const runtime = createEgressGuardPluginRuntime({
      policy: {
        mode: "strict",
        deniedDomains: DEFAULT_DENIED_DOMAINS,
        allowedHosts: ["api.anthropic.com"],
        allowLoopbackHosts: ["127.0.0.1", "localhost"],
        allowUdp: false,
      },
    });

    const dispatchedOrigins: Array<string> = [];
    const baseDispatcher: UndiciDispatcherLike = {
      dispatch(options) {
        dispatchedOrigins.push(String(options.origin));
        return true;
      },
    };
    let currentDispatcher: UndiciDispatcherLike = baseDispatcher;
    const fakeUndici: UndiciModuleLike = {
      getGlobalDispatcher: () => currentDispatcher,
      setGlobalDispatcher: (next) => {
        currentDispatcher = next;
      },
    };

    const restore = runtime.controller.hijackUndiciSetGlobalDispatcher(fakeUndici);
    try {
      // Gate 1: whitelisted host passes, denied telemetry host blocked with ENOTFOUND.
      assert.isTrue(
        fakeUndici.getGlobalDispatcher().dispatch({ origin: "https://api.anthropic.com" }, {}),
      );
      assert.deepStrictEqual(dispatchedOrigins, ["https://api.anthropic.com"]);

      let blockedError: Error | undefined;
      fakeUndici.getGlobalDispatcher().dispatch(
        { origin: "https://us.i.posthog.com" },
        {
          onError: (err: Error) => {
            blockedError = err;
          },
        },
      );
      assert.isDefined(blockedError);
      assert.strictEqual((blockedError as NodeJS.ErrnoException).code, "ENOTFOUND");

      // Gate 2: third-party code swaps global dispatcher after boot -> still wrapped & audited!
      const rogueDispatches: Array<string> = [];
      fakeUndici.setGlobalDispatcher({
        dispatch(options) {
          rogueDispatches.push(String(options.origin));
          return true;
        },
      });
      let postSwapBlocked: Error | undefined;
      fakeUndici.getGlobalDispatcher().dispatch(
        { origin: "https://ingest.sentry.io" },
        {
          onError: (err: Error) => {
            postSwapBlocked = err;
          },
        },
      );
      assert.isDefined(postSwapBlocked);
      assert.deepStrictEqual(rogueDispatches, []);
      assert.isTrue(runtime.controller.getEvents().some((e) => e.layer === "dispatcher-swap"));
    } finally {
      restore();
    }
  });

  it("enforces AsyncLocalStorage DNS anti-recursion, SSRF DNS rebinding denial, and dual-stack all-or-nothing rejection", async () => {
    const runtime = createEgressGuardPluginRuntime({
      policy: {
        mode: "strict",
        deniedDomains: DEFAULT_DENIED_DOMAINS,
        allowedHosts: ["evil-rebind.example", "dualstack.example"],
        allowLoopbackHosts: ["127.0.0.1", "localhost"],
        allowUdp: false,
      },
    });

    // 1. SSRF DNS Rebinding: whitelisted domain resolving to 127.0.0.1 MUST be rejected!
    const rebind = verifyResolvedAddresses(
      "evil-rebind.example",
      [{ address: "127.0.0.1", family: 4 }],
      runtime.controller.getPolicy(),
    );
    assert.isFalse(rebind.allowed);
    assert.strictEqual(rebind.offendingIp, "127.0.0.1");

    // 2. Dual-stack { all: true }: one public + one private RFC1918 IP -> reject ENTIRE lookup.
    const dualStack = verifyResolvedAddresses(
      "dualstack.example",
      [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
      runtime.controller.getPolicy(),
    );
    assert.isFalse(dualStack.allowed);
    assert.strictEqual(dualStack.offendingIp, "10.0.0.5");

    // 3. IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) also rejected.
    const mappedV6 = verifyResolvedAddresses(
      "evil-rebind.example",
      [{ address: "::ffff:127.0.0.1", family: 6 }],
      runtime.controller.getPolicy(),
    );
    assert.isFalse(mappedV6.allowed);

    // 4. AsyncLocalStorage anti-recursion on dns.lookup patch: blocked domain yields ENOTFOUND; localhost resolves cleanly.
    const fakeDns = { lookup: NodeDns.lookup.bind(NodeDns) };
    const restoreDns = runtime.controller.installDnsGuard(fakeDns);
    try {
      const blockedErr = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        fakeDns.lookup("us.i.posthog.com", (err) => resolve(err));
      });
      assert.strictEqual(blockedErr?.code, "ENOTFOUND");

      const loopbackAddrs = await runtime.controller.guardedLookupAll("localhost");
      assert.isTrue(loopbackAddrs.length > 0);
    } finally {
      restoreDns();
    }
  });

  it("blocks UDP sockets by default and passes dual-segment EgressProof + hash-chained audit", () => {
    const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-egress-proof-"));
    try {
      const auditPath = NodePath.join(tmpDir, "egress-audit.jsonl");
      const runtime = createEgressGuardPluginRuntime({
        policy: {
          mode: "strict",
          deniedDomains: DEFAULT_DENIED_DOMAINS,
          allowedHosts: ["api.anthropic.com"],
          allowLoopbackHosts: ["127.0.0.1", "localhost"],
          allowUdp: false,
        },
        auditFilePath: auditPath,
      });

      // UDP deny-by-default.
      const fakeDgram = {
        createSocket: (() => {
          throw new Error("should-not-reach-native-dgram");
        }) as unknown as typeof NodeDgram.createSocket,
      };
      const restoreDgram = runtime.controller.installDgramGuard(fakeDgram);
      try {
        assert.throws(() => fakeDgram.createSocket("udp4"), /UDP socket creation/);
      } finally {
        restoreDgram();
      }

      // Separate tracking of named pipes & uncovered native addons.
      runtime.controller.recordNamedPipe("\\\\.\\pipe\\bytedock-ipc");
      runtime.controller.recordUncoveredNative({
        origin: "uncovered-native",
        pid: process.pid,
        path: "node-pty",
        note: "Covered by L2/L3",
      });

      // Run BOTH segments of EgressProof including REAL spawned detachedAllBlock process.
      const proof = runtime.runProof({ runDetachedProbes: true });
      assert.strictEqual(proof.liveAttribution.verdict, "pass");
      assert.strictEqual(proof.liveAttribution.counts.unattributedBytes, 0);
      assert.strictEqual(proof.liveAttribution.counts.namedPipes, 1);
      assert.strictEqual(proof.liveAttribution.uncoveredNative.length, 1);
      assert.strictEqual(proof.detachedAllBlock.verdict, "pass");
      assert.strictEqual(proof.detachedAllBlock.probes.length, 4);
      assert.isTrue(proof.detachedAllBlock.probes.every((p) => p.blocked));

      // Hash-chained audit log verifies cleanly.
      const verifier = openHashChainedAuditLog({ filePath: auditPath, streamId: "egress-guard" });
      const chain = verifier.verify();
      assert.strictEqual(chain.state, "verified");
      assert.isTrue(chain.count >= 2);
    } finally {
      NodeFS.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- Unit test reads seam-ledger.json directly.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { checkSeams, loadSeamLedger, parseUnifiedDiff } from "./check-seams.ts";

const LEDGER = loadSeamLedger(NodePath.resolve(import.meta.dirname, "../seam-ledger.json"));

/**
 * W1-7 Probe #3: validates the 4 regression fixtures and Prettier/blank-line immunity
 * so check-seams blocks accidental upstream drift without blocking idea-sync rewrites.
 */
describe("W1-7 Probe #3: check-seams flexible seam guard", () => {
  it("fixture 1 (clean.diff): passes when additions live inside tagged seam block + tagged import", () => {
    const diff = `
diff --git a/packages/contracts/src/rpc.ts b/packages/contracts/src/rpc.ts
--- a/packages/contracts/src/rpc.ts
+++ b/packages/contracts/src/rpc.ts
@@ -1,0 +2,1 @@
+import { PluginListInput } from "./plugins.ts"; // bytedock-seam-import:rpc-plugins
@@ -2980,0 +2982,4 @@
+// bytedock-seam:rpc-plugins
+  WsPluginsListRpc,
+  WsPluginsReloadRpc,
+// end-bytedock-seam:rpc-plugins
`;
    const result = checkSeams(parseUnifiedDiff(diff), LEDGER);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fixture 2 (untagged-upstream-edit.diff): fails on accidental untagged edit of upstream line", () => {
    const diff = `
diff --git a/apps/server/src/outboundHttp.ts b/apps/server/src/outboundHttp.ts
--- a/apps/server/src/outboundHttp.ts
+++ b/apps/server/src/outboundHttp.ts
@@ -18,1 +18,1 @@
-const oldTimeout = 5000;
+const oldTimeout = 10000;
`;
    const result = checkSeams(parseUnifiedDiff(diff), LEDGER);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === "R2_UNTAGGED_UPSTREAM_EDIT")).toBe(true);
    expect(result.notices.some((n) => n.kind === "manual-review")).toBe(true);
  });

  it("fixture 3 (tagged-import.diff): passes when only tagged import lines are added", () => {
    const diff = `
diff --git a/apps/server/src/auth/RpcAuthorization.ts b/apps/server/src/auth/RpcAuthorization.ts
--- a/apps/server/src/auth/RpcAuthorization.ts
+++ b/apps/server/src/auth/RpcAuthorization.ts
@@ -36,0 +37,2 @@
+import { PLUGIN_RPC_METHODS } from "@t3tools/contracts"; // bytedock-seam-import:rpc-auth
+import type { PluginScopeBrokerService } from "@bytedock/plugin-sdk/bridge"; // bytedock-seam-import:rpc-auth
`;
    const result = checkSeams(parseUnifiedDiff(diff), LEDGER);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fixture 4 (explicit-idea-sync.diff): passes with notice for deliberate idea-sync rewrite or diverged file", () => {
    const ideaSyncDiff = `
diff --git a/apps/server/src/orchestration-v2/RunExecutionService.ts b/apps/server/src/orchestration-v2/RunExecutionService.ts
--- a/apps/server/src/orchestration-v2/RunExecutionService.ts
+++ b/apps/server/src/orchestration-v2/RunExecutionService.ts
@@ -2310,2 +2310,4 @@
-const oldBehavior = computeLegacyInput(input);
+// bytedock-idea-sync:upstream#4812
+const newBehavior = computeNativeByteDockInput(input);
+// end-bytedock-idea-sync:upstream#4812
`;
    const r1 = checkSeams(parseUnifiedDiff(ideaSyncDiff), LEDGER);
    expect(r1.ok).toBe(true);
    expect(r1.notices.some((n) => n.kind === "idea-sync")).toBe(true);

    // Also passes when the file is explicitly marked mode: "diverged" in seam-ledger.json.
    const divergedLedger = {
      ...LEDGER,
      seams: LEDGER.seams.map((s) =>
        s.id === "run-turn-contrib" ? { ...s, mode: "diverged" as const } : s,
      ),
    };
    const rawDiff = `
diff --git a/apps/server/src/orchestration-v2/RunExecutionService.ts b/apps/server/src/orchestration-v2/RunExecutionService.ts
--- a/apps/server/src/orchestration-v2/RunExecutionService.ts
+++ b/apps/server/src/orchestration-v2/RunExecutionService.ts
@@ -2310,1 +2310,1 @@
-const oldBehavior = 1;
+const nativeRewrite = 2;
`;
    const r2 = checkSeams(parseUnifiedDiff(rawDiff), divergedLedger);
    expect(r2.ok).toBe(true);
    expect(r2.notices.some((n) => n.kind === "diverged")).toBe(true);
  });

  it("zero false positives when Prettier reformats lines inside an existing seam block", () => {
    const fullFile = [
      'import { foo } from "./foo.ts";',
      "// bytedock-seam:egress-guard-mount",
      "installEgressGuard({",
      "  strictMode: true,",
      "});",
      "// end-bytedock-seam:egress-guard-mount",
    ];
    const prettierReformatDiff = `
diff --git a/apps/server/src/outboundHttp.ts b/apps/server/src/outboundHttp.ts
--- a/apps/server/src/outboundHttp.ts
+++ b/apps/server/src/outboundHttp.ts
@@ -3,1 +3,3 @@
-installEgressGuard({ strictMode: true });
+installEgressGuard({
+  strictMode: true,
+});
`;
    const result = checkSeams(parseUnifiedDiff(prettierReformatDiff), LEDGER, {
      readFileLines: () => fullFile,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects unregistered seam IDs in strict files (R1/R3)", () => {
    const unknownIdDiff = `
diff --git a/packages/contracts/src/environment.ts b/packages/contracts/src/environment.ts
--- a/packages/contracts/src/environment.ts
+++ b/packages/contracts/src/environment.ts
@@ -230,0 +231,3 @@
+// bytedock-seam:unregistered-rogue-seam
+  rogueFlag: Schema.optionalKey(Schema.Boolean),
+// end-bytedock-seam:unregistered-rogue-seam
`;
    const result = checkSeams(parseUnifiedDiff(unknownIdDiff), LEDGER);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.rule === "R1_UNKNOWN_SEAM_ID")).toBe(true);
  });

  it("allows blank separator lines immediately adjacent (±1 line) to top-level seam blocks without false positives", () => {
    const topLevelBlockDiff = `
diff --git a/apps/server/src/secrets/SecretResolver.ts b/apps/server/src/secrets/SecretResolver.ts
--- a/apps/server/src/secrets/SecretResolver.ts
+++ b/apps/server/src/secrets/SecretResolver.ts
@@ -20,0 +21,4 @@
+
+// bytedock-seam:secret-ns-broker
+export const x = 1;
+// end-bytedock-seam:secret-ns-broker
`;
    const okResult = checkSeams(parseUnifiedDiff(topLevelBlockDiff), LEDGER);
    expect(okResult.ok).toBe(true);
    expect(okResult.violations).toEqual([]);

    const strayBlankDiff = `
diff --git a/apps/server/src/secrets/SecretResolver.ts b/apps/server/src/secrets/SecretResolver.ts
--- a/apps/server/src/secrets/SecretResolver.ts
+++ b/apps/server/src/secrets/SecretResolver.ts
@@ -5,0 +6,1 @@
+
`;
    const failResult = checkSeams(parseUnifiedDiff(strayBlankDiff), LEDGER);
    expect(failResult.ok).toBe(false);
    expect(failResult.violations[0]?.rule).toBe("R1_UNTAGGED_ADDITION");
  });

  it("covers multi-line imports wrapped by Prettier when the closing line carries // bytedock-seam-import:<id>", () => {
    const fullFile = [
      'import { VcsError } from "./vcs.ts";',
      "import {",
      "  PluginRpcError,",
      "  PluginsListInput,",
      '} from "./plugins.ts"; // bytedock-seam-import:rpc-plugins',
    ];
    const wrappedImportDiff = `
diff --git a/packages/contracts/src/rpc.ts b/packages/contracts/src/rpc.ts
--- a/packages/contracts/src/rpc.ts
+++ b/packages/contracts/src/rpc.ts
@@ -1,0 +2,4 @@
+import {
+  PluginRpcError,
+  PluginsListInput,
+} from "./plugins.ts"; // bytedock-seam-import:rpc-plugins
`;
    const result = checkSeams(parseUnifiedDiff(wrappedImportDiff), LEDGER, {
      readFileLines: () => fullFile,
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

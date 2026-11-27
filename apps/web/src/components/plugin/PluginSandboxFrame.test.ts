// @effect-diagnostics nodeBuiltinImport:off -- Static sandbox security regression lint reads source file via node:fs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { buildSandboxedPluginSrcDoc, validateSandboxMessageEvent } from "./PluginSandboxFrame";

const SANDBOX_FRAME_SOURCE_PATH = NodePath.resolve(import.meta.dirname, "./PluginSandboxFrame.tsx");

describe("W7-2 Matrix 4: PluginSandboxFrame 4-condition nonce & static sandbox security battery", () => {
  it("enforces all 4 message validation conditions, blocks cross-iframe spoofing, and invalidates nonce on unmount", () => {
    const fakeFrameWindow = { id: "legit-iframe" };
    const attackerWindow = { id: "attacker-iframe" };
    const issuedNonce = "nonce-abcd-1234";

    // Valid 4-condition message passes
    const ok = validateSandboxMessageEvent({
      origin: "null",
      source: fakeFrameWindow,
      expectedSource: fakeFrameWindow,
      data: { type: "rpc.invoke", nonce: issuedNonce, payload: { action: "ping" } },
      activeNonce: issuedNonce,
    });
    assert.strictEqual(ok.accepted, true);
    assert.strictEqual(ok.envelope?.type, "rpc.invoke");

    // 1. Wrong origin rejected
    const badOrigin = validateSandboxMessageEvent({
      origin: "https://evil.example.com",
      source: fakeFrameWindow,
      expectedSource: fakeFrameWindow,
      data: { type: "rpc.invoke", nonce: issuedNonce },
      activeNonce: issuedNonce,
    });
    assert.strictEqual(badOrigin.accepted, false);
    assert.include(badOrigin.reason, "unexpected-origin");

    // 2. Cross-iframe source spoof rejected even with matching nonce
    const spoofedSource = validateSandboxMessageEvent({
      origin: "null",
      source: attackerWindow,
      expectedSource: fakeFrameWindow,
      data: { type: "rpc.invoke", nonce: issuedNonce },
      activeNonce: issuedNonce,
    });
    assert.strictEqual(spoofedSource.accepted, false);
    assert.strictEqual(spoofedSource.reason, "source-window-mismatch");

    // 3. Wrong nonce or closed enum violation rejected
    const badType = validateSandboxMessageEvent({
      origin: "null",
      source: fakeFrameWindow,
      expectedSource: fakeFrameWindow,
      data: { type: "eval.arbitrary", nonce: issuedNonce },
      activeNonce: issuedNonce,
    });
    assert.strictEqual(badType.accepted, false);

    // 4. Unmount replay rejected (activeNonce === null)
    const afterUnmount = validateSandboxMessageEvent({
      origin: "null",
      source: fakeFrameWindow,
      expectedSource: fakeFrameWindow,
      data: { type: "rpc.invoke", nonce: issuedNonce },
      activeNonce: null,
    });
    assert.strictEqual(afterUnmount.accepted, false);
    assert.strictEqual(afterUnmount.reason, "nonce-invalidated-after-unmount");
  });

  it("never embeds allow-forms, allow-same-origin, or URL/Referer nonce leakage in PluginSandboxFrame", () => {
    const src = NodeFS.readFileSync(SANDBOX_FRAME_SOURCE_PATH, "utf8");
    // Static regression check: sandbox attribute must never contain allow-forms or allow-same-origin
    assert.isFalse(/sandboxTokens\s*=.*allow-forms/u.test(src));
    assert.isFalse(/sandboxTokens\s*=.*allow-same-origin/u.test(src));
    assert.include(src, "new MessageChannel()");
    assert.include(src, 'input.origin !== "null"');

    // srcDoc contains pending-queue bootstrap and NEVER embeds any nonce token in URL/HTML
    const srcDoc = buildSandboxedPluginSrcDoc("<div>Canvas</div>");
    assert.include(srcDoc, "ByteDockSandbox");
    assert.include(srcDoc, "pending.push");
    assert.notInclude(srcDoc, "location.search");
    assert.notInclude(srcDoc, "document.referrer");
  });
});

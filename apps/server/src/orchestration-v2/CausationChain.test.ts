import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { computeOutboundCausationChain } from "./CausationChain.ts";

describe("CausationChain", () => {
  const l0 = ThreadId.make("thread:cc:l0");
  const l1a = ThreadId.make("thread:cc:l1a");
  const l1b = ThreadId.make("thread:cc:l1b");
  const l2 = ThreadId.make("thread:cc:l2");
  const peer = ThreadId.make("thread:cc:peer");

  it("allows first-hop L1 escalation when incoming chain only contains L0 or verified benign child returns", () => {
    const direct = computeOutboundCausationChain({
      callerThreadId: l1a,
      targetThreadId: l0,
      callerIncomingChain: [l0],
      intent: "escalation",
    });
    assert.equal(direct.loopDetected, false);
    assert.deepEqual(direct.causationChain, [l1a]);

    // L0 -> L1-A -> L2 -> L1-A (L2 is a verified benign child return).
    const afterL2 = computeOutboundCausationChain({
      callerThreadId: l1a,
      targetThreadId: l0,
      callerIncomingChain: [l0, l2],
      benignChildReturnThreadIds: [l2],
      intent: "escalation",
    });
    assert.equal(afterL2.loopDetected, false);
    assert.deepEqual(afterL2.causationChain, [l2, l1a]);

    // L0 -> L1-A completes -> L0 delegates fresh L1-B -> L1-B escalates to L0.
    const afterSiblingCompletion = computeOutboundCausationChain({
      callerThreadId: l1b,
      targetThreadId: l0,
      callerIncomingChain: [l1a, l0],
      benignChildReturnThreadIds: [l1a],
      intent: "escalation",
    });
    assert.equal(afterSiblingCompletion.loopDetected, false);
    assert.deepEqual(afterSiblingCompletion.causationChain, [l1a, l1b]);
  });

  it("still blocks real escalation loops, non-benign peer chains, caller self-cycles, and explicit chain overrides", () => {
    // Recursive escalation: L1-A escalated -> L0 delegated L1-B -> L1-B tries escalating to L0 (no benign exemption).
    const recursive = computeOutboundCausationChain({
      callerThreadId: l1b,
      targetThreadId: l0,
      callerIncomingChain: [l1a, l0],
      intent: "escalation",
    });
    assert.equal(recursive.loopDetected, true);
    assert.include(recursive.loopReason ?? "", "Escalation loop detected");

    // External peer wake: Peer -> L0 -> L1-A (peer is not a benign child return).
    const peerWake = computeOutboundCausationChain({
      callerThreadId: l1a,
      targetThreadId: l0,
      callerIncomingChain: [peer, l0],
      benignChildReturnThreadIds: [l2],
      intent: "escalation",
    });
    assert.equal(peerWake.loopDetected, true);

    // Caller already in incoming chain.
    const selfCycle = computeOutboundCausationChain({
      callerThreadId: l1a,
      targetThreadId: l0,
      callerIncomingChain: [l1a, l0],
      benignChildReturnThreadIds: [l1a],
      intent: "escalation",
    });
    assert.equal(selfCycle.loopDetected, true);

    // Explicit chain entries passed by caller cannot be exempted as benign.
    const explicitOverride = computeOutboundCausationChain({
      callerThreadId: l1b,
      targetThreadId: l0,
      callerIncomingChain: [l0],
      explicitChain: [l1a, l0],
      benignChildReturnThreadIds: [l1a],
      intent: "escalation",
    });
    assert.equal(explicitOverride.loopDetected, true);
  });
});

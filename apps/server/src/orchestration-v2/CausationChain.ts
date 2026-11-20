import type { ThreadId } from "@t3tools/contracts";

export type CausationChainIntent = "send" | "child_report" | "escalation" | "delegation";

export function mergeCausationChains(
  ...chains: ReadonlyArray<ReadonlyArray<ThreadId> | undefined>
): ReadonlyArray<ThreadId> {
  const merged: Array<ThreadId> = [];
  const seen = new Set<ThreadId>();
  for (const chain of chains) {
    if (chain === undefined) continue;
    for (const threadId of chain) {
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      merged.push(threadId);
    }
  }
  return merged;
}

export interface ComputedCausationChain {
  readonly causationChain: ReadonlyArray<ThreadId> | undefined;
  readonly loopDetected: boolean;
  readonly loopReason?: string;
}

/**
 * Computes and validates outbound `causationChain` across cross-thread actions: callers cannot strip
 * `callerIncomingChain`, child reports allow one upward return per downward ancestor hop, and L1
 * escalations block multi-hop re-entry loops targeting `L0`.
 */
export function computeOutboundCausationChain(input: {
  readonly callerThreadId: ThreadId | undefined;
  readonly targetThreadId: ThreadId;
  readonly callerIncomingChain?: ReadonlyArray<ThreadId> | undefined;
  readonly explicitChain?: ReadonlyArray<ThreadId> | undefined;
  readonly intent: CausationChainIntent;
  readonly callerAncestorThreadIds?: ReadonlyArray<ThreadId> | undefined;
}): ComputedCausationChain {
  const mergedIncoming = mergeCausationChains(input.callerIncomingChain, input.explicitChain);

  if (input.callerThreadId === undefined) {
    const chain = mergedIncoming.length === 0 ? undefined : mergedIncoming;
    const loopDetected = chain !== undefined && chain.includes(input.targetThreadId);
    return {
      causationChain: chain,
      loopDetected,
      ...(loopDetected
        ? {
            loopReason: `Cross-thread auto-wake loop detected: thread ${input.targetThreadId} is already in causationChain.`,
          }
        : {}),
    };
  }

  if (input.callerThreadId === input.targetThreadId) {
    if (input.intent === "delegation") {
      if (mergedIncoming.includes(input.callerThreadId)) {
        return {
          causationChain: mergedIncoming,
          loopDetected: true,
          loopReason: `Circular delegation loop detected: thread ${input.callerThreadId} is already in causationChain.`,
        };
      }
      return {
        causationChain: mergeCausationChains(mergedIncoming, [input.callerThreadId]),
        loopDetected: false,
      };
    }
    const chain = mergedIncoming.length === 0 ? undefined : mergedIncoming;
    return { causationChain: chain, loopDetected: false };
  }

  if (input.intent === "delegation") {
    if (mergedIncoming.includes(input.callerThreadId)) {
      return {
        causationChain: mergedIncoming,
        loopDetected: true,
        loopReason: `Circular delegation loop detected: thread ${input.callerThreadId} is already in causationChain.`,
      };
    }
    const chain = mergeCausationChains(mergedIncoming, [input.callerThreadId]);
    const loopDetected = chain.includes(input.targetThreadId);
    return {
      causationChain: chain,
      loopDetected,
      ...(loopDetected
        ? {
            loopReason: `Circular delegation loop detected: thread ${input.targetThreadId} is already in causationChain.`,
          }
        : {}),
    };
  }

  if (input.intent === "escalation") {
    // If caller itself is already in its incoming chain, this is a cycle regardless of target.
    if (mergedIncoming.includes(input.callerThreadId)) {
      return {
        causationChain: mergedIncoming,
        loopDetected: true,
        loopReason: `Escalation loop detected: thread ${input.callerThreadId} is already in causationChain.`,
      };
    }
    const isFreshFirstHopFromRoot =
      mergedIncoming.length === 0 ||
      (mergedIncoming.length === 1 && mergedIncoming[0] === input.targetThreadId);
    const chain = isFreshFirstHopFromRoot
      ? [input.callerThreadId]
      : mergeCausationChains(mergedIncoming, [input.callerThreadId]);
    const loopDetected = chain.includes(input.targetThreadId);
    return {
      causationChain: chain,
      loopDetected,
      ...(loopDetected
        ? {
            loopReason: `Escalation loop detected: root thread ${input.targetThreadId} is already in causationChain (${chain.join(" -> ")}).`,
          }
        : {}),
    };
  }

  if (input.intent === "child_report") {
    if (mergedIncoming.includes(input.callerThreadId)) {
      return {
        causationChain: mergedIncoming,
        loopDetected: true,
        loopReason: `Cross-thread auto-wake loop detected: thread ${input.callerThreadId} is already in causationChain.`,
      };
    }
    // Allow popping targetThreadId only when it is a legitimate upward return to a direct parent
    // whose own turn spawned/messaged this child (either tail of incoming chain or strict ancestor
    // from a nested L0 -> L1 -> L2 -> L1 -> L0 report unwind).
    const ancestors = new Set(input.callerAncestorThreadIds ?? []);
    const targetIsDirectReturn =
      mergedIncoming.includes(input.targetThreadId) &&
      (mergedIncoming[mergedIncoming.length - 1] === input.targetThreadId ||
        ancestors.has(input.targetThreadId));
    const base = targetIsDirectReturn
      ? mergedIncoming.filter((id) => id !== input.targetThreadId)
      : mergedIncoming;
    const chain = mergeCausationChains(base, [input.callerThreadId]);
    const loopDetected = chain.includes(input.targetThreadId);
    return {
      causationChain: chain,
      loopDetected,
      ...(loopDetected
        ? {
            loopReason: `Cross-thread auto-wake loop detected: thread ${input.targetThreadId} is already in causationChain.`,
          }
        : {}),
    };
  }

  // Default: ordinary cross-thread send ("send").
  const chain = mergeCausationChains(mergedIncoming, [input.callerThreadId]);
  const loopDetected = chain.includes(input.targetThreadId);
  return {
    causationChain: chain,
    loopDetected,
    ...(loopDetected
      ? {
          loopReason: `Cross-thread auto-wake loop detected: thread ${input.targetThreadId} is already in causationChain.`,
        }
      : {}),
  };
}

/**
 * Dual-track CacheGuard contract (ADR-06):
 * - stateless-api: full 5 laws + CI steady-state cachedInput >= 90%
 * - stateful-cli / stateful-acp: open-params pin + payload-wrap (outboundUserText) + native-only compact
 * - Law #6: host never fabricates provider cache metrics (X-Ray honest measured/native/opaque).
 */
export type CacheTrack = "stateless-api" | "stateful-cli" | "stateful-acp";

export interface AdapterCacheProfile {
  readonly track: CacheTrack;
  readonly prefixChannel: "request-prefix" | "open-params";
  readonly turnAppend: "suffix-request" | "payload-wrap" | "unsupported";
  readonly compaction: "host-boundary" | "native-command" | "none";
  readonly usageVisibility: "full" | "opaque";
}

export function computeProfileKey(profile: AdapterCacheProfile): string {
  return [
    profile.track,
    profile.prefixChannel,
    profile.turnAppend,
    profile.compaction,
    profile.usageVisibility,
  ].join("|");
}

export interface ProfileShiftEvent {
  readonly fromProfileKey: string;
  readonly toProfileKey: string;
  readonly turnOrdinal: number;
  readonly trigger: "model-switch" | "provider-switch";
}

/** Seam 6 Stage 1 (before prepareMcpSession): MCP server overrides enter credential reservation. */
export interface OpenPrepareContribution {
  readonly mcpServerOverrides?: ReadonlyArray<{ readonly id: string; readonly enabled: boolean }>;
  readonly mcpExposure?: {
    readonly directTools: ReadonlyArray<string>;
    readonly deferred: boolean;
  };
}

/** Seam 6 Stage 2 (before adapter.openSession): pins env & canonical sorted stable prefix blocks. */
export interface OpenContribution {
  readonly env?: Readonly<Record<string, string>>;
  readonly roleBlock?: string;
  readonly stablePrefixBlocks: ReadonlyArray<{
    readonly id: string;
    readonly hash: string;
    readonly body: string;
  }>;
  readonly mcpExposure: {
    readonly directTools: ReadonlyArray<string>;
    readonly deferred: boolean;
  };
}

/**
 * Only legal output from agent.turn.before (Law #4: never mutate warm prefix).
 * On stateful-cli/acp tracks, appendContext is combined into wire-only outboundUserText
 * without touching ProjectionStore or /compact detection.
 */
export interface TurnContextContribution {
  readonly appendContext?: string;
  readonly forceCacheReset?: { readonly reason: string; readonly compactProof: string };
}

export interface CompactContribution extends TurnContextContribution {
  readonly handoffSummary?: string;
}

export interface OutboundTurnPayload {
  readonly projectedMessage: string;
  readonly outboundUserText: string;
}

export type CacheGuardError =
  | {
      readonly _tag: "PrefixImmutabilityViolation";
      readonly offender: string;
      readonly revision: number;
    }
  | { readonly _tag: "TurnAppendUnsupported"; readonly adapter: string }
  | { readonly _tag: "ForceResetOutsideCompact"; readonly reason: string };

export interface ToolCompactionStrategy {
  readonly thresholdTokens: number;
  readonly boundaryOnly: true;
  readonly idempotentToolsOnly: boolean;
  readonly artifactDir: string;
}

export interface CacheImpactReport {
  readonly threadId: string;
  readonly turnOrdinal: number;
  readonly status: "measured" | "native" | "opaque";
  readonly cachedInput?: number;
  readonly input?: number;
  readonly cacheCreation?: number;
  readonly hostInvariants: {
    readonly prefixHashStable: boolean;
    readonly mcpSnapshotStable: boolean;
    readonly contributionInBounds: boolean;
  };
  readonly invalidatedBy?: ReadonlyArray<string>;
  readonly estimatedSavingsUsd?: number;
}

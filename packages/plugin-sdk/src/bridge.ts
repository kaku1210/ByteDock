import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/**
 * Serializable contract boundary (ADR-02: same contract, non-isomorphic dual rail).
 * Forbidden across wire: Effect / Stream / Scope / FiberRef / Symbol / Function.
 */
export type RpcNamespace = `plugins.${string}.${string}`;

export const RPC_NAMESPACE_PATTERN = /^plugins\.[a-z0-9][a-z0-9._-]*\.[a-z][a-zA-Z0-9]*$/u;

export function isValidRpcNamespace(value: string): value is RpcNamespace {
  return RPC_NAMESPACE_PATTERN.test(value);
}

/** v0.1 forbids inter-plugin calls (ADR-08): only host-client callers exist. */
export interface CallerRef {
  readonly kind: "host-client";
  readonly sessionHash: string;
}

export interface RpcRequest {
  readonly seq: number;
  readonly ns: RpcNamespace;
  readonly body: unknown;
  readonly caller: CallerRef;
  readonly callerScopes: ReadonlyArray<string>;
  readonly deadlineMs: number;
}

export interface RpcResponse {
  readonly seq: number;
  readonly ok: boolean;
  readonly body?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export type PluginStreamQos = "interactive" | "log" | "diagnostic";

export interface StreamFrame {
  readonly seq: number;
  readonly ns: RpcNamespace;
  readonly cursor?: string | undefined;
  readonly qos?: PluginStreamQos | undefined;
  readonly chunks?: ReadonlyArray<unknown> | undefined;
  readonly done?: boolean | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
}

/** Hook budgets: open/compact = 2000ms; turn hot-path total across all plugins = 500ms. */
export interface HookInvocation {
  readonly name: string;
  readonly input: unknown;
  readonly revision: number;
  readonly deadlineMs: number;
}

export interface HookDecision {
  readonly verdict: "pass" | "deny";
  readonly contribution?: unknown;
  readonly reason?: string | undefined;
}

export interface PluginWorkerBridge {
  readonly rpc: (req: RpcRequest) => Effect.Effect<RpcResponse>;
  readonly stream: (req: RpcRequest) => Stream.Stream<StreamFrame>;
  readonly hook: (inv: HookInvocation) => Effect.Effect<HookDecision>;
}

export type BrokerDenyReason =
  | { readonly _tag: "UnknownNamespace" }
  | {
      readonly _tag: "ScopeIntersectionEmpty";
      readonly required: ReadonlyArray<string>;
      readonly have: ReadonlyArray<string>;
    }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "PluginNotActive"; readonly revision: number };

export type BrokerAuthResult =
  | { readonly allowed: true; readonly auditId: string }
  | { readonly allowed: false; readonly reason: BrokerDenyReason };

export interface PluginScopeBrokerService {
  readonly authorize: (args: {
    readonly caller: CallerRef;
    readonly callerScopes: ReadonlyArray<string>;
    readonly pluginId: string;
    readonly method: string;
  }) => Effect.Effect<BrokerAuthResult>;
}

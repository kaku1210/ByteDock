// @effect-diagnostics nodeBuiltinImport:off -- Audit ID generation uses node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  isValidRpcNamespace,
  type BrokerAuthResult,
  type CallerRef,
  type PluginScopeBrokerService,
} from "@bytedock/plugin-sdk/bridge";

export interface RegisteredPluginMethod {
  readonly pluginId: string;
  readonly method: string;
  readonly revision: number;
  readonly manifestScopes: ReadonlyArray<string>;
  readonly methodMinScopes: ReadonlyArray<string>;
}

export interface BrokerAuditEvent {
  readonly auditId: string;
  readonly ts: number;
  readonly actor: string;
  readonly callerHash: string;
  readonly target: string;
  readonly scopeIntersection: ReadonlyArray<string>;
  readonly verdict: "allow" | "deny";
  readonly denyTag?: string | undefined;
}

export interface PluginScopeBrokerAdmin extends PluginScopeBrokerService {
  readonly registerMethod: (entry: RegisteredPluginMethod) => Effect.Effect<void>;
  readonly unregisterPlugin: (pluginId: string) => Effect.Effect<void>;
  readonly getAuditEvents: () => Effect.Effect<ReadonlyArray<BrokerAuditEvent>>;
}

export class PluginScopeBroker extends Context.Service<PluginScopeBroker, PluginScopeBrokerAdmin>()(
  "@bytedock/plugin-kernel/broker/PluginScopeBroker",
) {}

export const makePluginScopeBroker = Effect.fn("pluginKernel.makePluginScopeBroker")(function* (
  onAudit?: (event: BrokerAuditEvent) => Effect.Effect<void>,
) {
  const methodsRef = yield* Ref.make(new Map<string, RegisteredPluginMethod>());
  const auditsRef = yield* Ref.make<Array<BrokerAuditEvent>>([]);

  const recordAudit = Effect.fn("PluginScopeBroker.recordAudit")(function* (
    event: BrokerAuditEvent,
  ) {
    yield* Ref.update(auditsRef, (arr) => [...arr, event]);
    if (onAudit) yield* onAudit(event);
  });

  const authorize: PluginScopeBrokerService["authorize"] = Effect.fn("PluginScopeBroker.authorize")(
    function* (args: {
      readonly caller: CallerRef;
      readonly callerScopes: ReadonlyArray<string>;
      readonly pluginId: string;
      readonly method: string;
    }) {
      const auditId = NodeCrypto.randomUUID();
      const ns = `plugins.${args.pluginId}.${args.method}`;
      const ts = yield* Clock.currentTimeMillis;

      // Namespace whitelist check (ADR-08): syntax + active registry entry.
      if (!isValidRpcNamespace(ns)) {
        yield* recordAudit({
          auditId,
          ts,
          actor: args.caller.kind,
          callerHash: args.caller.sessionHash,
          target: ns,
          scopeIntersection: [],
          verdict: "deny",
          denyTag: "UnknownNamespace",
        });
        return { allowed: false, reason: { _tag: "UnknownNamespace" } } satisfies BrokerAuthResult;
      }

      const entry = (yield* Ref.get(methodsRef)).get(ns);
      if (!entry) {
        yield* recordAudit({
          auditId,
          ts,
          actor: args.caller.kind,
          callerHash: args.caller.sessionHash,
          target: ns,
          scopeIntersection: [],
          verdict: "deny",
          denyTag: "UnknownNamespace",
        });
        return { allowed: false, reason: { _tag: "UnknownNamespace" } } satisfies BrokerAuthResult;
      }

      // Three-way scope intersection: callerScopes ∩ manifestScopes ∩ methodMinScopes.
      const callerSet = new Set(args.callerScopes);
      const manifestSet = new Set(entry.manifestScopes);
      const intersection = entry.methodMinScopes.filter(
        (scope) => callerSet.has(scope) && manifestSet.has(scope),
      );

      if (intersection.length === 0) {
        yield* recordAudit({
          auditId,
          ts,
          actor: args.caller.kind,
          callerHash: args.caller.sessionHash,
          target: ns,
          scopeIntersection: [],
          verdict: "deny",
          denyTag: "ScopeIntersectionEmpty",
        });
        return {
          allowed: false,
          reason: {
            _tag: "ScopeIntersectionEmpty",
            required: entry.methodMinScopes,
            have: args.callerScopes,
          },
        } satisfies BrokerAuthResult;
      }

      yield* recordAudit({
        auditId,
        ts,
        actor: args.caller.kind,
        callerHash: args.caller.sessionHash,
        target: ns,
        scopeIntersection: intersection,
        verdict: "allow",
      });
      return { allowed: true, auditId } satisfies BrokerAuthResult;
    },
  );

  return {
    authorize,
    registerMethod: (entry) =>
      Ref.update(methodsRef, (map) => {
        const next = new Map(map);
        next.set(`plugins.${entry.pluginId}.${entry.method}`, entry);
        return next;
      }),
    unregisterPlugin: (pluginId) =>
      Ref.update(methodsRef, (map) => {
        const next = new Map(map);
        const prefix = `plugins.${pluginId}.`;
        for (const key of next.keys()) {
          if (key.startsWith(prefix)) next.delete(key);
        }
        return next;
      }),
    getAuditEvents: () => Ref.get(auditsRef),
  } satisfies PluginScopeBrokerAdmin;
});

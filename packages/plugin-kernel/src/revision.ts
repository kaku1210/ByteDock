import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import type { EsmTlaRejectedError, PluginCompileError } from "./compiler.ts";
import type { LoadedPluginModule, PluginLoadError, SingletonSplitError } from "./hostModules.ts";

export type RevisionState = "loading" | "active" | "draining" | "frozen-due" | "evicted" | "closed";

export interface PluginRevision {
  readonly rev: number;
  readonly scope: Scope.Closeable;
  readonly manifests: ReadonlyArray<ByteDockPluginManifest>;
  readonly state: RevisionState;
  readonly frozen: boolean;
  readonly installedAt: number;
  /** R3 Target 1.1: anchored strictly to frozenAt (undefined while active). */
  readonly frozenAt: number | undefined;
  readonly drainDeadline: number | undefined;
  readonly forceReapAt: number | undefined;
  readonly refCount: () => number;
}

export interface PinRecord {
  readonly sessionId: string;
  readonly rev: number;
  readonly pinnedAt: number;
  /** R3 Target 1.4: monotonic remaining lifetime (immune to OS sleep wall-clock jumps). */
  readonly graceRemainingMs: number;
  readonly wallAtLastCalib: number;
  readonly lastTouchedAt: number;
  readonly state: "live" | "idle-detached" | "stale-revision";
}

export interface ProviderSessionLost {
  readonly reason: "revision-evicted" | "idle-detached-expired";
  readonly revision: number;
  readonly inFlightAtEvict: ReadonlyArray<{
    readonly toolName: string;
    readonly attemptId: string;
  }>;
}

export class ManifestValidationError extends Schema.TaggedError<ManifestValidationError>()(
  "ManifestValidationError",
  {
    pluginId: Schema.String,
    reason: Schema.String,
  },
) {}

export class BootError extends Schema.TaggedError<BootError>()("BootError", {
  pluginId: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ReloadFailure =
  | PluginCompileError
  | ManifestValidationError
  | BootError
  | SingletonSplitError
  | PluginLoadError
  | EsmTlaRejectedError;

export interface RevisionPolicy {
  readonly graceMs: number;
  readonly drainInFlightMs: number;
  readonly idleDetachMs: number;
  readonly forceReapMs: number;
  readonly coalesceMs: number;
  readonly touch: {
    readonly maxIntervalMs: number;
    readonly thresholdPct: number;
  };
}

/** R3 Target 1.4 linked touch throttle formula so short forceReapMs never starves pin renewal. */
export function computeRevisionPolicy(overrides?: {
  readonly graceMs?: number | undefined;
  readonly drainInFlightMs?: number | undefined;
  readonly idleDetachMs?: number | undefined;
  readonly forceReapMs?: number | undefined;
  readonly coalesceMs?: number | undefined;
}): RevisionPolicy {
  const forceReapMs = Math.min(
    72 * 60 * 60_000,
    Math.max(60_000, overrides?.forceReapMs ?? 24 * 60 * 60_000),
  );
  const maxIntervalMs = Math.min(10 * 60_000, Math.floor(forceReapMs / 4));
  const thresholdPct = Math.min(
    0.75,
    Math.max(0.25, (forceReapMs / Math.max(1, maxIntervalMs)) * 0.125),
  );
  return {
    graceMs: overrides?.graceMs ?? 30_000,
    drainInFlightMs: overrides?.drainInFlightMs ?? 15_000,
    idleDetachMs: overrides?.idleDetachMs ?? 30 * 60_000,
    forceReapMs,
    coalesceMs: overrides?.coalesceMs ?? 500,
    touch: {
      maxIntervalMs,
      thresholdPct,
    },
  };
}

export interface RevisionManagerService {
  readonly policy: RevisionPolicy;
  readonly active: () => Effect.Effect<PluginRevision>;
  readonly stateOf: (rev: number) => Effect.Effect<RevisionState | undefined>;
  readonly revisions: () => Effect.Effect<ReadonlyArray<PluginRevision>>;
  readonly pin: (sessionId: string, nowMs?: number) => Effect.Effect<number>;
  readonly touchPin: (
    sessionId: string,
    nowMs: number,
    options?: { readonly isWakeupCalibration?: boolean | undefined },
  ) => Effect.Effect<boolean>;
  readonly unpin: (
    sessionId: string,
    reason: "closed" | "idle-detach",
    nowMs?: number,
  ) => Effect.Effect<void>;
  readonly getPin: (sessionId: string) => Effect.Effect<PinRecord | undefined>;
  readonly installRevision: (input: {
    readonly manifests: ReadonlyArray<ByteDockPluginManifest>;
    readonly modules?: ReadonlyArray<LoadedPluginModule> | undefined;
    readonly nowMs?: number | undefined;
  }) => Effect.Effect<PluginRevision>;
  readonly sweep: (nowMs: number) => Effect.Effect<ReadonlyArray<number>>;
  readonly assertInvariants: () => Effect.Effect<void>;
}

export class RevisionManager extends Context.Service<RevisionManager, RevisionManagerService>()(
  "@bytedock/plugin-kernel/revision/RevisionManager",
) {}

interface MutableRevisionEntry {
  readonly rev: number;
  readonly scope: Scope.Closeable;
  readonly manifests: ReadonlyArray<ByteDockPluginManifest>;
  state: RevisionState;
  frozen: boolean;
  readonly installedAt: number;
  frozenAt: number | undefined;
  drainDeadline: number | undefined;
  forceReapAt: number | undefined;
  drainRetryCount: number;
  readonly pinnedSessions: Set<string>;
  modules: ReadonlyArray<LoadedPluginModule> | undefined;
  readonly weakRefs: ReadonlyArray<WeakRef<LoadedPluginModule>>;
}

export const makeRevisionManager = Effect.fn("pluginKernel.makeRevisionManager")(function* (
  policyOverrides?: Parameters<typeof computeRevisionPolicy>[0],
) {
  const policy = computeRevisionPolicy(policyOverrides);
  const reloadSemaphore = yield* Semaphore.make(1);
  const initialScope = yield* Scope.make();
  const bootNow = yield* Clock.currentTimeMillis;

  const initialEntry: MutableRevisionEntry = {
    rev: 1,
    scope: initialScope,
    manifests: [],
    state: "active",
    frozen: false,
    installedAt: bootNow,
    frozenAt: undefined,
    drainDeadline: undefined,
    forceReapAt: undefined,
    drainRetryCount: 0,
    pinnedSessions: new Set(),
    modules: [],
    weakRefs: [],
  };

  const stateRef = yield* Ref.make({
    nextRev: 2,
    activeRev: 1,
    entries: new Map<number, MutableRevisionEntry>([[1, initialEntry]]),
    pins: new Map<string, PinRecord>(),
  });

  const toPublicRevision = (entry: MutableRevisionEntry): PluginRevision => ({
    rev: entry.rev,
    scope: entry.scope,
    manifests: entry.manifests,
    state: entry.state,
    frozen: entry.frozen,
    installedAt: entry.installedAt,
    frozenAt: entry.frozenAt,
    drainDeadline: entry.drainDeadline,
    forceReapAt: entry.forceReapAt,
    refCount: () => entry.pinnedSessions.size,
  });

  const active = () =>
    Ref.get(stateRef).pipe(
      Effect.map((s) => {
        const entry = s.entries.get(s.activeRev);
        if (!entry) throw new Error(`Active revision ${s.activeRev} missing.`);
        return toPublicRevision(entry);
      }),
    );

  const stateOf = (rev: number) =>
    Ref.get(stateRef).pipe(Effect.map((s) => s.entries.get(rev)?.state));

  const revisions = () =>
    Ref.get(stateRef).pipe(Effect.map((s) => [...s.entries.values()].map(toPublicRevision)));

  const pin = Effect.fn("RevisionManager.pin")(function* (sessionId: string, nowMs?: number) {
    const resolvedNow = nowMs ?? (yield* Clock.currentTimeMillis);
    return yield* Ref.modify(stateRef, (s) => {
      const current = s.entries.get(s.activeRev);
      if (!current || current.frozen || current.state !== "active") {
        throw new Error("Cannot pin: active revision is frozen or non-active.");
      }
      const prevPin = s.pins.get(sessionId);
      if (prevPin) {
        s.entries.get(prevPin.rev)?.pinnedSessions.delete(sessionId);
      }
      current.pinnedSessions.add(sessionId);
      s.pins.set(sessionId, {
        sessionId,
        rev: current.rev,
        pinnedAt: resolvedNow,
        graceRemainingMs: policy.forceReapMs,
        wallAtLastCalib: resolvedNow,
        lastTouchedAt: resolvedNow,
        state: "live",
      });
      return [current.rev, s] as const;
    });
  });

  const touchPin = (
    sessionId: string,
    nowMs: number,
    options?: { readonly isWakeupCalibration?: boolean | undefined },
  ) =>
    Ref.modify(stateRef, (s) => {
      const record = s.pins.get(sessionId);
      if (!record || record.state !== "live") return [false, s] as const;
      if (options?.isWakeupCalibration) {
        s.pins.set(sessionId, {
          ...record,
          graceRemainingMs: policy.forceReapMs,
          wallAtLastCalib: nowMs,
          lastTouchedAt: nowMs,
        });
        return [true, s] as const;
      }
      const elapsed = Math.max(0, nowMs - record.lastTouchedAt);
      if (elapsed < policy.touch.maxIntervalMs) {
        return [false, s] as const;
      }
      const remaining = record.graceRemainingMs - Math.max(0, nowMs - record.wallAtLastCalib);
      if (remaining > policy.forceReapMs * policy.touch.thresholdPct) {
        return [false, s] as const;
      }
      s.pins.set(sessionId, {
        ...record,
        graceRemainingMs: policy.forceReapMs,
        wallAtLastCalib: nowMs,
        lastTouchedAt: nowMs,
      });
      return [true, s] as const;
    });

  const unpin = Effect.fn("RevisionManager.unpin")(function* (
    sessionId: string,
    reason: "closed" | "idle-detach",
    nowMs?: number,
  ) {
    const resolvedNow = nowMs ?? (yield* Clock.currentTimeMillis);
    yield* Ref.update(stateRef, (s) => {
      const record = s.pins.get(sessionId);
      if (!record) return s;
      const entry = s.entries.get(record.rev);
      entry?.pinnedSessions.delete(sessionId);
      if (reason === "closed") {
        s.pins.delete(sessionId);
      } else {
        s.pins.set(sessionId, {
          ...record,
          state: "idle-detached",
          wallAtLastCalib: resolvedNow,
        });
      }
      if (
        entry &&
        entry.frozen &&
        entry.pinnedSessions.size === 0 &&
        entry.state === "frozen-due"
      ) {
        entry.state = "draining";
        entry.drainDeadline = Math.max(
          entry.drainDeadline ?? resolvedNow,
          resolvedNow + policy.graceMs,
        );
      }
      return s;
    });
  });

  const getPin = (sessionId: string) =>
    Ref.get(stateRef).pipe(Effect.map((s) => s.pins.get(sessionId)));

  const installRevision = (input: {
    readonly manifests: ReadonlyArray<ByteDockPluginManifest>;
    readonly modules?: ReadonlyArray<LoadedPluginModule> | undefined;
    readonly nowMs?: number | undefined;
  }) =>
    reloadSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = input.nowMs ?? (yield* Clock.currentTimeMillis);
        const nextScope = yield* Scope.make();
        const mods = input.modules ?? [];
        return yield* Ref.modify(stateRef, (s) => {
          const prev = s.entries.get(s.activeRev);
          const rev = s.nextRev;
          const nextEntry: MutableRevisionEntry = {
            rev,
            scope: nextScope,
            manifests: input.manifests,
            state: "active",
            frozen: false,
            installedAt: nowMs,
            frozenAt: undefined,
            drainDeadline: undefined,
            forceReapAt: undefined,
            drainRetryCount: 0,
            pinnedSessions: new Set(),
            modules: mods,
            weakRefs: mods.map((m) => new WeakRef(m)),
          };
          if (prev) {
            prev.frozen = true;
            prev.frozenAt = nowMs;
            prev.drainDeadline = nowMs + policy.graceMs;
            prev.forceReapAt = nowMs + policy.forceReapMs;
            prev.state = "draining";
          }
          s.entries.set(rev, nextEntry);
          s.activeRev = rev;
          s.nextRev = rev + 1;
          return [toPublicRevision(nextEntry), s] as const;
        });
      }),
    );

  const sweep = Effect.fn("RevisionManager.sweep")(function* (nowMs: number) {
    const toClose: Array<MutableRevisionEntry> = [];
    yield* Ref.update(stateRef, (s) => {
      for (const entry of s.entries.values()) {
        if (entry.state === "active" || entry.state === "evicted" || entry.state === "closed") {
          continue;
        }
        const forceDue =
          entry.frozen && entry.forceReapAt !== undefined && nowMs >= entry.forceReapAt;
        const drained =
          entry.state === "draining" &&
          entry.pinnedSessions.size === 0 &&
          entry.drainDeadline !== undefined &&
          nowMs >= entry.drainDeadline;

        if (drained) {
          entry.state = "evicted";
          entry.modules = undefined;
          toClose.push(entry);
        } else if (forceDue) {
          // Mark surviving sessions stale-revision before evicting (I5).
          for (const sid of entry.pinnedSessions) {
            const p = s.pins.get(sid);
            if (p && p.rev === entry.rev) {
              s.pins.set(sid, { ...p, state: "stale-revision", wallAtLastCalib: nowMs });
            }
          }
          entry.pinnedSessions.clear();
          entry.state = "evicted";
          entry.modules = undefined;
          toClose.push(entry);
        } else if (
          entry.state === "draining" &&
          entry.drainDeadline !== undefined &&
          nowMs >= entry.drainDeadline &&
          entry.pinnedSessions.size > 0
        ) {
          entry.drainRetryCount += 1;
          if (entry.drainRetryCount > 3) {
            entry.state = "frozen-due";
          } else {
            entry.drainDeadline = nowMs + policy.graceMs;
          }
        }
      }
      return s;
    });

    const evictedRevs: Array<number> = [];
    for (const entry of toClose) {
      yield* Scope.close(entry.scope, Exit.void);
      entry.state = "closed";
      evictedRevs.push(entry.rev);
    }
    return evictedRevs;
  });

  const assertInvariants = () =>
    Ref.get(stateRef).pipe(
      Effect.map((s) => {
        const entries = [...s.entries.values()];
        const actives = entries.filter((e) => e.state === "active");
        if (actives.length !== 1) {
          throw new Error(
            `Invariant I1 violated: expected 1 active revision, got ${actives.length}`,
          );
        }
        for (const e of entries) {
          if (e.state === "active" && (e.frozen || e.frozenAt !== undefined)) {
            throw new Error(`Invariant I2 violated: active rev ${e.rev} is frozen.`);
          }
          if (e.frozen && e.frozenAt === undefined) {
            throw new Error(`Invariant I3 violated: frozen rev ${e.rev} missing frozenAt.`);
          }
          if (
            e.drainDeadline !== undefined &&
            e.frozenAt !== undefined &&
            e.drainDeadline < e.frozenAt
          ) {
            throw new Error(`Invariant I3 violated: rev ${e.rev} drainDeadline < frozenAt.`);
          }
          if ((e.state === "evicted" || e.state === "closed") && e.modules !== undefined) {
            throw new Error(
              `Invariant I4 violated: closed rev ${e.rev} still holds module references.`,
            );
          }
        }
      }),
    );

  return {
    policy,
    active,
    stateOf,
    revisions,
    pin,
    touchPin,
    unpin,
    getPin,
    installRevision,
    sweep,
    assertInvariants,
  } satisfies RevisionManagerService;
});

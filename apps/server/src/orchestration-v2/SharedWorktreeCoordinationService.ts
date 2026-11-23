import {
  IsoDateTime,
  RunId,
  SharedWorktreeCoordinationError,
  SharedWorktreeReservationId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Actor,
  type OrchestrationV2ThreadShell,
  type SharedWorktreeCheckoutPolicy,
  type SharedWorktreeConfirmedWriteEntry,
  type SharedWorktreeCoordinationSnapshot,
  type SharedWorktreeFileRevision,
  type SharedWorktreeObservedPath,
  type SharedWorktreePathOverlap,
  type SharedWorktreePlannedPathEntry,
  type SharedWorktreeSerializationMode,
  type SharedWorktreeSerializedRunEntry,
  type SharedWorktreeShellConstraintCoverage,
  type SharedWorktreeThreadAttribution,
  type SharedWorktreeWriteReservation,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  canonicalizeCheckoutPath,
  canonicalizeCheckoutPathRaw,
  classifyCanonicalPathConflict,
  computePathOverlaps,
  normalizeCheckoutRelativePath,
  normalizeCheckoutRelativePathRaw,
  type CanonicalCheckout,
  type NormalizedCheckoutPath,
  type OverlapInputEntry,
} from "./SharedWorktreePathUtils.ts";

const MAX_REVISION_PREVIEW_BYTES = 256 * 1024;
const CANONICAL_CHECKOUT_CACHE_TTL_MS = 60_000;
const MAX_CANONICAL_CHECKOUT_CACHE_ENTRIES = 512;
const NORMALIZED_PATH_CACHE_TTL_MS = 30_000;
const MAX_NORMALIZED_PATH_CACHE_ENTRIES = 4_096;
const CHECKOUT_SNAPSHOT_CACHE_TTL_MS = 3_000;
const GIT_LOCAL_STATUS_CACHE_TTL_MS = 3_000;
const encodeStringArrayJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

function decodeUtf8OrNull(bytes: Uint8Array, stream: boolean): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream });
  } catch {
    return null;
  }
}

interface PlannedPathRow {
  readonly thread_id: string;
  readonly normalized_path: string;
  readonly raw_path: string;
  readonly run_id: string | null;
  readonly note: string | null;
  readonly declared_at: string;
}

interface CheckoutPolicyRow {
  readonly checkout_key: string;
  readonly checkout_path: string;
  readonly serialization_mode: string;
  readonly updated_at: string;
  readonly updated_by: string | null;
}

interface ControlledWriteRow {
  readonly write_id: string;
  readonly checkout_key: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly normalized_path: string;
  readonly raw_path: string;
  readonly old_normalized_path: string | null;
  readonly old_raw_path: string | null;
  readonly operation: string;
  readonly updated_at: string;
}

interface TurnItemFileChangeSummaryRow {
  readonly thread_id: string;
  readonly item_count: number;
  readonly max_updated_at: string | null;
  readonly total_payload_bytes: number | null;
  readonly max_ordinal: number | null;
}

interface CachedTurnItemFileChange {
  readonly rawPath: string;
  readonly normalizedPath: string;
  readonly canonicalKey: string;
  readonly oldRawPath: string | null;
  readonly oldNormalizedPath: string | null;
  readonly oldCanonicalKey: string | null;
  readonly operation: string;
  readonly runId: RunId | null;
  readonly turnItemId: TurnItemId | null;
  readonly updatedAt: IsoDateTime;
}

interface ThreadFileChangeCacheEntry {
  readonly fingerprint: string;
  readonly entries: ReadonlyArray<CachedTurnItemFileChange>;
}

interface CheckoutThreadAttributionBase extends Omit<SharedWorktreeThreadAttribution, "inFamily"> {
  readonly rootThreadId: ThreadId;
}

interface CheckoutSnapshotBase {
  readonly checkoutPath: string;
  readonly checkoutKey: string;
  readonly policy: SharedWorktreeCheckoutPolicy;
  readonly threadBases: ReadonlyArray<CheckoutThreadAttributionBase>;
  readonly overlaps: ReadonlyArray<SharedWorktreePathOverlap>;
  readonly observedUnverifiedPaths: ReadonlyArray<SharedWorktreeObservedPath>;
  readonly activeReservations: ReadonlyArray<SharedWorktreeWriteReservation>;
  readonly waitingReservations: ReadonlyArray<SharedWorktreeWriteReservation>;
  readonly activeSerializedRun: SharedWorktreeSerializedRunEntry | null;
  readonly waitingSerializedRuns: ReadonlyArray<SharedWorktreeSerializedRunEntry>;
  readonly generatedAt: IsoDateTime;
}

type GitLocalStatusResult = Effect.Success<
  ReturnType<GitWorkflowService.GitWorkflowService["Service"]["localStatus"]>
>;

interface InternalReservation {
  readonly reservationId: SharedWorktreeReservationId;
  readonly checkoutKey: string;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly entries: ReadonlyArray<NormalizedCheckoutPath>;
  readonly renameKeys: ReadonlySet<string>;
  readonly acquiredAt: IsoDateTime;
}

interface InternalWaitingReservation {
  readonly reservationId: SharedWorktreeReservationId;
  readonly checkoutKey: string;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly entries: ReadonlyArray<NormalizedCheckoutPath>;
  readonly renameKeys: ReadonlySet<string>;
  readonly enqueuedAt: IsoDateTime;
  waitingOnReservationIds: ReadonlyArray<SharedWorktreeReservationId>;
}

interface InternalCheckoutTurnLease {
  readonly leaseId: string;
  readonly checkoutKey: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly enqueuedAt: IsoDateTime;
  acquiredAt: IsoDateTime | null;
}

export interface AcquireWriteReservationInput {
  readonly threadId: ThreadId;
  readonly runId?: RunId | null;
  readonly paths: ReadonlyArray<string>;
  readonly renamePairs?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

export interface AcquireWriteReservationResult {
  readonly reservation: SharedWorktreeWriteReservation;
  readonly waited: boolean;
  readonly priorWriters: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
  }>;
  readonly latestFiles: ReadonlyArray<SharedWorktreeFileRevision>;
}

export interface ControlledWriteFileInput {
  readonly threadId: ThreadId;
  readonly runId?: RunId | null;
  readonly path: string;
  readonly renameFrom?: string;
  readonly contents: string;
  readonly expectedSha256?: string;
}

export interface ControlledWriteFileResult {
  readonly writtenFile: SharedWorktreeFileRevision;
  readonly waited: boolean;
  readonly priorWriters: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
  }>;
}

export interface CheckoutTurnLeaseHandle {
  readonly serialized: boolean;
  readonly release: Effect.Effect<void>;
}

export interface SharedWorktreeCoordinationServiceShape {
  readonly getSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<SharedWorktreeCoordinationSnapshot, SharedWorktreeCoordinationError>;
  readonly setPolicy: (input: {
    readonly threadId: ThreadId;
    readonly serializationMode: SharedWorktreeSerializationMode;
    readonly updatedBy?: OrchestrationV2Actor;
  }) => Effect.Effect<SharedWorktreeCheckoutPolicy, SharedWorktreeCoordinationError>;
  readonly setPlannedPaths: (input: {
    readonly threadId: ThreadId;
    readonly paths: ReadonlyArray<string>;
    readonly runId?: RunId | null;
    readonly note?: string | null;
  }) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly plannedPaths: ReadonlyArray<SharedWorktreePlannedPathEntry>;
      readonly overlaps: ReadonlyArray<SharedWorktreePathOverlap>;
    },
    SharedWorktreeCoordinationError
  >;
  readonly acquireWriteReservation: (
    input: AcquireWriteReservationInput,
  ) => Effect.Effect<AcquireWriteReservationResult, SharedWorktreeCoordinationError>;
  readonly releaseWriteReservation: (input: {
    readonly threadId: ThreadId;
    readonly runId?: RunId | null;
    readonly reservationId?: SharedWorktreeReservationId;
  }) => Effect.Effect<number, SharedWorktreeCoordinationError>;
  readonly controlledWriteFile: (
    input: ControlledWriteFileInput,
  ) => Effect.Effect<ControlledWriteFileResult, SharedWorktreeCoordinationError>;
  readonly acquireCheckoutTurnLease: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<CheckoutTurnLeaseHandle>;
  readonly suspendCheckoutTurnLease: <A, E, R>(
    threadId: ThreadId,
    runId: RunId | null,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly releaseRunReservations: (threadId: ThreadId, runId: RunId) => Effect.Effect<number>;
  readonly clearThreadState: (threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void>;
  readonly watchCoordinationChange: Effect.Effect<Effect.Effect<void>>;
}

export class SharedWorktreeCoordinationService extends Context.Service<
  SharedWorktreeCoordinationService,
  SharedWorktreeCoordinationServiceShape
>()("t3/orchestration-v2/SharedWorktreeCoordinationService") {}

function buildShellConstraintCoverage(
  serializationMode: SharedWorktreeSerializationMode,
): SharedWorktreeShellConstraintCoverage {
  const checkoutWriteSerializationEnabled = serializationMode === "serialize_checkout_writes";
  return {
    serverEnforcedWorktreeGate: true,
    serverEnforcedWriteReservation: true,
    checkoutWriteSerializationEnabled,
    shellGitWorktreeConstraint: "provider_tool_permission",
    summary: checkoutWriteSerializationEnabled
      ? "Server enforces worktree approval gate, normalized write-path reservations, and checkout-level turn serialization. Shell 'git worktree add' commands still rely on the provider runtime's tool-permission approval policy."
      : "Server enforces worktree approval gate and normalized write-path reservations for controllable write tools. Uncontrolled shell commands (including 'git worktree add') rely on the provider runtime's tool-permission approval policy; enable checkout write serialization for strict shell write ordering.",
  };
}

function toPublicReservation(reservation: InternalReservation): SharedWorktreeWriteReservation {
  return {
    reservationId: reservation.reservationId,
    checkoutKey: reservation.checkoutKey,
    threadId: reservation.threadId,
    runId: reservation.runId,
    paths: reservation.entries.map((entry) => entry.normalizedPath),
    canonicalPaths: reservation.entries.map((entry) => entry.canonicalKey),
    status: "active",
    waitingOnReservationIds: [],
    acquiredAt: reservation.acquiredAt,
  };
}

function toPublicWaitingReservation(
  waiting: InternalWaitingReservation,
): SharedWorktreeWriteReservation {
  return {
    reservationId: waiting.reservationId,
    checkoutKey: waiting.checkoutKey,
    threadId: waiting.threadId,
    runId: waiting.runId,
    paths: waiting.entries.map((entry) => entry.normalizedPath),
    canonicalPaths: waiting.entries.map((entry) => entry.canonicalKey),
    status: "waiting",
    waitingOnReservationIds: [...waiting.waitingOnReservationIds],
    acquiredAt: waiting.enqueuedAt,
  };
}

function sameHolder(
  active: { readonly threadId: ThreadId; readonly runId: RunId | null },
  candidate: { readonly threadId: ThreadId; readonly runId: RunId | null },
): boolean {
  if (active.threadId !== candidate.threadId) return false;
  if (active.runId === null || candidate.runId === null) return true;
  return active.runId === candidate.runId;
}

function entriesConflict(
  left: ReadonlyArray<NormalizedCheckoutPath>,
  right: ReadonlyArray<NormalizedCheckoutPath>,
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (classifyCanonicalPathConflict(a.canonicalKey, b.canonicalKey) !== null) {
        return true;
      }
    }
  }
  return false;
}

function computeThreadDepth(
  thread: OrchestrationV2ThreadShell,
  byId: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>,
): number {
  let depth = 0;
  let current: OrchestrationV2ThreadShell | undefined = thread;
  const visited = new Set<ThreadId>([thread.id]);
  while (current !== undefined) {
    const parentId = current.lineage.parentThreadId;
    if (parentId === null || visited.has(parentId)) break;
    visited.add(parentId);
    depth += 1;
    current = byId.get(parentId);
  }
  return depth;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return Buffer.from(digest).toString("hex");
}

function toSerializationMode(value: string): SharedWorktreeSerializationMode {
  return value === "serialize_checkout_writes" ? "serialize_checkout_writes" : "parallel";
}

function toActorOrNull(value: string | null): OrchestrationV2Actor | null {
  if (value === "user" || value === "agent" || value === "system") return value;
  return null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const gitWorkflowOption = yield* Effect.serviceOption(GitWorkflowService.GitWorkflowService);
  const secureRandomOption = yield* Effect.serviceOption(SecureRandom.SecureRandom);
  let fallbackIdSeq = 0;
  const nextGeneratedId = (prefix: string) =>
    Option.isSome(secureRandomOption)
      ? secureRandomOption.value.uuidV4().pipe(Effect.map((id) => `${prefix}:${id}`))
      : Clock.currentTimeMillis.pipe(Effect.map((ms) => `${prefix}:${ms}:${++fallbackIdSeq}`));

  const activeReservations = new Map<SharedWorktreeReservationId, InternalReservation>();
  const waitingReservations: Array<InternalWaitingReservation> = [];
  let reservationSignal = Deferred.makeUnsafe<void>();

  const activeCheckoutLeases = new Map<string, InternalCheckoutTurnLease>();
  const waitingCheckoutLeases = new Map<string, Array<InternalCheckoutTurnLease>>();
  let checkoutLeaseSignal = Deferred.makeUnsafe<void>();
  let coordinationChangeSignal = Deferred.makeUnsafe<void>();
  let coordinationVersion = 0;

  const checkoutSnapshotBaseCache = new Map<
    string,
    {
      readonly shellSequence: number;
      readonly coordinationVersion: number;
      readonly expiresAtMs: number;
      readonly base: CheckoutSnapshotBase;
    }
  >();
  const inFlightCheckoutBase = new Map<
    string,
    Deferred.Deferred<CheckoutSnapshotBase, SharedWorktreeCoordinationError>
  >();
  const gitStatusCache = new Map<
    string,
    { readonly status: GitLocalStatusResult | null; readonly expiresAtMs: number }
  >();
  const inFlightGitStatus = new Map<string, Deferred.Deferred<GitLocalStatusResult | null>>();
  const canonicalCheckoutCache = new Map<
    string,
    { readonly value: CanonicalCheckout; readonly expiresAtMs: number }
  >();
  const normalizedPathCache = new Map<
    string,
    { readonly value: NormalizedCheckoutPath | null; readonly expiresAtMs: number }
  >();
  const threadFileChangeCache = new Map<ThreadId, ThreadFileChangeCacheEntry>();

  const bumpCoordinationVersion = (checkoutKey?: string) => {
    coordinationVersion += 1;
    if (checkoutKey !== undefined) {
      checkoutSnapshotBaseCache.delete(checkoutKey);
    } else {
      checkoutSnapshotBaseCache.clear();
    }
  };

  const invalidateCheckoutPathCache = (checkoutPath: string) => {
    const prefix = `${checkoutPath}\0`;
    for (const key of normalizedPathCache.keys()) {
      if (key.startsWith(prefix)) {
        normalizedPathCache.delete(key);
      }
    }
  };

  const singleFlight = <A, E>(
    flights: Map<string, Deferred.Deferred<A, E>>,
    key: string,
    compute: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const existing = flights.get(key);
      if (existing !== undefined) {
        return Deferred.await(existing).pipe(
          Effect.catchCauseIf(Cause.hasInterruptsOnly, () => singleFlight(flights, key, compute)),
        );
      }
      const deferred = Deferred.makeUnsafe<A, E>();
      flights.set(key, deferred);
      return compute.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (flights.get(key) === deferred) {
              flights.delete(key);
            }
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
      );
    });

  const canonicalizeCheckoutCached = (
    rawRoot: string,
    platform: NodeJS.Platform,
    nowMs: number,
  ): Effect.Effect<CanonicalCheckout> => {
    const cacheKey = `${platform}\0${rawRoot}`;
    const cached = canonicalCheckoutCache.get(cacheKey);
    if (cached !== undefined && nowMs < cached.expiresAtMs) {
      return Effect.succeed(cached.value);
    }
    return canonicalizeCheckoutPathRaw(fileSystem, path, rawRoot, platform).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          if (canonicalCheckoutCache.size >= MAX_CANONICAL_CHECKOUT_CACHE_ENTRIES) {
            canonicalCheckoutCache.clear();
          }
          canonicalCheckoutCache.set(cacheKey, {
            value,
            expiresAtMs: nowMs + CANONICAL_CHECKOUT_CACHE_TTL_MS,
          });
        }),
      ),
    );
  };

  const normalizeCheckoutPathCached = (
    checkoutPath: string,
    rawPath: string,
    platform: NodeJS.Platform,
    nowMs: number,
  ): Effect.Effect<NormalizedCheckoutPath | null> => {
    const cacheKey = `${checkoutPath}\0${platform}\0${rawPath}`;
    const cached = normalizedPathCache.get(cacheKey);
    if (cached !== undefined && nowMs < cached.expiresAtMs) {
      return Effect.succeed(cached.value);
    }
    return normalizeCheckoutRelativePathRaw(fileSystem, path, checkoutPath, rawPath, platform).pipe(
      Effect.orElseSucceed(() => null),
      Effect.tap((value) =>
        Effect.sync(() => {
          if (normalizedPathCache.size >= MAX_NORMALIZED_PATH_CACHE_ENTRIES) {
            normalizedPathCache.clear();
          }
          normalizedPathCache.set(cacheKey, {
            value,
            expiresAtMs: nowMs + NORMALIZED_PATH_CACHE_TTL_MS,
          });
        }),
      ),
    );
  };

  const getCachedGitLocalStatus = (
    checkoutKey: string,
    checkoutPath: string,
  ): Effect.Effect<GitLocalStatusResult | null> => {
    if (Option.isNone(gitWorkflowOption)) {
      return Effect.succeed(null);
    }
    const gitWorkflow = gitWorkflowOption.value;
    return Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = gitStatusCache.get(checkoutKey);
      if (cached !== undefined && nowMs < cached.expiresAtMs) {
        return cached.status;
      }
      return yield* singleFlight(
        inFlightGitStatus,
        checkoutKey,
        gitWorkflow.localStatus({ cwd: checkoutPath }).pipe(
          Effect.orElseSucceed(() => null),
          Effect.tap((status) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((completedAtMs) => {
                gitStatusCache.set(checkoutKey, {
                  status,
                  expiresAtMs: completedAtMs + GIT_LOCAL_STATUS_CACHE_TTL_MS,
                });
              }),
            ),
          ),
        ),
      );
    });
  };

  const notifyCoordinationChange = () => {
    bumpCoordinationVersion();
    const previous = coordinationChangeSignal;
    coordinationChangeSignal = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  };

  const notifyReservationChange = () => {
    const previous = reservationSignal;
    reservationSignal = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
    notifyCoordinationChange();
  };

  const notifyCheckoutLeaseChange = () => {
    const previous = checkoutLeaseSignal;
    checkoutLeaseSignal = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
    notifyCoordinationChange();
  };

  const watchCoordinationChange: SharedWorktreeCoordinationServiceShape["watchCoordinationChange"] =
    Effect.sync(() => {
      const signal = coordinationChangeSignal;
      return Deferred.await(signal);
    });

  const nowIso = (): Effect.Effect<IsoDateTime> =>
    DateTime.now.pipe(Effect.map((now) => IsoDateTime.make(DateTime.formatIso(now))));

  const resolveThreadCheckout = Effect.fn(
    "SharedWorktreeCoordinationService.resolveThreadCheckout",
  )(function* (threadId: ThreadId) {
    const records = yield* projections.getThreadRecords(threadId, []).pipe(
      Effect.mapError(
        (cause) =>
          new SharedWorktreeCoordinationError({
            reason: "thread_not_found",
            detail: `Thread '${threadId}' was not found.`,
            cause,
          }),
      ),
    );
    if (records.thread.deletedAt !== null) {
      return yield* new SharedWorktreeCoordinationError({
        reason: "thread_not_found",
        detail: `Thread '${threadId}' was deleted.`,
      });
    }
    let rawCheckout = records.thread.worktreePath;
    if (rawCheckout === null) {
      const projectOpt = yield* projects
        .get(records.thread.projectId, { includeDeleted: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SharedWorktreeCoordinationError({
                reason: "project_not_found",
                detail: `Project '${records.thread.projectId}' could not be loaded.`,
                cause,
              }),
          ),
        );
      if (Option.isNone(projectOpt)) {
        return yield* new SharedWorktreeCoordinationError({
          reason: "project_not_found",
          detail: `Project '${records.thread.projectId}' was not found.`,
        });
      }
      rawCheckout = projectOpt.value.workspaceRoot;
    }
    const platform = yield* HostProcess.Platform;
    const nowMs = yield* Clock.currentTimeMillis;
    const checkout = yield* canonicalizeCheckoutCached(rawCheckout, platform, nowMs);
    return {
      thread: records.thread,
      checkout,
    };
  });

  const readPolicyRow = Effect.fn("SharedWorktreeCoordinationService.readPolicyRow")(function* (
    checkoutKey: string,
    checkoutPath: string,
  ) {
    const rows = yield* sql<CheckoutPolicyRow>`
      SELECT checkout_key, checkout_path, serialization_mode, updated_at, updated_by
      FROM shared_worktree_checkout_policies
      WHERE checkout_key = ${checkoutKey}
      LIMIT 1
    `.pipe(
      Effect.mapError(
        (cause) =>
          new SharedWorktreeCoordinationError({
            reason: "persistence_failed",
            detail: "Failed to read shared worktree checkout policy.",
            cause,
          }),
      ),
    );
    const row = rows[0];
    const mode = row === undefined ? "parallel" : toSerializationMode(row.serialization_mode);
    const updatedAt = row === undefined ? yield* nowIso() : IsoDateTime.make(row.updated_at);
    return {
      checkoutKey,
      checkoutPath: row?.checkout_path ?? checkoutPath,
      serializationMode: mode,
      shellConstraintCoverage: buildShellConstraintCoverage(mode),
      updatedAt,
      updatedBy: row === undefined ? null : toActorOrNull(row.updated_by),
    } satisfies SharedWorktreeCheckoutPolicy;
  });

  const readFileRevision = Effect.fn("SharedWorktreeCoordinationService.readFileRevision")(
    function* (entry: NormalizedCheckoutPath) {
      const statOpt = yield* Effect.option(fileSystem.stat(entry.absolutePath));
      if (Option.isNone(statOpt) || statOpt.value.type !== "File") {
        return {
          path: entry.rawPath,
          normalizedPath: entry.normalizedPath,
          exists: false,
          sha256: null,
          byteLength: 0,
          contents: null,
          truncated: false,
        } satisfies SharedWorktreeFileRevision;
      }

      const bytes = yield* fileSystem.readFile(entry.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new SharedWorktreeCoordinationError({
              reason: "write_failed",
              detail: `Failed to read latest contents of '${entry.normalizedPath}'.`,
              cause,
            }),
        ),
      );
      const digest = yield* Effect.promise(() => sha256Hex(bytes));
      const truncated = bytes.byteLength > MAX_REVISION_PREVIEW_BYTES;
      const slice = truncated ? bytes.subarray(0, MAX_REVISION_PREVIEW_BYTES) : bytes;
      const isBinary = slice.includes(0);
      const contents = isBinary ? null : decodeUtf8OrNull(slice, truncated);
      return {
        path: entry.rawPath,
        normalizedPath: entry.normalizedPath,
        exists: true,
        sha256: digest,
        byteLength: bytes.byteLength,
        contents,
        truncated,
      } satisfies SharedWorktreeFileRevision;
    },
  );

  const normalizeReservationInputs = Effect.fn(
    "SharedWorktreeCoordinationService.normalizeReservationInputs",
  )(function* (
    checkoutPath: string,
    paths: ReadonlyArray<string>,
    renamePairs?: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  ) {
    const byKey = new Map<string, NormalizedCheckoutPath>();
    const renameKeys = new Set<string>();

    for (const raw of paths) {
      const normalized = yield* normalizeCheckoutRelativePath(fileSystem, path, checkoutPath, raw);
      if (!byKey.has(normalized.canonicalKey)) {
        byKey.set(normalized.canonicalKey, normalized);
      }
    }
    for (const pair of renamePairs ?? []) {
      const fromNorm = yield* normalizeCheckoutRelativePath(
        fileSystem,
        path,
        checkoutPath,
        pair.from,
      );
      const toNorm = yield* normalizeCheckoutRelativePath(fileSystem, path, checkoutPath, pair.to);
      if (!byKey.has(fromNorm.canonicalKey)) byKey.set(fromNorm.canonicalKey, fromNorm);
      if (!byKey.has(toNorm.canonicalKey)) byKey.set(toNorm.canonicalKey, toNorm);
      renameKeys.add(fromNorm.canonicalKey);
      renameKeys.add(toNorm.canonicalKey);
    }

    const entries = [...byKey.values()];
    if (entries.length === 0) {
      return yield* new SharedWorktreeCoordinationError({
        reason: "invalid_path",
        detail: "At least one workspace path is required.",
      });
    }
    return { entries, renameKeys };
  });

  const loadThreadTurnItemFileChanges = Effect.fn(
    "SharedWorktreeCoordinationService.loadThreadTurnItemFileChanges",
  )(function* (
    threadId: ThreadId,
    checkoutPath: string,
    platform: NodeJS.Platform,
    nowMs: number,
  ): Effect.fn.Return<ReadonlyArray<CachedTurnItemFileChange>> {
    const turnItemRecords = yield* projections
      .getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["file_change"] })
      .pipe(Effect.orElseSucceed(() => ({ thread: null, turnItems: [] })));

    const entries: Array<CachedTurnItemFileChange> = [];
    for (const item of turnItemRecords.turnItems) {
      if (item.type !== "file_change") continue;
      if (item.status === "failed" || item.status === "cancelled") continue;
      const updatedAt = IsoDateTime.make(DateTime.formatIso(item.updatedAt));
      const turnItemId = TurnItemId.make(item.id);
      if (item.changes && item.changes.length > 0) {
        for (const detail of item.changes) {
          const normalized = yield* normalizeCheckoutPathCached(
            checkoutPath,
            detail.path,
            platform,
            nowMs,
          );
          if (normalized === null) continue;
          const oldRawPath = detail.oldPath ?? null;
          const oldNormalized =
            oldRawPath === null
              ? null
              : yield* normalizeCheckoutPathCached(checkoutPath, oldRawPath, platform, nowMs);
          entries.push({
            rawPath: detail.path,
            normalizedPath: normalized.normalizedPath,
            canonicalKey: normalized.canonicalKey,
            oldRawPath,
            oldNormalizedPath: oldNormalized?.normalizedPath ?? null,
            oldCanonicalKey: oldNormalized?.canonicalKey ?? null,
            operation: detail.operation,
            runId: item.runId,
            turnItemId,
            updatedAt,
          });
        }
      } else {
        const normalized = yield* normalizeCheckoutPathCached(
          checkoutPath,
          item.fileName,
          platform,
          nowMs,
        );
        if (normalized === null) continue;
        entries.push({
          rawPath: item.fileName,
          normalizedPath: normalized.normalizedPath,
          canonicalKey: normalized.canonicalKey,
          oldRawPath: null,
          oldNormalizedPath: null,
          oldCanonicalKey: null,
          operation: "edit",
          runId: item.runId,
          turnItemId,
          updatedAt,
        });
      }
    }
    return entries;
  });

  const computeCheckoutSnapshotBase = Effect.fn(
    "SharedWorktreeCoordinationService.computeCheckoutSnapshotBase",
  )(function* (input: {
    readonly checkout: CanonicalCheckout;
    readonly targetThreadId: ThreadId;
    readonly shell: Awaited<Effect.Success<ReturnType<typeof projections.getShellSnapshot>>>;
    readonly platform: NodeJS.Platform;
    readonly versionAtStart: number;
  }): Effect.fn.Return<CheckoutSnapshotBase, SharedWorktreeCoordinationError> {
    const { checkout, shell, platform, versionAtStart } = input;
    const nowMs = yield* Clock.currentTimeMillis;
    const policy = yield* readPolicyRow(checkout.checkoutKey, checkout.checkoutPath);

    const activeThreads = shell.threads.filter(
      (candidate) => candidate.deletedAt === null && candidate.archivedAt === null,
    );
    const byId = new Map(activeThreads.map((candidate) => [candidate.id, candidate]));

    // Evict deleted/archived threads from the per-thread file_change cache.
    for (const cachedThreadId of threadFileChangeCache.keys()) {
      if (!byId.has(cachedThreadId)) {
        threadFileChangeCache.delete(cachedThreadId);
      }
    }

    const projectRootCache = new Map<string, string | null>();
    const rawRootCheckoutCache = new Map<string, CanonicalCheckout>();

    const sharedThreads: Array<OrchestrationV2ThreadShell> = [];
    for (const candidate of activeThreads) {
      let rawRoot = candidate.worktreePath;
      if (rawRoot === null) {
        const cachedProjectRoot = projectRootCache.get(candidate.projectId);
        if (cachedProjectRoot !== undefined) {
          rawRoot = cachedProjectRoot;
        } else {
          const proj = yield* projects
            .get(candidate.projectId, { includeDeleted: true })
            .pipe(Effect.orElseSucceed(() => Option.none()));
          rawRoot = Option.isSome(proj) ? proj.value.workspaceRoot : null;
          projectRootCache.set(candidate.projectId, rawRoot);
        }
      }
      if (rawRoot === null) continue;
      let candidateCheckout = rawRootCheckoutCache.get(rawRoot);
      if (candidateCheckout === undefined) {
        candidateCheckout = yield* canonicalizeCheckoutCached(rawRoot, platform, nowMs);
        rawRootCheckoutCache.set(rawRoot, candidateCheckout);
      }
      if (candidateCheckout.checkoutKey === checkout.checkoutKey) {
        sharedThreads.push(candidate);
      }
    }
    if (!sharedThreads.some((candidate) => candidate.id === input.targetThreadId)) {
      const targetShell = byId.get(input.targetThreadId);
      if (targetShell) sharedThreads.push(targetShell);
    }

    const sharedThreadIds = sharedThreads.map((candidate) => candidate.id);
    const encodedSharedThreadIds =
      sharedThreadIds.length === 0 ? null : encodeStringArrayJson(sharedThreadIds);

    const plannedRows =
      encodedSharedThreadIds === null
        ? []
        : yield* sql<PlannedPathRow>`
              SELECT thread_id, normalized_path, raw_path, run_id, note, declared_at
              FROM shared_worktree_planned_paths
              WHERE thread_id IN (SELECT value FROM json_each(${encodedSharedThreadIds}))
              ORDER BY declared_at ASC, normalized_path ASC
            `.pipe(
            Effect.mapError(
              (cause) =>
                new SharedWorktreeCoordinationError({
                  reason: "persistence_failed",
                  detail: "Failed to load planned paths.",
                  cause,
                }),
            ),
          );

    const controlledWriteRows = yield* sql<ControlledWriteRow>`
        SELECT
          write_id,
          checkout_key,
          thread_id,
          run_id,
          normalized_path,
          raw_path,
          old_normalized_path,
          old_raw_path,
          operation,
          updated_at
        FROM shared_worktree_controlled_writes
        WHERE checkout_key = ${checkout.checkoutKey}
        ORDER BY updated_at ASC, write_id ASC
      `.pipe(
      Effect.mapError(
        (cause) =>
          new SharedWorktreeCoordinationError({
            reason: "persistence_failed",
            detail: "Failed to load controlled write attribution.",
            cause,
          }),
      ),
    );

    // Single batched summary query to skip loading & decoding unchanged threads' file_change rows.
    const fileChangeSummaryRows =
      encodedSharedThreadIds === null
        ? []
        : yield* sql<TurnItemFileChangeSummaryRow>`
              SELECT
                thread_id,
                COUNT(*) AS item_count,
                MAX(updated_at) AS max_updated_at,
                SUM(LENGTH(payload_json)) AS total_payload_bytes,
                MAX(ordinal) AS max_ordinal
              FROM orchestration_v2_projection_turn_items
              WHERE type = 'file_change'
                AND status NOT IN ('failed', 'cancelled')
                AND thread_id IN (SELECT value FROM json_each(${encodedSharedThreadIds}))
              GROUP BY thread_id
            `.pipe(Effect.orElseSucceed(() => null));

    const fileChangeSummaryByThread =
      fileChangeSummaryRows === null
        ? null
        : new Map(fileChangeSummaryRows.map((row) => [ThreadId.make(row.thread_id), row] as const));

    const plannedByThread = new Map<ThreadId, Array<SharedWorktreePlannedPathEntry>>();
    for (const row of plannedRows) {
      const tid = ThreadId.make(row.thread_id);
      let list = plannedByThread.get(tid);
      if (!list) {
        list = [];
        plannedByThread.set(tid, list);
      }
      list.push({
        path: row.raw_path,
        normalizedPath: row.normalized_path,
        runId: row.run_id === null ? null : RunId.make(row.run_id),
        note: row.note,
        declaredAt: IsoDateTime.make(row.declared_at),
      });
    }

    const controlledWritesByThread = new Map<ThreadId, Array<SharedWorktreeConfirmedWriteEntry>>();
    for (const row of controlledWriteRows) {
      const tid = ThreadId.make(row.thread_id);
      let list = controlledWritesByThread.get(tid);
      if (!list) {
        list = [];
        controlledWritesByThread.set(tid, list);
      }
      list.push({
        path: row.raw_path,
        normalizedPath: row.normalized_path,
        oldPath: row.old_raw_path,
        oldNormalizedPath: row.old_normalized_path,
        operation: row.operation,
        runId: row.run_id === null ? null : RunId.make(row.run_id),
        turnItemId: null,
        source: "controlled_write",
        updatedAt: IsoDateTime.make(row.updated_at),
      });
    }

    // Index active & waiting reservations for this checkout by thread once instead of scanning per thread.
    const activeReservationsByThread = new Map<ThreadId, Array<InternalReservation>>();
    const checkoutActiveReservations: Array<SharedWorktreeWriteReservation> = [];
    for (const reservation of activeReservations.values()) {
      if (reservation.checkoutKey !== checkout.checkoutKey) continue;
      checkoutActiveReservations.push(toPublicReservation(reservation));
      let list = activeReservationsByThread.get(reservation.threadId);
      if (!list) {
        list = [];
        activeReservationsByThread.set(reservation.threadId, list);
      }
      list.push(reservation);
    }

    const waitingReservationsByThread = new Map<ThreadId, Array<InternalWaitingReservation>>();
    const checkoutWaitingReservations: Array<SharedWorktreeWriteReservation> = [];
    for (const waiting of waitingReservations) {
      if (waiting.checkoutKey !== checkout.checkoutKey) continue;
      checkoutWaitingReservations.push(toPublicWaitingReservation(waiting));
      let list = waitingReservationsByThread.get(waiting.threadId);
      if (!list) {
        list = [];
        waitingReservationsByThread.set(waiting.threadId, list);
      }
      list.push(waiting);
    }

    const confirmedCanonicalKeys = new Set<string>();
    const overlapEntries: Array<OverlapInputEntry> = [];
    const threadBases: Array<CheckoutThreadAttributionBase> = [];

    for (const candidate of sharedThreads) {
      const planned = plannedByThread.get(candidate.id) ?? [];
      for (const item of planned) {
        const normalized = yield* normalizeCheckoutPathCached(
          checkout.checkoutPath,
          item.normalizedPath,
          platform,
          nowMs,
        );
        if (normalized !== null) {
          overlapEntries.push({
            threadId: candidate.id,
            threadTitle: candidate.title,
            runId: item.runId,
            layer: "planned",
            rawPath: item.path,
            normalizedPath: normalized.normalizedPath,
            canonicalKey: normalized.canonicalKey,
          });
        }
      }

      const confirmedWrites: Array<SharedWorktreeConfirmedWriteEntry> = [];
      const seenConfirmed = new Set<string>();

      const recordConfirmedWrite = (entry: {
        readonly rawPath: string;
        readonly normalizedPath: string;
        readonly canonicalKey: string;
        readonly oldRawPath: string | null;
        readonly oldNormalizedPath: string | null;
        readonly oldCanonicalKey: string | null;
        readonly operation: string;
        readonly runId: RunId | null;
        readonly turnItemId: TurnItemId | null;
        readonly source: "turn_item" | "controlled_write";
        readonly updatedAt: IsoDateTime;
      }) => {
        confirmedCanonicalKeys.add(entry.canonicalKey);
        if (entry.oldCanonicalKey !== null) {
          confirmedCanonicalKeys.add(entry.oldCanonicalKey);
        }

        const dedupeKey = `${entry.canonicalKey}\0${entry.oldCanonicalKey ?? ""}\0${entry.runId ?? ""}\0${entry.source}`;
        if (seenConfirmed.has(dedupeKey)) {
          return;
        }
        seenConfirmed.add(dedupeKey);

        confirmedWrites.push({
          path: entry.rawPath,
          normalizedPath: entry.normalizedPath,
          oldPath: entry.oldRawPath,
          oldNormalizedPath: entry.oldNormalizedPath,
          operation: entry.operation,
          runId: entry.runId,
          turnItemId: entry.turnItemId,
          source: entry.source,
          updatedAt: entry.updatedAt,
        });

        const isRename = entry.oldCanonicalKey !== null && entry.oldNormalizedPath !== null;
        overlapEntries.push({
          threadId: candidate.id,
          threadTitle: candidate.title,
          runId: entry.runId,
          layer: "confirmed_write",
          rawPath: entry.rawPath,
          normalizedPath: entry.normalizedPath,
          canonicalKey: entry.canonicalKey,
          ...(isRename ? { isRenameEndpoint: true } : {}),
        });
        if (isRename) {
          overlapEntries.push({
            threadId: candidate.id,
            threadTitle: candidate.title,
            runId: entry.runId,
            layer: "confirmed_write",
            rawPath: entry.oldRawPath!,
            normalizedPath: entry.oldNormalizedPath!,
            canonicalKey: entry.oldCanonicalKey!,
            isRenameEndpoint: true,
          });
        }
      };

      // Layer 2a: Confirmed tool writes from durable file_change turn items (fingerprint-cached).
      let turnItemFileChanges: ReadonlyArray<CachedTurnItemFileChange>;
      if (fileChangeSummaryByThread !== null) {
        const summary = fileChangeSummaryByThread.get(candidate.id);
        if (summary === undefined) {
          threadFileChangeCache.delete(candidate.id);
          turnItemFileChanges = [];
        } else {
          const fingerprint = `${checkout.checkoutKey}\0${summary.item_count}\0${summary.max_updated_at ?? ""}\0${summary.total_payload_bytes ?? 0}\0${summary.max_ordinal ?? 0}`;
          const cached = threadFileChangeCache.get(candidate.id);
          if (cached !== undefined && cached.fingerprint === fingerprint) {
            turnItemFileChanges = cached.entries;
          } else {
            turnItemFileChanges = yield* loadThreadTurnItemFileChanges(
              candidate.id,
              checkout.checkoutPath,
              platform,
              nowMs,
            );
            threadFileChangeCache.set(candidate.id, {
              fingerprint,
              entries: turnItemFileChanges,
            });
          }
        }
      } else {
        turnItemFileChanges = yield* loadThreadTurnItemFileChanges(
          candidate.id,
          checkout.checkoutPath,
          platform,
          nowMs,
        );
      }

      for (const entry of turnItemFileChanges) {
        recordConfirmedWrite({
          ...entry,
          source: "turn_item",
        });
      }

      // Layer 2b: Server-controlled write tool commits.
      for (const controlled of controlledWritesByThread.get(candidate.id) ?? []) {
        const normalized = yield* normalizeCheckoutPathCached(
          checkout.checkoutPath,
          controlled.path,
          platform,
          nowMs,
        );
        if (normalized === null) continue;
        const oldNormalized =
          controlled.oldPath === null
            ? null
            : yield* normalizeCheckoutPathCached(
                checkout.checkoutPath,
                controlled.oldPath,
                platform,
                nowMs,
              );
        recordConfirmedWrite({
          rawPath: controlled.path,
          normalizedPath: normalized.normalizedPath,
          canonicalKey: normalized.canonicalKey,
          oldRawPath: controlled.oldPath,
          oldNormalizedPath: oldNormalized?.normalizedPath ?? null,
          oldCanonicalKey: oldNormalized?.canonicalKey ?? null,
          operation: controlled.operation,
          runId: controlled.runId,
          turnItemId: null,
          source: "controlled_write",
          updatedAt: controlled.updatedAt,
        });
      }

      const threadActiveReservations = (activeReservationsByThread.get(candidate.id) ?? []).map(
        (reservation) => {
          for (const entry of reservation.entries) {
            overlapEntries.push({
              threadId: candidate.id,
              threadTitle: candidate.title,
              runId: reservation.runId,
              layer: "reserved",
              rawPath: entry.rawPath,
              normalizedPath: entry.normalizedPath,
              canonicalKey: entry.canonicalKey,
              ...(reservation.renameKeys.has(entry.canonicalKey) ? { isRenameEndpoint: true } : {}),
            });
          }
          return toPublicReservation(reservation);
        },
      );

      for (const waiting of waitingReservationsByThread.get(candidate.id) ?? []) {
        for (const entry of waiting.entries) {
          overlapEntries.push({
            threadId: candidate.id,
            threadTitle: candidate.title,
            runId: waiting.runId,
            layer: "reserved",
            rawPath: entry.rawPath,
            normalizedPath: entry.normalizedPath,
            canonicalKey: entry.canonicalKey,
            ...(waiting.renameKeys.has(entry.canonicalKey) ? { isRenameEndpoint: true } : {}),
          });
        }
      }

      threadBases.push({
        threadId: candidate.id,
        title: candidate.title,
        depth: computeThreadDepth(candidate, byId),
        activeRunId: candidate.activeRunId,
        status: candidate.status,
        rootThreadId: candidate.lineage.rootThreadId ?? candidate.id,
        plannedPaths: planned,
        confirmedWritePaths: confirmedWrites,
        activeReservations: threadActiveReservations,
      });
    }

    // Layer 3: Working-tree dirty files NOT confirmed written by any thread in this checkout.
    const observedUnverifiedPaths: Array<SharedWorktreeObservedPath> = [];
    const localStatus = yield* getCachedGitLocalStatus(checkout.checkoutKey, checkout.checkoutPath);
    if (localStatus !== null && localStatus.isRepo) {
      const seenObserved = new Set<string>();
      for (const file of localStatus.workingTree.files) {
        const normalized = yield* normalizeCheckoutPathCached(
          checkout.checkoutPath,
          file.path,
          platform,
          nowMs,
        );
        if (normalized === null) continue;
        if (confirmedCanonicalKeys.has(normalized.canonicalKey)) continue;
        if (seenObserved.has(normalized.canonicalKey)) continue;
        seenObserved.add(normalized.canonicalKey);
        observedUnverifiedPaths.push({
          path: file.path,
          normalizedPath: normalized.normalizedPath,
          attribution: "observed_unverified",
          reason: "external_or_unattributed",
          insertions: file.insertions,
          deletions: file.deletions,
        });
      }
    }

    const activeLease = activeCheckoutLeases.get(checkout.checkoutKey);
    const activeSerializedRun: SharedWorktreeSerializedRunEntry | null =
      activeLease === undefined
        ? null
        : {
            threadId: activeLease.threadId,
            runId: activeLease.runId,
            enqueuedAt: activeLease.enqueuedAt,
            acquiredAt: activeLease.acquiredAt,
          };
    const waitingSerializedRuns: Array<SharedWorktreeSerializedRunEntry> = (
      waitingCheckoutLeases.get(checkout.checkoutKey) ?? []
    ).map((entry) => ({
      threadId: entry.threadId,
      runId: entry.runId,
      enqueuedAt: entry.enqueuedAt,
      acquiredAt: entry.acquiredAt,
    }));

    observedUnverifiedPaths.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));

    const base: CheckoutSnapshotBase = {
      checkoutPath: checkout.checkoutPath,
      checkoutKey: checkout.checkoutKey,
      policy,
      threadBases,
      overlaps: computePathOverlaps(overlapEntries),
      observedUnverifiedPaths,
      activeReservations: checkoutActiveReservations,
      waitingReservations: checkoutWaitingReservations,
      activeSerializedRun,
      waitingSerializedRuns,
      generatedAt: yield* nowIso(),
    };

    const completedAtMs = yield* Clock.currentTimeMillis;
    if (coordinationVersion === versionAtStart) {
      checkoutSnapshotBaseCache.set(checkout.checkoutKey, {
        shellSequence: shell.snapshotSequence,
        coordinationVersion: versionAtStart,
        expiresAtMs: completedAtMs + CHECKOUT_SNAPSHOT_CACHE_TTL_MS,
        base,
      });
    }
    return base;
  });

  const projectSnapshotForCaller = (
    base: CheckoutSnapshotBase,
    rootThreadId: ThreadId,
    isWorkspaceRootThread: boolean,
  ): SharedWorktreeCoordinationSnapshot => {
    const threadAttributions: Array<SharedWorktreeThreadAttribution> = base.threadBases.map(
      ({ rootThreadId: candidateRoot, ...rest }) => ({
        ...rest,
        inFamily: candidateRoot === rootThreadId,
      }),
    );
    threadAttributions.sort(
      (a, b) =>
        (a.inFamily === b.inFamily ? 0 : a.inFamily ? -1 : 1) ||
        a.depth - b.depth ||
        a.threadId.localeCompare(b.threadId),
    );
    return {
      rootThreadId,
      checkoutPath: base.checkoutPath,
      checkoutKey: base.checkoutKey,
      policy: base.policy,
      sharedThreadCount: threadAttributions.length,
      threads: threadAttributions,
      overlaps: base.overlaps,
      observedUnverifiedPaths: base.observedUnverifiedPaths,
      activeReservations: base.activeReservations,
      waitingReservations: base.waitingReservations,
      activeSerializedRun: base.activeSerializedRun,
      waitingSerializedRuns: base.waitingSerializedRuns,
      restoreSafetyProtected: threadAttributions.length > 1 || isWorkspaceRootThread,
      generatedAt: base.generatedAt,
    };
  };

  const getSnapshot: SharedWorktreeCoordinationServiceShape["getSnapshot"] = Effect.fn(
    "SharedWorktreeCoordinationService.getSnapshot",
  )(function* (threadId) {
    const { thread, checkout } = yield* resolveThreadCheckout(threadId);
    const rootThreadId = thread.lineage.rootThreadId ?? thread.id;
    const platform = yield* HostProcess.Platform;

    const shell = yield* projections.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new SharedWorktreeCoordinationError({
            reason: "persistence_failed",
            detail: "Failed to read thread shell snapshot.",
            cause,
          }),
      ),
    );

    const nowMs = yield* Clock.currentTimeMillis;
    const versionAtStart = coordinationVersion;
    const cached = checkoutSnapshotBaseCache.get(checkout.checkoutKey);
    const base =
      cached !== undefined &&
      cached.shellSequence === shell.snapshotSequence &&
      cached.coordinationVersion === versionAtStart &&
      nowMs < cached.expiresAtMs
        ? cached.base
        : yield* singleFlight(
            inFlightCheckoutBase,
            `${checkout.checkoutKey}:${shell.snapshotSequence}:${versionAtStart}`,
            computeCheckoutSnapshotBase({
              checkout,
              targetThreadId: thread.id,
              shell,
              platform,
              versionAtStart,
            }),
          );

    return projectSnapshotForCaller(base, rootThreadId, thread.worktreePath === null);
  });

  const setPolicy: SharedWorktreeCoordinationServiceShape["setPolicy"] = Effect.fn(
    "SharedWorktreeCoordinationService.setPolicy",
  )(function* (input) {
    const { checkout } = yield* resolveThreadCheckout(input.threadId);
    const updatedAt = yield* nowIso();
    const updatedBy = input.updatedBy ?? "user";
    yield* sql`
      INSERT INTO shared_worktree_checkout_policies (
        checkout_key,
        checkout_path,
        serialization_mode,
        updated_at,
        updated_by
      ) VALUES (
        ${checkout.checkoutKey},
        ${checkout.checkoutPath},
        ${input.serializationMode},
        ${updatedAt},
        ${updatedBy}
      )
      ON CONFLICT (checkout_key) DO UPDATE SET
        checkout_path = excluded.checkout_path,
        serialization_mode = excluded.serialization_mode,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `.pipe(
      Effect.mapError(
        (cause) =>
          new SharedWorktreeCoordinationError({
            reason: "persistence_failed",
            detail: "Failed to persist shared worktree checkout policy.",
            cause,
          }),
      ),
    );
    bumpCoordinationVersion(checkout.checkoutKey);
    return {
      checkoutKey: checkout.checkoutKey,
      checkoutPath: checkout.checkoutPath,
      serializationMode: input.serializationMode,
      shellConstraintCoverage: buildShellConstraintCoverage(input.serializationMode),
      updatedAt,
      updatedBy,
    } satisfies SharedWorktreeCheckoutPolicy;
  });

  const setPlannedPaths: SharedWorktreeCoordinationServiceShape["setPlannedPaths"] = Effect.fn(
    "SharedWorktreeCoordinationService.setPlannedPaths",
  )(function* (input) {
    const { checkout } = yield* resolveThreadCheckout(input.threadId);
    const normalizedEntries: Array<NormalizedCheckoutPath> = [];
    const seen = new Set<string>();
    for (const rawPath of input.paths) {
      const normalized = yield* normalizeCheckoutRelativePath(
        fileSystem,
        path,
        checkout.checkoutPath,
        rawPath,
      );
      if (!seen.has(normalized.canonicalKey)) {
        seen.add(normalized.canonicalKey);
        normalizedEntries.push(normalized);
      }
    }

    const declaredAt = yield* nowIso();
    const runId = input.runId ?? null;
    const note = input.note ?? null;

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM shared_worktree_planned_paths
            WHERE thread_id = ${input.threadId}
          `;
          for (const entry of normalizedEntries) {
            yield* sql`
              INSERT INTO shared_worktree_planned_paths (
                thread_id,
                normalized_path,
                raw_path,
                run_id,
                note,
                declared_at
              ) VALUES (
                ${input.threadId},
                ${entry.normalizedPath},
                ${entry.rawPath},
                ${runId},
                ${note},
                ${declaredAt}
              )
            `;
          }
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SharedWorktreeCoordinationError({
              reason: "persistence_failed",
              detail: "Failed to persist planned modification paths.",
              cause,
            }),
        ),
      );

    bumpCoordinationVersion(checkout.checkoutKey);

    const plannedPaths: Array<SharedWorktreePlannedPathEntry> = normalizedEntries.map((entry) => ({
      path: entry.rawPath,
      normalizedPath: entry.normalizedPath,
      runId,
      note,
      declaredAt,
    }));

    const snapshot = yield* getSnapshot(input.threadId);
    return {
      threadId: input.threadId,
      plannedPaths,
      overlaps: snapshot.overlaps,
    };
  });

  const findConflictingActive = (
    checkoutKey: string,
    holder: { readonly threadId: ThreadId; readonly runId: RunId | null },
    entries: ReadonlyArray<NormalizedCheckoutPath>,
  ): ReadonlyArray<InternalReservation> => {
    const conflicts: Array<InternalReservation> = [];
    for (const existing of activeReservations.values()) {
      if (existing.checkoutKey !== checkoutKey) continue;
      if (sameHolder(existing, holder)) continue;
      if (entriesConflict(existing.entries, entries)) {
        conflicts.push(existing);
      }
    }
    return conflicts;
  };

  const hasEarlierConflictingWaiter = (waiting: InternalWaitingReservation): boolean => {
    for (const other of waitingReservations) {
      if (other === waiting) break;
      if (other.checkoutKey !== waiting.checkoutKey) continue;
      if (sameHolder(other, waiting)) continue;
      if (entriesConflict(other.entries, waiting.entries)) {
        return true;
      }
    }
    return false;
  };

  const acquireWriteReservation: SharedWorktreeCoordinationServiceShape["acquireWriteReservation"] =
    Effect.fn("SharedWorktreeCoordinationService.acquireWriteReservation")(function* (input) {
      const { checkout } = yield* resolveThreadCheckout(input.threadId);
      const { entries, renameKeys } = yield* normalizeReservationInputs(
        checkout.checkoutPath,
        input.paths,
        input.renamePairs,
      );
      const runId = input.runId ?? null;
      const holder = { threadId: input.threadId, runId };
      const reservationId = SharedWorktreeReservationId.make(yield* nextGeneratedId("res"));
      const enqueuedAt = yield* nowIso();

      let waited = false;
      const priorWritersByKey = new Map<
        string,
        { readonly threadId: ThreadId; readonly runId: RunId | null }
      >();
      let waitingEntry: InternalWaitingReservation | null = null;

      const removeWaitingEntry = () => {
        if (waitingEntry === null) return;
        const idx = waitingReservations.indexOf(waitingEntry);
        if (idx >= 0) {
          waitingReservations.splice(idx, 1);
          notifyReservationChange();
        }
        waitingEntry = null;
      };

      const acquired = yield* Effect.gen(function* () {
        for (;;) {
          const conflicting = findConflictingActive(checkout.checkoutKey, holder, entries);
          const blockedByQueue = waitingEntry !== null && hasEarlierConflictingWaiter(waitingEntry);
          if (conflicting.length === 0 && !blockedByQueue) {
            removeWaitingEntry();
            const acquiredAt = yield* nowIso();
            const reservation: InternalReservation = {
              reservationId,
              checkoutKey: checkout.checkoutKey,
              threadId: input.threadId,
              runId,
              entries,
              renameKeys,
              acquiredAt,
            };
            activeReservations.set(reservationId, reservation);
            bumpCoordinationVersion(checkout.checkoutKey);
            return reservation;
          }

          waited = true;
          for (const conflict of conflicting) {
            priorWritersByKey.set(`${conflict.threadId}:${conflict.runId ?? ""}`, {
              threadId: conflict.threadId,
              runId: conflict.runId,
            });
          }

          const signal = reservationSignal;
          if (waitingEntry === null) {
            waitingEntry = {
              reservationId,
              checkoutKey: checkout.checkoutKey,
              threadId: input.threadId,
              runId,
              entries,
              renameKeys,
              enqueuedAt,
              waitingOnReservationIds: conflicting.map((item) => item.reservationId),
            };
            waitingReservations.push(waitingEntry);
            notifyCoordinationChange();
          } else {
            waitingEntry.waitingOnReservationIds = conflicting.map((item) => item.reservationId);
          }

          yield* Deferred.await(signal);
        }
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            removeWaitingEntry();
          }),
        ),
      );

      // Re-read latest file contents AFTER acquiring the reservation (post-prior-writer release).
      const latestFiles = yield* Effect.forEach(entries, readFileRevision);
      return {
        reservation: toPublicReservation(acquired),
        waited,
        priorWriters: [...priorWritersByKey.values()],
        latestFiles,
      } satisfies AcquireWriteReservationResult;
    });

  const releaseWriteReservation: SharedWorktreeCoordinationServiceShape["releaseWriteReservation"] =
    Effect.fn("SharedWorktreeCoordinationService.releaseWriteReservation")(function* (input) {
      if (input.reservationId !== undefined) {
        const existing = activeReservations.get(input.reservationId);
        if (existing === undefined) {
          return yield* new SharedWorktreeCoordinationError({
            reason: "reservation_not_found",
            detail: `Write reservation '${input.reservationId}' is not active.`,
          });
        }
        if (existing.threadId !== input.threadId) {
          return yield* new SharedWorktreeCoordinationError({
            reason: "reservation_owner_mismatch",
            detail: `Write reservation '${input.reservationId}' belongs to thread '${existing.threadId}'.`,
          });
        }
        activeReservations.delete(input.reservationId);
        notifyReservationChange();
        return 1;
      }

      let released = 0;
      for (const [id, existing] of activeReservations.entries()) {
        if (existing.threadId !== input.threadId) continue;
        if (
          input.runId !== undefined &&
          input.runId !== null &&
          existing.runId !== null &&
          existing.runId !== input.runId
        ) {
          continue;
        }
        activeReservations.delete(id);
        released += 1;
      }
      if (released > 0) {
        notifyReservationChange();
      }
      return released;
    });

  const controlledWriteFile: SharedWorktreeCoordinationServiceShape["controlledWriteFile"] =
    Effect.fn("SharedWorktreeCoordinationService.controlledWriteFile")(function* (input) {
      const { checkout } = yield* resolveThreadCheckout(input.threadId);
      const targetNorm = yield* normalizeCheckoutRelativePath(
        fileSystem,
        path,
        checkout.checkoutPath,
        input.path,
      );
      const renameFromNorm =
        input.renameFrom === undefined
          ? null
          : yield* normalizeCheckoutRelativePath(
              fileSystem,
              path,
              checkout.checkoutPath,
              input.renameFrom,
            );

      const acquired = yield* acquireWriteReservation({
        threadId: input.threadId,
        runId: input.runId ?? null,
        paths: renameFromNorm === null ? [input.path] : [],
        ...(renameFromNorm === null
          ? {}
          : { renamePairs: [{ from: input.renameFrom!, to: input.path }] }),
      });

      return yield* Effect.gen(function* () {
        const currentRevision = yield* readFileRevision(targetNorm);
        if (input.expectedSha256 !== undefined && currentRevision.sha256 !== input.expectedSha256) {
          return yield* new SharedWorktreeCoordinationError({
            reason: "stale_revision",
            detail: `File '${targetNorm.normalizedPath}' changed (expected ${input.expectedSha256}, current ${currentRevision.sha256 ?? "missing"}). Re-read before writing.`,
          });
        }

        const existedBefore = currentRevision.exists;
        yield* fileSystem
          .makeDirectory(path.dirname(targetNorm.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SharedWorktreeCoordinationError({
                  reason: "write_failed",
                  detail: `Failed to create parent directory for '${targetNorm.normalizedPath}'.`,
                  cause,
                }),
            ),
          );

        yield* fileSystem.writeFileString(targetNorm.absolutePath, input.contents).pipe(
          Effect.mapError(
            (cause) =>
              new SharedWorktreeCoordinationError({
                reason: "write_failed",
                detail: `Failed to write '${targetNorm.normalizedPath}'.`,
                cause,
              }),
          ),
        );

        if (renameFromNorm !== null && renameFromNorm.canonicalKey !== targetNorm.canonicalKey) {
          yield* fileSystem
            .remove(renameFromNorm.absolutePath, { force: true })
            .pipe(Effect.ignore);
        }

        const updatedAt = yield* nowIso();
        const operation = renameFromNorm !== null ? "rename" : existedBefore ? "update" : "create";
        const writeId = yield* nextGeneratedId("cw");
        yield* sql`
          INSERT INTO shared_worktree_controlled_writes (
            write_id,
            checkout_key,
            thread_id,
            run_id,
            normalized_path,
            raw_path,
            old_normalized_path,
            old_raw_path,
            operation,
            updated_at
          ) VALUES (
            ${writeId},
            ${checkout.checkoutKey},
            ${input.threadId},
            ${input.runId ?? null},
            ${targetNorm.normalizedPath},
            ${targetNorm.rawPath},
            ${renameFromNorm?.normalizedPath ?? null},
            ${renameFromNorm?.rawPath ?? null},
            ${operation},
            ${updatedAt}
          )
        `.pipe(
          Effect.mapError(
            (cause) =>
              new SharedWorktreeCoordinationError({
                reason: "persistence_failed",
                detail: "Failed to record controlled write attribution.",
                cause,
              }),
          ),
        );

        bumpCoordinationVersion(checkout.checkoutKey);
        gitStatusCache.delete(checkout.checkoutKey);
        invalidateCheckoutPathCache(checkout.checkoutPath);

        const writtenFile = yield* readFileRevision(targetNorm);
        return {
          writtenFile,
          waited: acquired.waited,
          priorWriters: acquired.priorWriters,
        } satisfies ControlledWriteFileResult;
      }).pipe(
        Effect.ensuring(
          releaseWriteReservation({
            threadId: input.threadId,
            reservationId: acquired.reservation.reservationId,
          }).pipe(Effect.ignore),
        ),
      );
    });

  const enqueueAndAcquireCheckoutLease = Effect.fn(
    "SharedWorktreeCoordinationService.enqueueAndAcquireCheckoutLease",
  )(function* (checkoutKey: string, threadId: ThreadId, runId: RunId, existingLeaseId?: string) {
    const enqueuedAt = yield* nowIso();
    const lease: InternalCheckoutTurnLease = {
      leaseId: existingLeaseId ?? (yield* nextGeneratedId("ctl")),
      checkoutKey,
      threadId,
      runId,
      enqueuedAt,
      acquiredAt: null,
    };

    const removeFromQueue = () => {
      const queue = waitingCheckoutLeases.get(checkoutKey);
      if (!queue) return;
      const idx = queue.indexOf(lease);
      if (idx >= 0) {
        queue.splice(idx, 1);
        if (queue.length === 0) waitingCheckoutLeases.delete(checkoutKey);
        notifyCheckoutLeaseChange();
      }
    };

    let queued = false;
    yield* Effect.gen(function* () {
      for (;;) {
        const current = activeCheckoutLeases.get(checkoutKey);
        const queue = waitingCheckoutLeases.get(checkoutKey);
        const isFront = queue === undefined || queue.length === 0 || queue[0] === lease;
        if (current === undefined && isFront) {
          removeFromQueue();
          lease.acquiredAt = yield* nowIso();
          activeCheckoutLeases.set(checkoutKey, lease);
          bumpCoordinationVersion(checkoutKey);
          return;
        }
        const signal = checkoutLeaseSignal;
        if (!queued) {
          queued = true;
          let targetQueue = waitingCheckoutLeases.get(checkoutKey);
          if (!targetQueue) {
            targetQueue = [];
            waitingCheckoutLeases.set(checkoutKey, targetQueue);
          }
          targetQueue.push(lease);
          notifyCoordinationChange();
        }
        yield* Deferred.await(signal);
      }
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          removeFromQueue();
        }),
      ),
    );

    let released = false;
    const release = Effect.sync(() => {
      if (released) return;
      released = true;
      const current = activeCheckoutLeases.get(checkoutKey);
      if (current?.leaseId === lease.leaseId) {
        activeCheckoutLeases.delete(checkoutKey);
        notifyCheckoutLeaseChange();
      }
    });
    return { lease, release };
  });

  const acquireCheckoutTurnLease: SharedWorktreeCoordinationServiceShape["acquireCheckoutTurnLease"] =
    Effect.fn("SharedWorktreeCoordinationService.acquireCheckoutTurnLease")(function* (input) {
      const checkout = yield* canonicalizeCheckoutPath(fileSystem, path, input.cwd);
      const policy = yield* readPolicyRow(checkout.checkoutKey, checkout.checkoutPath).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (policy === null || policy.serializationMode !== "serialize_checkout_writes") {
        return { serialized: false, release: Effect.void } satisfies CheckoutTurnLeaseHandle;
      }

      const existing = activeCheckoutLeases.get(checkout.checkoutKey);
      if (existing !== undefined && existing.threadId === input.threadId) {
        return { serialized: true, release: Effect.void } satisfies CheckoutTurnLeaseHandle;
      }

      const { release } = yield* enqueueAndAcquireCheckoutLease(
        checkout.checkoutKey,
        input.threadId,
        input.runId,
      );
      return { serialized: true, release } satisfies CheckoutTurnLeaseHandle;
    });

  const suspendCheckoutTurnLease: SharedWorktreeCoordinationServiceShape["suspendCheckoutTurnLease"] =
    Effect.fn("SharedWorktreeCoordinationService.suspendCheckoutTurnLease")(function* <A, E, R>(
      threadId: ThreadId,
      runId: RunId | null,
      effect: Effect.Effect<A, E, R>,
    ) {
      let heldLease: InternalCheckoutTurnLease | null = null;
      for (const lease of activeCheckoutLeases.values()) {
        if (lease.threadId === threadId && (runId === null || lease.runId === runId)) {
          heldLease = lease;
          break;
        }
      }
      if (heldLease === null) {
        return yield* effect;
      }
      const suspended = heldLease;
      activeCheckoutLeases.delete(suspended.checkoutKey);
      notifyCheckoutLeaseChange();
      return yield* effect.pipe(
        Effect.ensuring(
          enqueueAndAcquireCheckoutLease(
            suspended.checkoutKey,
            suspended.threadId,
            suspended.runId,
            suspended.leaseId,
          ).pipe(Effect.asVoid, Effect.ignore),
        ),
      );
    });

  const releaseRunReservations: SharedWorktreeCoordinationServiceShape["releaseRunReservations"] = (
    threadId,
    runId,
  ) =>
    Effect.sync(() => {
      let released = 0;
      for (const [id, existing] of activeReservations.entries()) {
        if (
          existing.threadId === threadId &&
          (existing.runId === null || existing.runId === runId)
        ) {
          activeReservations.delete(id);
          released += 1;
        }
      }
      if (released > 0) {
        notifyReservationChange();
      }
      for (const [checkoutKey, lease] of activeCheckoutLeases.entries()) {
        if (lease.threadId === threadId && lease.runId === runId) {
          activeCheckoutLeases.delete(checkoutKey);
          notifyCheckoutLeaseChange();
        }
      }
      return released;
    });

  const clearThreadState: SharedWorktreeCoordinationServiceShape["clearThreadState"] = Effect.fn(
    "SharedWorktreeCoordinationService.clearThreadState",
  )(function* (threadIds) {
    if (threadIds.length === 0) return;
    const idSet = new Set<ThreadId>(threadIds);
    let reservationChanged = false;
    for (const [id, existing] of activeReservations.entries()) {
      if (idSet.has(existing.threadId)) {
        activeReservations.delete(id);
        reservationChanged = true;
      }
    }
    if (reservationChanged) {
      notifyReservationChange();
    }

    let leaseChanged = false;
    for (const [checkoutKey, lease] of activeCheckoutLeases.entries()) {
      if (idSet.has(lease.threadId)) {
        activeCheckoutLeases.delete(checkoutKey);
        leaseChanged = true;
      }
    }
    if (leaseChanged) {
      notifyCheckoutLeaseChange();
    }

    const encoded = encodeStringArrayJson([...idSet]);
    yield* sql`
      DELETE FROM shared_worktree_planned_paths
      WHERE thread_id IN (SELECT value FROM json_each(${encoded}))
    `.pipe(Effect.ignore);
    yield* sql`
      DELETE FROM shared_worktree_controlled_writes
      WHERE thread_id IN (SELECT value FROM json_each(${encoded}))
    `.pipe(Effect.ignore);

    for (const id of idSet) {
      threadFileChangeCache.delete(id);
    }
    bumpCoordinationVersion();
  });

  return SharedWorktreeCoordinationService.of({
    getSnapshot,
    setPolicy,
    setPlannedPaths,
    acquireWriteReservation,
    releaseWriteReservation,
    controlledWriteFile,
    acquireCheckoutTurnLease,
    suspendCheckoutTurnLease,
    releaseRunReservations,
    clearThreadState,
    watchCoordinationChange,
  });
});

export const layer = Layer.effect(SharedWorktreeCoordinationService, make);

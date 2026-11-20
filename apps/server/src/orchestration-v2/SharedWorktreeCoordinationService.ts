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
  classifyCanonicalPathConflict,
  computePathOverlaps,
  normalizeCheckoutRelativePath,
  type NormalizedCheckoutPath,
  type OverlapInputEntry,
} from "./SharedWorktreePathUtils.ts";

const MAX_REVISION_PREVIEW_BYTES = 256 * 1024;
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

  const notifyCoordinationChange = () => {
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
    const checkout = yield* canonicalizeCheckoutPath(fileSystem, path, rawCheckout);
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

  const getSnapshot: SharedWorktreeCoordinationServiceShape["getSnapshot"] = Effect.fn(
    "SharedWorktreeCoordinationService.getSnapshot",
  )(function* (threadId) {
    const { thread, checkout } = yield* resolveThreadCheckout(threadId);
    const rootThreadId = thread.lineage.rootThreadId ?? thread.id;
    const policy = yield* readPolicyRow(checkout.checkoutKey, checkout.checkoutPath);

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
    const activeThreads = shell.threads.filter(
      (candidate) => candidate.deletedAt === null && candidate.archivedAt === null,
    );
    const byId = new Map(activeThreads.map((candidate) => [candidate.id, candidate]));

    const projectRootCache = new Map<string, string>();
    const resolveCandidateCheckout = Effect.fn(
      "SharedWorktreeCoordinationService.candidateCheckout",
    )(function* (candidate: OrchestrationV2ThreadShell) {
      let rawRoot = candidate.worktreePath;
      if (rawRoot === null) {
        const cached = projectRootCache.get(candidate.projectId);
        if (cached !== undefined) {
          rawRoot = cached;
        } else {
          const proj = yield* projects
            .get(candidate.projectId, { includeDeleted: true })
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(proj)) return null;
          rawRoot = proj.value.workspaceRoot;
          projectRootCache.set(candidate.projectId, rawRoot);
        }
      }
      return yield* canonicalizeCheckoutPath(fileSystem, path, rawRoot);
    });

    const sharedThreads: Array<OrchestrationV2ThreadShell> = [];
    for (const candidate of activeThreads) {
      const candidateCheckout = yield* resolveCandidateCheckout(candidate);
      if (candidateCheckout?.checkoutKey === checkout.checkoutKey) {
        sharedThreads.push(candidate);
      }
    }
    if (!sharedThreads.some((candidate) => candidate.id === thread.id)) {
      const targetShell = byId.get(thread.id);
      if (targetShell) sharedThreads.push(targetShell);
    }

    const sharedThreadIds = sharedThreads.map((candidate) => candidate.id);
    const plannedRows =
      sharedThreadIds.length === 0
        ? []
        : yield* sql<PlannedPathRow>`
            SELECT thread_id, normalized_path, raw_path, run_id, note, declared_at
            FROM shared_worktree_planned_paths
            WHERE thread_id IN (SELECT value FROM json_each(${encodeStringArrayJson(sharedThreadIds)}))
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

    const confirmedCanonicalKeys = new Set<string>();
    const overlapEntries: Array<OverlapInputEntry> = [];
    const threadAttributions: Array<SharedWorktreeThreadAttribution> = [];

    for (const candidate of sharedThreads) {
      const planned = plannedByThread.get(candidate.id) ?? [];
      for (const item of planned) {
        const normalized = yield* normalizeCheckoutRelativePath(
          fileSystem,
          path,
          checkout.checkoutPath,
          item.normalizedPath,
        ).pipe(Effect.orElseSucceed(() => null));
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

      const addConfirmedWrite = Effect.fn("SharedWorktreeCoordinationService.addConfirmedWrite")(
        function* (entry: {
          readonly rawPath: string;
          readonly oldRawPath: string | null;
          readonly operation: string;
          readonly runId: RunId | null;
          readonly turnItemId: TurnItemId | null;
          readonly source: "turn_item" | "controlled_write";
          readonly updatedAt: IsoDateTime;
        }) {
          const normalized = yield* normalizeCheckoutRelativePath(
            fileSystem,
            path,
            checkout.checkoutPath,
            entry.rawPath,
          ).pipe(Effect.orElseSucceed(() => null));
          if (normalized === null) return;

          const oldNormalized =
            entry.oldRawPath === null
              ? null
              : yield* normalizeCheckoutRelativePath(
                  fileSystem,
                  path,
                  checkout.checkoutPath,
                  entry.oldRawPath,
                ).pipe(Effect.orElseSucceed(() => null));

          confirmedCanonicalKeys.add(normalized.canonicalKey);
          if (oldNormalized !== null) {
            confirmedCanonicalKeys.add(oldNormalized.canonicalKey);
          }

          const dedupeKey = `${normalized.canonicalKey}\0${oldNormalized?.canonicalKey ?? ""}\0${entry.runId ?? ""}\0${entry.source}`;
          if (!seenConfirmed.has(dedupeKey)) {
            seenConfirmed.add(dedupeKey);
            confirmedWrites.push({
              path: entry.rawPath,
              normalizedPath: normalized.normalizedPath,
              oldPath: entry.oldRawPath,
              oldNormalizedPath: oldNormalized?.normalizedPath ?? null,
              operation: entry.operation,
              runId: entry.runId,
              turnItemId: entry.turnItemId,
              source: entry.source,
              updatedAt: entry.updatedAt,
            });
          }

          overlapEntries.push({
            threadId: candidate.id,
            threadTitle: candidate.title,
            runId: entry.runId,
            layer: "confirmed_write",
            rawPath: entry.rawPath,
            normalizedPath: normalized.normalizedPath,
            canonicalKey: normalized.canonicalKey,
            ...(oldNormalized !== null ? { isRenameEndpoint: true } : {}),
          });
          if (oldNormalized !== null) {
            overlapEntries.push({
              threadId: candidate.id,
              threadTitle: candidate.title,
              runId: entry.runId,
              layer: "confirmed_write",
              rawPath: entry.oldRawPath!,
              normalizedPath: oldNormalized.normalizedPath,
              canonicalKey: oldNormalized.canonicalKey,
              isRenameEndpoint: true,
            });
          }
        },
      );

      // Layer 2a: Confirmed tool writes from durable file_change turn items.
      const turnItemRecords = yield* projections
        .getThreadRecords(candidate.id, ["turnItems"], { turnItemTypes: ["file_change"] })
        .pipe(Effect.orElseSucceed(() => ({ thread: null, turnItems: [] })));

      for (const item of turnItemRecords.turnItems) {
        if (item.type !== "file_change") continue;
        if (item.status === "failed" || item.status === "cancelled") continue;
        const updatedAt = IsoDateTime.make(DateTime.formatIso(item.updatedAt));
        if (item.changes && item.changes.length > 0) {
          for (const detail of item.changes) {
            yield* addConfirmedWrite({
              rawPath: detail.path,
              oldRawPath: detail.oldPath ?? null,
              operation: detail.operation,
              runId: item.runId,
              turnItemId: TurnItemId.make(item.id),
              source: "turn_item",
              updatedAt,
            });
          }
        } else {
          yield* addConfirmedWrite({
            rawPath: item.fileName,
            oldRawPath: null,
            operation: "edit",
            runId: item.runId,
            turnItemId: TurnItemId.make(item.id),
            source: "turn_item",
            updatedAt,
          });
        }
      }

      // Layer 2b: Server-controlled write tool commits.
      for (const controlled of controlledWritesByThread.get(candidate.id) ?? []) {
        yield* addConfirmedWrite({
          rawPath: controlled.path,
          oldRawPath: controlled.oldPath,
          operation: controlled.operation,
          runId: controlled.runId,
          turnItemId: null,
          source: "controlled_write",
          updatedAt: controlled.updatedAt,
        });
      }

      const threadActiveReservations = [...activeReservations.values()]
        .filter(
          (reservation) =>
            reservation.checkoutKey === checkout.checkoutKey &&
            reservation.threadId === candidate.id,
        )
        .map((reservation) => {
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
        });

      for (const waiting of waitingReservations) {
        if (waiting.checkoutKey !== checkout.checkoutKey || waiting.threadId !== candidate.id) {
          continue;
        }
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

      const candidateRoot = candidate.lineage.rootThreadId ?? candidate.id;
      threadAttributions.push({
        threadId: candidate.id,
        title: candidate.title,
        depth: computeThreadDepth(candidate, byId),
        activeRunId: candidate.activeRunId,
        status: candidate.status,
        inFamily: candidateRoot === rootThreadId,
        plannedPaths: planned,
        confirmedWritePaths: confirmedWrites,
        activeReservations: threadActiveReservations,
      });
    }

    // Layer 3: Working-tree dirty files NOT confirmed written by any thread in this checkout.
    const observedUnverifiedPaths: Array<SharedWorktreeObservedPath> = [];
    if (Option.isSome(gitWorkflowOption)) {
      const localStatus = yield* gitWorkflowOption.value
        .localStatus({ cwd: checkout.checkoutPath })
        .pipe(Effect.orElseSucceed(() => null));
      if (localStatus !== null && localStatus.isRepo) {
        const seenObserved = new Set<string>();
        for (const file of localStatus.workingTree.files) {
          const normalized = yield* normalizeCheckoutRelativePath(
            fileSystem,
            path,
            checkout.checkoutPath,
            file.path,
          ).pipe(Effect.orElseSucceed(() => null));
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
    }

    const checkoutActiveReservations = [...activeReservations.values()]
      .filter((reservation) => reservation.checkoutKey === checkout.checkoutKey)
      .map(toPublicReservation);
    const checkoutWaitingReservations = waitingReservations
      .filter((waiting) => waiting.checkoutKey === checkout.checkoutKey)
      .map(toPublicWaitingReservation);

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

    threadAttributions.sort(
      (a, b) =>
        (a.inFamily === b.inFamily ? 0 : a.inFamily ? -1 : 1) ||
        a.depth - b.depth ||
        a.threadId.localeCompare(b.threadId),
    );
    observedUnverifiedPaths.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));

    return {
      rootThreadId,
      checkoutPath: checkout.checkoutPath,
      checkoutKey: checkout.checkoutKey,
      policy,
      sharedThreadCount: threadAttributions.length,
      threads: threadAttributions,
      overlaps: computePathOverlaps(overlapEntries),
      observedUnverifiedPaths,
      activeReservations: checkoutActiveReservations,
      waitingReservations: checkoutWaitingReservations,
      activeSerializedRun,
      waitingSerializedRuns,
      restoreSafetyProtected: threadAttributions.length > 1 || thread.worktreePath === null,
      generatedAt: yield* nowIso(),
    } satisfies SharedWorktreeCoordinationSnapshot;
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
            return reservation;
          }

          waited = true;
          for (const conflict of conflicting) {
            priorWritersByKey.set(`${conflict.threadId}:${conflict.runId ?? ""}`, {
              threadId: conflict.threadId,
              runId: conflict.runId,
            });
          }

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

          const signal = reservationSignal;
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
          return;
        }
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
        const signal = checkoutLeaseSignal;
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

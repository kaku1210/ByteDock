import {
  CommandId,
  IsoDateTime,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  WorktreeApprovalError,
  WorktreeApprovalRequest,
  WorktreeApprovalRequestId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type WorktreeApprovalResolveInput,
  type WorktreeApprovalResolveResult,
  type WorktreeApprovalStatus,
  type WorktreeApprovalStreamEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

const DEFAULT_WORKTREE_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface WorktreeApprovalEnsureInput {
  readonly requestId: WorktreeApprovalRequestId;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly parentRunId: RunId | null;
  readonly parentTaskId: NodeId | null;
  readonly childThreadId: ThreadId;
  readonly childRunId: RunId | null;
  readonly baseRef: string;
  readonly baseCommitSha: string | null;
  readonly branch: string | null;
  readonly startFromOrigin: boolean;
  readonly requestedBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface WorktreeApprovalCancelScope {
  readonly requestId?: WorktreeApprovalRequestId;
  readonly parentThreadId?: ThreadId;
  readonly parentRunId?: RunId;
  readonly parentTaskId?: NodeId;
  readonly childThreadId?: ThreadId;
  readonly childRunId?: RunId;
  readonly reason: string;
}

export interface WorktreeApprovalProvisionResult {
  readonly alreadyProvisioned: boolean;
  readonly worktreePath: string;
  readonly branch: string | null;
}

export class WorktreeApprovalService extends Context.Service<
  WorktreeApprovalService,
  {
    readonly ensureRequest: (
      input: WorktreeApprovalEnsureInput,
    ) => Effect.Effect<WorktreeApprovalRequest, WorktreeApprovalError>;
    readonly resolveByHuman: (
      input: WorktreeApprovalResolveInput,
    ) => Effect.Effect<WorktreeApprovalResolveResult, WorktreeApprovalError>;
    readonly cancelByScope: (scope: WorktreeApprovalCancelScope) => Effect.Effect<number>;
    readonly awaitResolution: (
      requestId: WorktreeApprovalRequestId,
    ) => Effect.Effect<WorktreeApprovalRequest, WorktreeApprovalError>;
    readonly withProvisionLock: <E, R>(
      requestId: WorktreeApprovalRequestId,
      provision: () => Effect.Effect<
        { readonly worktreePath: string; readonly branch: string | null },
        E,
        R
      >,
    ) => Effect.Effect<WorktreeApprovalProvisionResult, E | WorktreeApprovalError, R>;
    readonly getById: (
      requestId: WorktreeApprovalRequestId,
    ) => Effect.Effect<Option.Option<WorktreeApprovalRequest>>;
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<WorktreeApprovalRequest>>;
    readonly streamForThread: (threadId: ThreadId) => Stream.Stream<WorktreeApprovalStreamEvent>;
  }
>()("t3/orchestration-v2/WorktreeApprovalService") {}

interface WorktreeApprovalRow {
  readonly request_id: string;
  readonly command_id: string;
  readonly project_id: string;
  readonly parent_thread_id: string | null;
  readonly parent_run_id: string | null;
  readonly parent_task_id: string | null;
  readonly child_thread_id: string;
  readonly child_run_id: string | null;
  readonly base_ref: string;
  readonly base_commit_sha: string | null;
  readonly branch: string | null;
  readonly start_from_origin: number;
  readonly requested_by: string;
  readonly creation_source: string;
  readonly status: string;
  readonly approved_worktree_path: string | null;
  readonly approved_branch: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly resolution_reason: string | null;
}

function rowToRequest(row: WorktreeApprovalRow): WorktreeApprovalRequest {
  return {
    requestId: WorktreeApprovalRequestId.make(row.request_id),
    commandId: CommandId.make(row.command_id),
    projectId: ProjectId.make(row.project_id),
    parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
    parentRunId: row.parent_run_id === null ? null : RunId.make(row.parent_run_id),
    parentTaskId: row.parent_task_id === null ? null : NodeId.make(row.parent_task_id),
    childThreadId: ThreadId.make(row.child_thread_id),
    childRunId: row.child_run_id === null ? null : RunId.make(row.child_run_id),
    baseRef: row.base_ref,
    baseCommitSha: row.base_commit_sha,
    branch: row.branch,
    startFromOrigin: row.start_from_origin !== 0,
    requestedBy: row.requested_by as OrchestrationV2Actor,
    creationSource: row.creation_source as OrchestrationV2CreationSource,
    status: row.status as WorktreeApprovalStatus,
    approvedWorktreePath: row.approved_worktree_path,
    approvedBranch: row.approved_branch,
    createdAt: IsoDateTime.make(row.created_at),
    expiresAt: IsoDateTime.make(row.expires_at),
    resolvedAt: row.resolved_at === null ? null : IsoDateTime.make(row.resolved_at),
    resolvedBy: row.resolved_by === null ? null : (row.resolved_by as OrchestrationV2Actor),
    resolutionReason: row.resolution_reason,
  };
}

function isPastExpiry(expiresAt: string, nowMs: number): boolean {
  const expiryMs = Date.parse(expiresAt);
  return Number.isFinite(expiryMs) && nowMs >= expiryMs;
}

function assertBindingsMatch(
  existing: WorktreeApprovalRequest,
  input: WorktreeApprovalEnsureInput,
): Effect.Effect<void, WorktreeApprovalError> {
  if (existing.projectId !== input.projectId) {
    return Effect.fail(
      new WorktreeApprovalError({
        reason: "binding_mismatch",
        detail: `Worktree approval ${existing.requestId} is bound to project ${existing.projectId}, not ${input.projectId}.`,
      }),
    );
  }
  if (existing.childThreadId !== input.childThreadId) {
    return Effect.fail(
      new WorktreeApprovalError({
        reason: "binding_mismatch",
        detail: `Worktree approval ${existing.requestId} is bound to child thread ${existing.childThreadId}, not ${input.childThreadId}.`,
      }),
    );
  }
  if (
    existing.baseCommitSha !== null &&
    input.baseCommitSha !== null &&
    existing.baseCommitSha !== input.baseCommitSha
  ) {
    return Effect.fail(
      new WorktreeApprovalError({
        reason: "binding_mismatch",
        detail: `Worktree approval ${existing.requestId} is bound to commit ${existing.baseCommitSha}, not ${input.baseCommitSha}.`,
      }),
    );
  }
  if (
    existing.parentThreadId !== null &&
    input.parentThreadId !== null &&
    existing.parentThreadId !== input.parentThreadId
  ) {
    return Effect.fail(
      new WorktreeApprovalError({
        reason: "binding_mismatch",
        detail: `Worktree approval ${existing.requestId} is bound to parent thread ${existing.parentThreadId}, not ${input.parentThreadId}.`,
      }),
    );
  }
  if (
    existing.parentTaskId !== null &&
    input.parentTaskId !== null &&
    existing.parentTaskId !== input.parentTaskId
  ) {
    return Effect.fail(
      new WorktreeApprovalError({
        reason: "binding_mismatch",
        detail: `Worktree approval ${existing.requestId} is bound to parent task ${existing.parentTaskId}, not ${input.parentTaskId}.`,
      }),
    );
  }
  return Effect.void;
}

function formatIsoMs(ms: number): IsoDateTime {
  return IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));
}

export interface WorktreeApprovalServiceConfig {
  readonly defaultTtlMs?: number;
}

const makeWithConfig = Effect.fn("WorktreeApprovalService.makeWithConfig")(function* (
  config: WorktreeApprovalServiceConfig = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const ttlMs = config.defaultTtlMs ?? DEFAULT_WORKTREE_APPROVAL_TTL_MS;
  const changes = yield* PubSub.unbounded<WorktreeApprovalRequest>();
  const mutationLock = Semaphore.makeUnsafe(1);
  const provisionLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

  const mapPersistenceError = (cause: unknown) =>
    new WorktreeApprovalError({
      reason: "persistence_failed",
      cause,
    });

  const getProvisionLock = (requestId: WorktreeApprovalRequestId) =>
    Ref.modify(provisionLocks, (locks) => {
      const existing = locks.get(requestId);
      if (existing !== undefined) return [existing, locks] as const;
      const next = new Map(locks);
      const created = Semaphore.makeUnsafe(1);
      next.set(requestId, created);
      return [created, next] as const;
    });

  const readRowById = (requestId: WorktreeApprovalRequestId) =>
    sql<WorktreeApprovalRow>`
      SELECT * FROM worktree_approval_requests
      WHERE request_id = ${requestId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? Option.none() : Option.some(rowToRequest(rows[0])),
      ),
      Effect.mapError(mapPersistenceError),
    );

  const expireRowIfDue = Effect.fn("WorktreeApprovalService.expireRowIfDue")(function* (
    request: WorktreeApprovalRequest,
  ) {
    if (request.status !== "pending") return request;
    const nowMs = yield* Clock.currentTimeMillis;
    if (!isPastExpiry(request.expiresAt, nowMs)) return request;
    const nowIso = formatIsoMs(nowMs);
    const reason = "Worktree approval request expired.";
    yield* sql`
      UPDATE worktree_approval_requests
      SET status = 'expired',
          resolved_at = ${nowIso},
          resolution_reason = ${reason}
      WHERE request_id = ${request.requestId}
        AND status = 'pending'
    `.pipe(Effect.mapError(mapPersistenceError));
    const updated: WorktreeApprovalRequest = {
      ...request,
      status: "expired",
      resolvedAt: nowIso,
      resolutionReason: reason,
    };
    yield* PubSub.publish(changes, updated);
    return updated;
  });

  const ensureRequest: WorktreeApprovalService["Service"]["ensureRequest"] = Effect.fn(
    "WorktreeApprovalService.ensureRequest",
  )(function* (input) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        let existing = yield* readRowById(input.requestId);
        if (Option.isNone(existing) && input.childRunId !== null) {
          const byRun = yield* sql<WorktreeApprovalRow>`
              SELECT * FROM worktree_approval_requests
              WHERE child_thread_id = ${input.childThreadId}
                AND child_run_id = ${input.childRunId}
              ORDER BY created_at DESC
              LIMIT 1
            `.pipe(Effect.mapError(mapPersistenceError));
          if (byRun[0] !== undefined) {
            existing = Option.some(rowToRequest(byRun[0]));
          }
        }
        if (Option.isNone(existing) && input.parentTaskId !== null) {
          const byTask = yield* sql<WorktreeApprovalRow>`
              SELECT * FROM worktree_approval_requests
              WHERE parent_task_id = ${input.parentTaskId}
                AND child_thread_id = ${input.childThreadId}
              ORDER BY created_at DESC
              LIMIT 1
            `.pipe(Effect.mapError(mapPersistenceError));
          if (byTask[0] !== undefined) {
            existing = Option.some(rowToRequest(byTask[0]));
          }
        }
        if (Option.isSome(existing)) {
          yield* assertBindingsMatch(existing.value, input);
          return yield* expireRowIfDue(existing.value);
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const createdAt = formatIsoMs(nowMs);
        const expiresAt = formatIsoMs(nowMs + ttlMs);
        const created: WorktreeApprovalRequest = {
          requestId: input.requestId,
          commandId: input.commandId,
          projectId: input.projectId,
          parentThreadId: input.parentThreadId,
          parentRunId: input.parentRunId,
          parentTaskId: input.parentTaskId,
          childThreadId: input.childThreadId,
          childRunId: input.childRunId,
          baseRef: input.baseRef,
          baseCommitSha: input.baseCommitSha,
          branch: input.branch,
          startFromOrigin: input.startFromOrigin,
          requestedBy: input.requestedBy,
          creationSource: input.creationSource,
          status: "pending",
          approvedWorktreePath: null,
          approvedBranch: null,
          createdAt,
          expiresAt,
          resolvedAt: null,
          resolvedBy: null,
          resolutionReason: null,
        };
        yield* sql`
            INSERT INTO worktree_approval_requests (
              request_id,
              command_id,
              project_id,
              parent_thread_id,
              parent_run_id,
              parent_task_id,
              child_thread_id,
              child_run_id,
              base_ref,
              base_commit_sha,
              branch,
              start_from_origin,
              requested_by,
              creation_source,
              status,
              approved_worktree_path,
              approved_branch,
              created_at,
              expires_at,
              resolved_at,
              resolved_by,
              resolution_reason
            ) VALUES (
              ${created.requestId},
              ${created.commandId},
              ${created.projectId},
              ${created.parentThreadId},
              ${created.parentRunId},
              ${created.parentTaskId},
              ${created.childThreadId},
              ${created.childRunId},
              ${created.baseRef},
              ${created.baseCommitSha},
              ${created.branch},
              ${created.startFromOrigin ? 1 : 0},
              ${created.requestedBy},
              ${created.creationSource},
              ${created.status},
              ${created.approvedWorktreePath},
              ${created.approvedBranch},
              ${created.createdAt},
              ${created.expiresAt},
              ${created.resolvedAt},
              ${created.resolvedBy},
              ${created.resolutionReason}
            )
          `.pipe(Effect.mapError(mapPersistenceError));
        yield* PubSub.publish(changes, created);
        return created;
      }),
    );
  });

  const resolveByHuman: WorktreeApprovalService["Service"]["resolveByHuman"] = Effect.fn(
    "WorktreeApprovalService.resolveByHuman",
  )(function* (input) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readRowById(input.requestId);
        if (Option.isNone(current)) {
          return yield* new WorktreeApprovalError({ reason: "not_found" });
        }
        const checked = yield* expireRowIfDue(current.value);
        if (checked.status === "expired") {
          return yield* new WorktreeApprovalError({ reason: "expired" });
        }
        if (checked.status === "cancelled") {
          return yield* new WorktreeApprovalError({ reason: "cancelled" });
        }
        if (checked.status !== "pending") {
          return yield* new WorktreeApprovalError({
            reason: "already_resolved",
            detail: `Worktree approval request is already ${checked.status}.`,
          });
        }

        const nowIso = formatIsoMs(yield* Clock.currentTimeMillis);
        const nextStatus: WorktreeApprovalStatus =
          input.decision === "approve" ? "approved" : "denied";
        const trimmedReason = input.reason?.trim();
        const resolutionReason =
          trimmedReason && trimmedReason.length > 0
            ? trimmedReason
            : input.decision === "approve"
              ? "Approved by user."
              : "Denied by user.";
        yield* sql`
            UPDATE worktree_approval_requests
            SET status = ${nextStatus},
                resolved_at = ${nowIso},
                resolved_by = 'user',
                resolution_reason = ${resolutionReason}
            WHERE request_id = ${checked.requestId}
              AND status = 'pending'
          `.pipe(Effect.mapError(mapPersistenceError));
        const updated: WorktreeApprovalRequest = {
          ...checked,
          status: nextStatus,
          resolvedAt: nowIso,
          resolvedBy: "user",
          resolutionReason,
        };
        yield* PubSub.publish(changes, updated);
        return { request: updated };
      }),
    );
  });

  const cancelByScope: WorktreeApprovalService["Service"]["cancelByScope"] = Effect.fn(
    "WorktreeApprovalService.cancelByScope",
  )(function* (scope) {
    return yield* mutationLock
      .withPermits(1)(
        Effect.gen(function* () {
          const pendingRows = yield* sql<WorktreeApprovalRow>`
              SELECT * FROM worktree_approval_requests
              WHERE status = 'pending'
            `;
          const matched = pendingRows.map(rowToRequest).filter((row) => {
            if (scope.requestId !== undefined && row.requestId === scope.requestId) return true;
            if (scope.parentTaskId !== undefined && row.parentTaskId === scope.parentTaskId)
              return true;
            if (
              scope.childThreadId !== undefined &&
              scope.childRunId !== undefined &&
              row.childThreadId === scope.childThreadId &&
              row.childRunId === scope.childRunId
            )
              return true;
            if (
              scope.childThreadId !== undefined &&
              scope.childRunId === undefined &&
              row.childThreadId === scope.childThreadId
            )
              return true;
            if (
              scope.parentThreadId !== undefined &&
              scope.parentRunId !== undefined &&
              row.parentThreadId === scope.parentThreadId &&
              row.parentRunId === scope.parentRunId
            )
              return true;
            return false;
          });
          if (matched.length === 0) return 0;
          const nowIso = formatIsoMs(yield* Clock.currentTimeMillis);
          for (const row of matched) {
            yield* sql`
                UPDATE worktree_approval_requests
                SET status = 'cancelled',
                    resolved_at = ${nowIso},
                    resolution_reason = ${scope.reason}
                WHERE request_id = ${row.requestId}
                  AND status = 'pending'
              `;
            yield* PubSub.publish(changes, {
              ...row,
              status: "cancelled",
              resolvedAt: nowIso,
              resolutionReason: scope.reason,
            });
          }
          return matched.length;
        }),
      )
      .pipe(Effect.orElseSucceed(() => 0));
  });

  const awaitResolution: WorktreeApprovalService["Service"]["awaitResolution"] = Effect.fn(
    "WorktreeApprovalService.awaitResolution",
  )(function* (requestId) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const currentOpt = yield* mutationLock.withPermits(1)(
          readRowById(requestId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none<WorktreeApprovalRequest>()),
                onSome: (row) => expireRowIfDue(row).pipe(Effect.asSome),
              }),
            ),
          ),
        );
        if (Option.isNone(currentOpt)) {
          return yield* new WorktreeApprovalError({ reason: "not_found" });
        }
        const current = currentOpt.value;
        if (current.status !== "pending") return current;

        const nowMs = yield* Clock.currentTimeMillis;
        const remainingMs = Math.max(0, Date.parse(current.expiresAt) - nowMs);
        const waitForChange = Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.requestId === requestId && event.status !== "pending"),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.never,
              onSome: Effect.succeed,
            }),
          ),
        );
        const waitForExpiry = Effect.sleep(Duration.millis(remainingMs)).pipe(
          Effect.andThen(
            mutationLock.withPermits(1)(
              readRowById(requestId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new WorktreeApprovalError({ reason: "not_found" })),
                    onSome: expireRowIfDue,
                  }),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.raceFirst(waitForChange, waitForExpiry);
      }),
    );
  });

  const withProvisionLock: WorktreeApprovalService["Service"]["withProvisionLock"] = Effect.fn(
    "WorktreeApprovalService.withProvisionLock",
  )(function* <E, R>(
    requestId: WorktreeApprovalRequestId,
    provision: () => Effect.Effect<
      { readonly worktreePath: string; readonly branch: string | null },
      E,
      R
    >,
  ) {
    const lock = yield* getProvisionLock(requestId);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const currentOpt = yield* readRowById(requestId);
        if (Option.isNone(currentOpt)) {
          return yield* new WorktreeApprovalError({ reason: "not_found" });
        }
        const current = currentOpt.value;
        if (current.status !== "approved") {
          return yield* new WorktreeApprovalError({
            reason:
              current.status === "expired"
                ? "expired"
                : current.status === "cancelled"
                  ? "cancelled"
                  : "already_resolved",
            detail: `Cannot provision worktree while approval status is "${current.status}".`,
          });
        }
        if (current.approvedWorktreePath !== null) {
          return {
            alreadyProvisioned: true,
            worktreePath: current.approvedWorktreePath,
            branch: current.approvedBranch,
          };
        }
        const created = yield* provision();
        yield* sql`
            UPDATE worktree_approval_requests
            SET approved_worktree_path = ${created.worktreePath},
                approved_branch = ${created.branch}
            WHERE request_id = ${requestId}
          `.pipe(Effect.mapError(mapPersistenceError));
        const updated: WorktreeApprovalRequest = {
          ...current,
          approvedWorktreePath: created.worktreePath,
          approvedBranch: created.branch,
        };
        yield* PubSub.publish(changes, updated);
        return {
          alreadyProvisioned: false,
          worktreePath: created.worktreePath,
          branch: created.branch,
        };
      }),
    );
  });

  const getById: WorktreeApprovalService["Service"]["getById"] = (requestId) =>
    mutationLock
      .withPermits(1)(
        readRowById(requestId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<WorktreeApprovalRequest>()),
              onSome: (row) => expireRowIfDue(row).pipe(Effect.asSome),
            }),
          ),
        ),
      )
      .pipe(Effect.orElseSucceed(() => Option.none()));

  const listForThread: WorktreeApprovalService["Service"]["listForThread"] = (threadId) =>
    mutationLock
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<WorktreeApprovalRow>`
              SELECT * FROM worktree_approval_requests
              WHERE child_thread_id = ${threadId}
                 OR parent_thread_id = ${threadId}
              ORDER BY created_at DESC
            `;
          const results: WorktreeApprovalRequest[] = [];
          for (const row of rows) {
            results.push(yield* expireRowIfDue(rowToRequest(row)));
          }
          return results;
        }),
      )
      .pipe(Effect.orElseSucceed(() => []));

  const streamForThread: WorktreeApprovalService["Service"]["streamForThread"] = (threadId) =>
    Stream.callback<WorktreeApprovalStreamEvent>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* listForThread(threadId);
          Queue.offerUnsafe(mailbox, { requests: initial });
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) => change.childThreadId === threadId || change.parentThreadId === threadId,
            ),
            Stream.runForEach(() =>
              listForThread(threadId).pipe(
                Effect.tap((requests) =>
                  Effect.sync(() => Queue.offerUnsafe(mailbox, { requests })),
                ),
              ),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return WorktreeApprovalService.of({
    ensureRequest,
    resolveByHuman,
    cancelByScope,
    awaitResolution,
    withProvisionLock,
    getById,
    listForThread,
    streamForThread,
  });
});

const make = makeWithConfig();

export const layer = Layer.effect(WorktreeApprovalService, make);

export const layerWithConfig = (config: WorktreeApprovalServiceConfig) =>
  Layer.effect(WorktreeApprovalService, makeWithConfig(config));

import {
  IsoDateTime,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  SubtaskEscalationError,
  SubtaskEscalationRequest,
  SubtaskEscalationRequestId,
  ThreadId,
  type OrchestrationV2Actor,
  type SubtaskEscalationStatus,
  type SubtaskEscalationTrigger,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

const CausationChainJson = Schema.fromJsonString(Schema.Array(ThreadId));
const encodeCausationChain = Schema.encodeSync(CausationChainJson);
const decodeCausationChainStrict = Schema.decodeUnknownOption(CausationChainJson);

interface SubtaskEscalationRow {
  readonly request_id: string;
  readonly project_id: string;
  readonly root_thread_id: string;
  readonly source_thread_id: string;
  readonly source_run_id: string | null;
  readonly source_message_id: string | null;
  readonly excerpt: string | null;
  readonly title: string | null;
  readonly task: string;
  readonly trigger: string;
  readonly status: string;
  readonly child_thread_id: string | null;
  readonly delegated_task_id: string | null;
  readonly inbox_message_id: string | null;
  readonly inbox_run_id: string | null;
  readonly parent_queue_held: number;
  readonly causation_chain_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly resolution_reason: string | null;
}

function decodeCausationChain(raw: string): ReadonlyArray<ThreadId> {
  const decoded = decodeCausationChainStrict(raw);
  if (Option.isSome(decoded)) {
    return decoded.value.filter((entry) => entry.trim().length > 0);
  }
  return [];
}

function rowToRequest(row: SubtaskEscalationRow): SubtaskEscalationRequest {
  return {
    requestId: SubtaskEscalationRequestId.make(row.request_id),
    projectId: ProjectId.make(row.project_id),
    rootThreadId: ThreadId.make(row.root_thread_id),
    sourceThreadId: ThreadId.make(row.source_thread_id),
    sourceRunId: row.source_run_id === null ? null : RunId.make(row.source_run_id),
    sourceMessageId: row.source_message_id === null ? null : MessageId.make(row.source_message_id),
    excerpt: row.excerpt,
    title: row.title,
    task: row.task,
    trigger: row.trigger as SubtaskEscalationTrigger,
    status: row.status as SubtaskEscalationStatus,
    childThreadId: row.child_thread_id === null ? null : ThreadId.make(row.child_thread_id),
    delegatedTaskId: row.delegated_task_id === null ? null : NodeId.make(row.delegated_task_id),
    inboxMessageId: row.inbox_message_id === null ? null : MessageId.make(row.inbox_message_id),
    inboxRunId: row.inbox_run_id === null ? null : RunId.make(row.inbox_run_id),
    parentQueueHeld: row.parent_queue_held !== 0,
    causationChain: decodeCausationChain(row.causation_chain_json),
    createdAt: IsoDateTime.make(row.created_at),
    updatedAt: IsoDateTime.make(row.updated_at),
    resolvedAt: row.resolved_at === null ? null : IsoDateTime.make(row.resolved_at),
    resolvedBy: row.resolved_by === null ? null : (row.resolved_by as OrchestrationV2Actor),
    resolutionReason: row.resolution_reason,
  };
}

export interface UpsertSubtaskEscalationInput {
  readonly requestId: SubtaskEscalationRequestId;
  readonly projectId: ProjectId;
  readonly rootThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: RunId | null;
  readonly sourceMessageId: MessageId | null;
  readonly excerpt: string | null;
  readonly title: string | null;
  readonly task: string;
  readonly trigger: SubtaskEscalationTrigger;
  readonly status: SubtaskEscalationStatus;
  readonly childThreadId: ThreadId | null;
  readonly delegatedTaskId: NodeId | null;
  readonly inboxMessageId: MessageId | null;
  readonly inboxRunId: RunId | null;
  readonly parentQueueHeld: boolean;
  readonly causationChain: ReadonlyArray<ThreadId>;
  readonly resolvedBy: OrchestrationV2Actor | null;
  readonly resolutionReason: string | null;
}

export interface SubtaskEscalationStoreShape {
  /** Serializes concurrent operations targeting the same escalation requestId. */
  readonly withRequestLock: <A, E, R>(
    requestId: SubtaskEscalationRequestId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly getById: (
    requestId: SubtaskEscalationRequestId,
  ) => Effect.Effect<Option.Option<SubtaskEscalationRequest>, SubtaskEscalationError>;
  readonly listForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<SubtaskEscalationRequest>, SubtaskEscalationError>;
  readonly upsert: (
    input: UpsertSubtaskEscalationInput,
  ) => Effect.Effect<SubtaskEscalationRequest, SubtaskEscalationError>;
  readonly markFulfilled: (input: {
    readonly requestId: SubtaskEscalationRequestId;
    readonly childThreadId: ThreadId;
    readonly delegatedTaskId: NodeId | null;
    readonly resolvedBy: OrchestrationV2Actor;
    readonly resolutionReason?: string | null;
  }) => Effect.Effect<SubtaskEscalationRequest, SubtaskEscalationError>;
  readonly markTerminal: (input: {
    readonly requestId: SubtaskEscalationRequestId;
    readonly status: "rejected" | "cancelled";
    readonly resolvedBy: OrchestrationV2Actor | null;
    readonly resolutionReason: string;
  }) => Effect.Effect<SubtaskEscalationRequest, SubtaskEscalationError>;
  /**
   * Cancels all pending escalation requests whose root or source thread is in `threadIds`.
   * Executes direct SQL without acquiring request locks so Orchestrator archive/delete/cancel
   * hooks can never deadlock with concurrent escalation requests.
   */
  readonly cancelByThreadIds: (input: {
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly reason: string;
  }) => Effect.Effect<number>;
}

export class SubtaskEscalationStore extends Context.Service<
  SubtaskEscalationStore,
  SubtaskEscalationStoreShape
>()("t3/orchestration-v2/SubtaskEscalationStore") {}

export const layer: Layer.Layer<SubtaskEscalationStore, never, SqlClient.SqlClient> = Layer.effect(
  SubtaskEscalationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const locksRef = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

    const lockFor = (requestId: SubtaskEscalationRequestId) =>
      Ref.modify(locksRef, (current) => {
        const existing = current.get(requestId);
        if (existing !== undefined) {
          return [existing, current] as const;
        }
        const created = Semaphore.makeUnsafe(1);
        const next = new Map(current);
        next.set(requestId, created);
        return [created, next] as const;
      });

    const persistenceError = (detail: string) => (cause: unknown) =>
      new SubtaskEscalationError({
        reason: "persistence_failed",
        detail,
        cause,
      });

    const getById: SubtaskEscalationStoreShape["getById"] = Effect.fn(
      "SubtaskEscalationStore.getById",
    )(function* (requestId) {
      const rows = yield* sql<SubtaskEscalationRow>`
        SELECT * FROM subtask_escalation_requests
        WHERE request_id = ${requestId}
        LIMIT 1
      `.pipe(Effect.mapError(persistenceError(`Failed to load escalation request ${requestId}.`)));
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(rowToRequest(row));
    });

    const listForThread: SubtaskEscalationStoreShape["listForThread"] = Effect.fn(
      "SubtaskEscalationStore.listForThread",
    )(function* (threadId) {
      const rows = yield* sql<SubtaskEscalationRow>`
        SELECT * FROM subtask_escalation_requests
        WHERE root_thread_id = ${threadId} OR source_thread_id = ${threadId}
        ORDER BY created_at DESC, request_id DESC
      `.pipe(
        Effect.mapError(
          persistenceError(`Failed to list escalation requests for thread ${threadId}.`),
        ),
      );
      return rows.map(rowToRequest);
    });

    const upsert: SubtaskEscalationStoreShape["upsert"] = Effect.fn(
      "SubtaskEscalationStore.upsert",
    )(function* (input) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const resolvedAt = input.status === "pending" ? null : nowIso;
      const causationChainJson = encodeCausationChain(input.causationChain);
      yield* sql`
        INSERT INTO subtask_escalation_requests (
          request_id,
          project_id,
          root_thread_id,
          source_thread_id,
          source_run_id,
          source_message_id,
          excerpt,
          title,
          task,
          trigger,
          status,
          child_thread_id,
          delegated_task_id,
          inbox_message_id,
          inbox_run_id,
          parent_queue_held,
          causation_chain_json,
          created_at,
          updated_at,
          resolved_at,
          resolved_by,
          resolution_reason
        ) VALUES (
          ${input.requestId},
          ${input.projectId},
          ${input.rootThreadId},
          ${input.sourceThreadId},
          ${input.sourceRunId},
          ${input.sourceMessageId},
          ${input.excerpt},
          ${input.title},
          ${input.task},
          ${input.trigger},
          ${input.status},
          ${input.childThreadId},
          ${input.delegatedTaskId},
          ${input.inboxMessageId},
          ${input.inboxRunId},
          ${input.parentQueueHeld ? 1 : 0},
          ${causationChainJson},
          ${nowIso},
          ${nowIso},
          ${resolvedAt},
          ${input.resolvedBy},
          ${input.resolutionReason}
        )
        ON CONFLICT(request_id) DO UPDATE SET
          status = excluded.status,
          child_thread_id = COALESCE(excluded.child_thread_id, subtask_escalation_requests.child_thread_id),
          delegated_task_id = COALESCE(excluded.delegated_task_id, subtask_escalation_requests.delegated_task_id),
          inbox_message_id = COALESCE(excluded.inbox_message_id, subtask_escalation_requests.inbox_message_id),
          inbox_run_id = COALESCE(excluded.inbox_run_id, subtask_escalation_requests.inbox_run_id),
          parent_queue_held = excluded.parent_queue_held,
          causation_chain_json = excluded.causation_chain_json,
          updated_at = excluded.updated_at,
          resolved_at = COALESCE(excluded.resolved_at, subtask_escalation_requests.resolved_at),
          resolved_by = COALESCE(excluded.resolved_by, subtask_escalation_requests.resolved_by),
          resolution_reason = COALESCE(excluded.resolution_reason, subtask_escalation_requests.resolution_reason)
      `.pipe(
        Effect.mapError(
          persistenceError(`Failed to persist escalation request ${input.requestId}.`),
        ),
      );
      const saved = yield* getById(input.requestId);
      if (Option.isNone(saved)) {
        return yield* new SubtaskEscalationError({
          reason: "persistence_failed",
          detail: `Escalation request ${input.requestId} disappeared after upsert.`,
        });
      }
      return saved.value;
    });

    const markFulfilled: SubtaskEscalationStoreShape["markFulfilled"] = Effect.fn(
      "SubtaskEscalationStore.markFulfilled",
    )(function* (input) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE subtask_escalation_requests
        SET
          status = 'fulfilled',
          child_thread_id = ${input.childThreadId},
          delegated_task_id = COALESCE(${input.delegatedTaskId}, delegated_task_id),
          updated_at = ${nowIso},
          resolved_at = COALESCE(resolved_at, ${nowIso}),
          resolved_by = COALESCE(resolved_by, ${input.resolvedBy}),
          resolution_reason = COALESCE(${input.resolutionReason ?? null}, resolution_reason)
        WHERE request_id = ${input.requestId}
      `.pipe(
        Effect.mapError(
          persistenceError(`Failed to mark escalation ${input.requestId} fulfilled.`),
        ),
      );
      const saved = yield* getById(input.requestId);
      if (Option.isNone(saved)) {
        return yield* new SubtaskEscalationError({
          reason: "not_found",
          detail: `Escalation request ${input.requestId} was not found.`,
        });
      }
      return saved.value;
    });

    const markTerminal: SubtaskEscalationStoreShape["markTerminal"] = Effect.fn(
      "SubtaskEscalationStore.markTerminal",
    )(function* (input) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE subtask_escalation_requests
        SET
          status = ${input.status},
          updated_at = ${nowIso},
          resolved_at = COALESCE(resolved_at, ${nowIso}),
          resolved_by = COALESCE(resolved_by, ${input.resolvedBy}),
          resolution_reason = ${input.resolutionReason}
        WHERE request_id = ${input.requestId} AND status = 'pending'
      `.pipe(
        Effect.mapError(
          persistenceError(`Failed to mark escalation ${input.requestId} ${input.status}.`),
        ),
      );
      const saved = yield* getById(input.requestId);
      if (Option.isNone(saved)) {
        return yield* new SubtaskEscalationError({
          reason: "not_found",
          detail: `Escalation request ${input.requestId} was not found.`,
        });
      }
      return saved.value;
    });

    const cancelByThreadIds: SubtaskEscalationStoreShape["cancelByThreadIds"] = Effect.fn(
      "SubtaskEscalationStore.cancelByThreadIds",
    )(function* (input) {
      const uniqueIds = Array.from(new Set(input.threadIds));
      if (uniqueIds.length === 0) return 0;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      let cancelledCount = 0;
      for (const threadId of uniqueIds) {
        const rows = yield* sql<{ readonly request_id: string }>`
          SELECT request_id FROM subtask_escalation_requests
          WHERE status = 'pending'
            AND (root_thread_id = ${threadId} OR source_thread_id = ${threadId})
        `.pipe(Effect.orElseSucceed(() => []));
        if (rows.length === 0) continue;
        yield* sql`
          UPDATE subtask_escalation_requests
          SET
            status = 'cancelled',
            updated_at = ${nowIso},
            resolved_at = COALESCE(resolved_at, ${nowIso}),
            resolution_reason = ${input.reason}
          WHERE status = 'pending'
            AND (root_thread_id = ${threadId} OR source_thread_id = ${threadId})
        `.pipe(Effect.ignore);
        cancelledCount += rows.length;
      }
      return cancelledCount;
    });

    const withRequestLock: SubtaskEscalationStoreShape["withRequestLock"] = Effect.fnUntraced(
      function* (requestId, effect) {
        const sem = yield* lockFor(requestId);
        return yield* sem.withPermits(1)(effect);
      },
    );

    return SubtaskEscalationStore.of({
      withRequestLock,
      getById,
      listForThread,
      upsert,
      markFulfilled,
      markTerminal,
      cancelByThreadIds,
    });
  }),
);

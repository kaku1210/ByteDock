import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import {
  IsoDateTime,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { SubtaskSummaryGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import { SubtaskSummaryOutputSchema } from "@t3tools/provider-core/server/textGenerationPrompts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type SubtaskSummaryCacheRepositoryError,
} from "./Errors.ts";

export interface SubtaskSummaryCacheKey {
  readonly parentThreadId: ThreadId;
  readonly sourceCutoffKey: string;
  readonly contentDigest: string;
  readonly strategyVersion: string;
}

export interface SubtaskSummaryCacheEntry {
  readonly key: SubtaskSummaryCacheKey;
  readonly summary: SubtaskSummaryGenerationResult;
  readonly sourceRunId: RunId | null;
  readonly sourceOrdinal: number | null;
  readonly sourceMessageId: MessageId | null;
  readonly sourceTurnItemId: TurnItemId | null;
  readonly modelInstanceId: ProviderInstanceId | null;
  readonly modelSlug: string | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly lastAccessedAt: IsoDateTime;
}

export interface PutSubtaskSummaryCacheInput {
  readonly key: SubtaskSummaryCacheKey;
  readonly summary: SubtaskSummaryGenerationResult;
  readonly sourceRunId?: RunId | null | undefined;
  readonly sourceOrdinal?: number | null | undefined;
  readonly sourceMessageId?: MessageId | null | undefined;
  readonly sourceTurnItemId?: TurnItemId | null | undefined;
  readonly modelInstanceId?: ProviderInstanceId | null | undefined;
  readonly modelSlug?: string | null | undefined;
  readonly now?: DateTime.Utc | undefined;
}

export interface PruneSubtaskSummaryCacheInput {
  readonly maxAgeBefore?: IsoDateTime | undefined;
  readonly maxEntries?: number | undefined;
}

interface SubtaskSummaryCacheRow {
  readonly parent_thread_id: string;
  readonly source_cutoff_key: string;
  readonly content_digest: string;
  readonly strategy_version: string;
  readonly summary_json: string;
  readonly source_run_id: string | null;
  readonly source_ordinal: number | null;
  readonly source_message_id: string | null;
  readonly source_turn_item_id: string | null;
  readonly model_instance_id: string | null;
  readonly model_slug: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_accessed_at: string;
}

const SummaryJson = Schema.fromJsonString(SubtaskSummaryOutputSchema);
const decodeSummaryJson = Schema.decodeEffect(SummaryJson);
const encodeSummaryJson = Schema.encodeEffect(SummaryJson);

const toSqlError =
  (operation: string, threadId?: ThreadId) =>
  (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      ...(threadId === undefined ? {} : { correlation: { threadId } }),
      cause,
    });

const toDecodeError =
  (operation: string, threadId: ThreadId) =>
  (cause: Schema.SchemaError): PersistenceDecodeError =>
    PersistenceDecodeError.fromSchemaError(operation, cause, { threadId });

const rowToEntry = (
  row: SubtaskSummaryCacheRow,
): Effect.Effect<SubtaskSummaryCacheEntry, PersistenceDecodeError> => {
  const parentThreadId = ThreadId.make(row.parent_thread_id);
  return decodeSummaryJson(row.summary_json).pipe(
    Effect.mapError(
      toDecodeError("SubtaskSummaryCacheRepository.get:decodeSummary", parentThreadId),
    ),
    Effect.map((summary) => ({
      key: {
        parentThreadId,
        sourceCutoffKey: row.source_cutoff_key,
        contentDigest: row.content_digest,
        strategyVersion: row.strategy_version,
      },
      summary,
      sourceRunId: row.source_run_id === null ? null : RunId.make(row.source_run_id),
      sourceOrdinal: row.source_ordinal,
      sourceMessageId:
        row.source_message_id === null ? null : MessageId.make(row.source_message_id),
      sourceTurnItemId:
        row.source_turn_item_id === null ? null : TurnItemId.make(row.source_turn_item_id),
      modelInstanceId:
        row.model_instance_id === null ? null : ProviderInstanceId.make(row.model_instance_id),
      modelSlug: row.model_slug,
      createdAt: IsoDateTime.make(row.created_at),
      updatedAt: IsoDateTime.make(row.updated_at),
      lastAccessedAt: IsoDateTime.make(row.last_accessed_at),
    })),
  );
};

export interface SubtaskSummaryCacheRepositoryShape {
  readonly get: (
    key: SubtaskSummaryCacheKey,
  ) => Effect.Effect<Option.Option<SubtaskSummaryCacheEntry>, SubtaskSummaryCacheRepositoryError>;
  readonly touch: (
    key: SubtaskSummaryCacheKey,
    accessedAt?: DateTime.Utc,
  ) => Effect.Effect<void, SubtaskSummaryCacheRepositoryError>;
  readonly put: (
    input: PutSubtaskSummaryCacheInput,
  ) => Effect.Effect<SubtaskSummaryCacheEntry, SubtaskSummaryCacheRepositoryError>;
  readonly deleteByParentThreadId: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<number, SubtaskSummaryCacheRepositoryError>;
  readonly pruneStale: (
    input: PruneSubtaskSummaryCacheInput,
  ) => Effect.Effect<number, SubtaskSummaryCacheRepositoryError>;
}

export class SubtaskSummaryCacheRepository extends Context.Service<
  SubtaskSummaryCacheRepository,
  SubtaskSummaryCacheRepositoryShape
>()("t3/persistence/SubtaskSummaryCache/SubtaskSummaryCacheRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get: SubtaskSummaryCacheRepositoryShape["get"] = Effect.fn(
    "SubtaskSummaryCacheRepository.get",
  )(function* (key) {
    const rows = yield* sql<SubtaskSummaryCacheRow>`
      SELECT
        parent_thread_id,
        source_cutoff_key,
        content_digest,
        strategy_version,
        summary_json,
        source_run_id,
        source_ordinal,
        source_message_id,
        source_turn_item_id,
        model_instance_id,
        model_slug,
        created_at,
        updated_at,
        last_accessed_at
      FROM subtask_summary_cache
      WHERE parent_thread_id = ${key.parentThreadId}
        AND source_cutoff_key = ${key.sourceCutoffKey}
        AND content_digest = ${key.contentDigest}
        AND strategy_version = ${key.strategyVersion}
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toSqlError("SubtaskSummaryCacheRepository.get", key.parentThreadId)),
    );
    const row = rows[0];
    if (row === undefined) {
      return Option.none();
    }
    return Option.some(yield* rowToEntry(row));
  });

  const touch: SubtaskSummaryCacheRepositoryShape["touch"] = Effect.fn(
    "SubtaskSummaryCacheRepository.touch",
  )(function* (key, accessedAt) {
    const nowIso = DateTime.formatIso(accessedAt ?? (yield* DateTime.now));
    yield* sql`
      UPDATE subtask_summary_cache
      SET last_accessed_at = ${nowIso}
      WHERE parent_thread_id = ${key.parentThreadId}
        AND source_cutoff_key = ${key.sourceCutoffKey}
        AND content_digest = ${key.contentDigest}
        AND strategy_version = ${key.strategyVersion}
    `.pipe(Effect.mapError(toSqlError("SubtaskSummaryCacheRepository.touch", key.parentThreadId)));
  });

  const put: SubtaskSummaryCacheRepositoryShape["put"] = Effect.fn(
    "SubtaskSummaryCacheRepository.put",
  )(function* (input) {
    const nowIso = IsoDateTime.make(DateTime.formatIso(input.now ?? (yield* DateTime.now)));
    const summaryJson = yield* encodeSummaryJson(input.summary).pipe(
      Effect.mapError(
        toDecodeError("SubtaskSummaryCacheRepository.put:encodeSummary", input.key.parentThreadId),
      ),
    );
    const sourceRunId = input.sourceRunId ?? null;
    const sourceOrdinal = input.sourceOrdinal ?? null;
    const sourceMessageId = input.sourceMessageId ?? null;
    const sourceTurnItemId = input.sourceTurnItemId ?? null;
    const modelInstanceId = input.modelInstanceId ?? null;
    const modelSlug = input.modelSlug ?? null;

    const rows = yield* sql<{ readonly created_at: string }>`
      INSERT INTO subtask_summary_cache (
        parent_thread_id,
        source_cutoff_key,
        content_digest,
        strategy_version,
        summary_json,
        source_run_id,
        source_ordinal,
        source_message_id,
        source_turn_item_id,
        model_instance_id,
        model_slug,
        created_at,
        updated_at,
        last_accessed_at
      ) VALUES (
        ${input.key.parentThreadId},
        ${input.key.sourceCutoffKey},
        ${input.key.contentDigest},
        ${input.key.strategyVersion},
        ${summaryJson},
        ${sourceRunId},
        ${sourceOrdinal},
        ${sourceMessageId},
        ${sourceTurnItemId},
        ${modelInstanceId},
        ${modelSlug},
        ${nowIso},
        ${nowIso},
        ${nowIso}
      )
      ON CONFLICT (parent_thread_id, source_cutoff_key, content_digest, strategy_version)
      DO UPDATE SET
        summary_json = excluded.summary_json,
        source_run_id = excluded.source_run_id,
        source_ordinal = excluded.source_ordinal,
        source_message_id = excluded.source_message_id,
        source_turn_item_id = excluded.source_turn_item_id,
        model_instance_id = excluded.model_instance_id,
        model_slug = excluded.model_slug,
        updated_at = excluded.updated_at,
        last_accessed_at = excluded.last_accessed_at
      RETURNING created_at
    `.pipe(
      Effect.mapError(toSqlError("SubtaskSummaryCacheRepository.put", input.key.parentThreadId)),
    );

    const createdAt = rows[0] ? IsoDateTime.make(rows[0].created_at) : nowIso;
    return {
      key: input.key,
      summary: input.summary,
      sourceRunId,
      sourceOrdinal,
      sourceMessageId,
      sourceTurnItemId,
      modelInstanceId,
      modelSlug,
      createdAt,
      updatedAt: nowIso,
      lastAccessedAt: nowIso,
    } satisfies SubtaskSummaryCacheEntry;
  });

  const deleteByParentThreadId: SubtaskSummaryCacheRepositoryShape["deleteByParentThreadId"] =
    Effect.fn("SubtaskSummaryCacheRepository.deleteByParentThreadId")(function* (parentThreadId) {
      const deleted = yield* sql<{ readonly parent_thread_id: string }>`
        DELETE FROM subtask_summary_cache
        WHERE parent_thread_id = ${parentThreadId}
        RETURNING parent_thread_id
      `.pipe(
        Effect.mapError(
          toSqlError("SubtaskSummaryCacheRepository.deleteByParentThreadId", parentThreadId),
        ),
      );
      return deleted.length;
    });

  const pruneStale: SubtaskSummaryCacheRepositoryShape["pruneStale"] = Effect.fn(
    "SubtaskSummaryCacheRepository.pruneStale",
  )(function* (input) {
    let deletedCount = 0;

    if (input.maxAgeBefore !== undefined) {
      const expired = yield* sql<{ readonly parent_thread_id: string }>`
        DELETE FROM subtask_summary_cache
        WHERE last_accessed_at < ${input.maxAgeBefore}
        RETURNING parent_thread_id
      `.pipe(Effect.mapError(toSqlError("SubtaskSummaryCacheRepository.pruneStale:maxAge")));
      deletedCount += expired.length;
    }

    if (input.maxEntries !== undefined) {
      const keepCount = Math.max(0, Math.floor(input.maxEntries));
      const evicted = yield* sql<{ readonly parent_thread_id: string }>`
        DELETE FROM subtask_summary_cache
        WHERE rowid IN (
          SELECT rowid
          FROM subtask_summary_cache
          ORDER BY last_accessed_at DESC, updated_at DESC, rowid DESC
          LIMIT -1 OFFSET ${keepCount}
        )
        RETURNING parent_thread_id
      `.pipe(Effect.mapError(toSqlError("SubtaskSummaryCacheRepository.pruneStale:maxEntries")));
      deletedCount += evicted.length;
    }

    return deletedCount;
  });

  return SubtaskSummaryCacheRepository.of({
    get,
    touch,
    put,
    deleteByParentThreadId,
    pruneStale,
  });
});

export const layer: Layer.Layer<SubtaskSummaryCacheRepository, never, SqlClient.SqlClient> =
  Layer.effect(SubtaskSummaryCacheRepository, make);

import { assert, describe, it } from "@effect/vitest";
import {
  IsoDateTime,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { SubtaskSummaryGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as PersistenceErrors from "./Errors.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import * as SubtaskSummaryCache from "./SubtaskSummaryCache.ts";

const layerTest = SubtaskSummaryCache.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const makeKey = (
  overrides?: Partial<SubtaskSummaryCache.SubtaskSummaryCacheKey>,
): SubtaskSummaryCache.SubtaskSummaryCacheKey => ({
  parentThreadId: ThreadId.make("thread-parent-1"),
  sourceCutoffKey: "run=run-1|ord=3|runs=1-1",
  contentDigest: "a".repeat(64),
  strategyVersion: "llm-summary-v1",
  ...overrides,
});

const SAMPLE_SUMMARY: SubtaskSummaryGenerationResult = {
  goal: "Ship versioned semantic summary cache",
  constraints: ["Do not reuse stale cache across streaming edits"],
  decisions: ["Composite PK includes cutoff, content digest, and strategy version"],
  openQuestions: ["Tune default LRU maxEntries in Phase 3"],
  keyAnchors: ["apps/server/src/persistence/SubtaskSummaryCache.ts"],
  summary: "Parent thread finalized P3-A1 and began implementing SQLite cache for P3-A2.",
};

describe("SubtaskSummaryCacheRepository", () => {
  it.effect("stores, loads, isolates versioned keys, and updates timestamps cleanly", () =>
    Effect.gen(function* () {
      const repo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
      const keyA = makeKey();
      const t1 = DateTime.makeUnsafe("2026-11-21T08:00:00.000Z");
      const t2 = DateTime.makeUnsafe("2026-11-21T08:05:00.000Z");
      const t3 = DateTime.makeUnsafe("2026-11-21T08:10:00.000Z");

      assert.isTrue(Option.isNone(yield* repo.get(keyA)));

      const inserted = yield* repo.put({
        key: keyA,
        summary: SAMPLE_SUMMARY,
        sourceRunId: RunId.make("run-1"),
        sourceOrdinal: 3,
        sourceMessageId: MessageId.make("msg-3"),
        sourceTurnItemId: TurnItemId.make("item-3"),
        modelInstanceId: ProviderInstanceId.make("codex"),
        modelSlug: "gpt-5.4-mini",
        now: t1,
      });

      assert.deepStrictEqual(inserted.key, keyA);
      assert.deepStrictEqual(inserted.summary, SAMPLE_SUMMARY);
      assert.strictEqual(inserted.sourceRunId, RunId.make("run-1"));
      assert.strictEqual(inserted.sourceOrdinal, 3);
      assert.strictEqual(inserted.sourceMessageId, MessageId.make("msg-3"));
      assert.strictEqual(inserted.sourceTurnItemId, TurnItemId.make("item-3"));
      assert.strictEqual(inserted.modelInstanceId, ProviderInstanceId.make("codex"));
      assert.strictEqual(inserted.modelSlug, "gpt-5.4-mini");
      assert.strictEqual(inserted.createdAt, IsoDateTime.make("2026-11-21T08:00:00.000Z"));
      assert.strictEqual(inserted.updatedAt, IsoDateTime.make("2026-11-21T08:00:00.000Z"));
      assert.strictEqual(inserted.lastAccessedAt, IsoDateTime.make("2026-11-21T08:00:00.000Z"));

      // Any single component change in the versioned composite key must miss.
      assert.isTrue(
        Option.isNone(yield* repo.get(makeKey({ parentThreadId: ThreadId.make("thread-other") }))),
      );
      assert.isTrue(Option.isNone(yield* repo.get(makeKey({ sourceCutoffKey: "run=run-2" }))));
      assert.isTrue(Option.isNone(yield* repo.get(makeKey({ contentDigest: "b".repeat(64) }))));
      assert.isTrue(Option.isNone(yield* repo.get(makeKey({ strategyVersion: "llm-summary-v2" }))));

      const loaded = yield* repo.get(keyA);
      assert.isTrue(Option.isSome(loaded));
      if (Option.isSome(loaded)) {
        assert.deepStrictEqual(loaded.value, inserted);
      }

      // touch updates lastAccessedAt only.
      yield* repo.touch(keyA, t2);
      const afterTouch = yield* repo.get(keyA);
      assert.isTrue(Option.isSome(afterTouch));
      if (Option.isSome(afterTouch)) {
        assert.strictEqual(
          afterTouch.value.createdAt,
          IsoDateTime.make("2026-11-21T08:00:00.000Z"),
        );
        assert.strictEqual(
          afterTouch.value.updatedAt,
          IsoDateTime.make("2026-11-21T08:00:00.000Z"),
        );
        assert.strictEqual(
          afterTouch.value.lastAccessedAt,
          IsoDateTime.make("2026-11-21T08:05:00.000Z"),
        );
      }

      // Upsert on identical composite key preserves createdAt and refreshes summary & timestamps.
      const updatedSummary: SubtaskSummaryGenerationResult = {
        ...SAMPLE_SUMMARY,
        summary: "Updated summary text after upsert.",
      };
      const upserted = yield* repo.put({
        key: keyA,
        summary: updatedSummary,
        modelInstanceId: ProviderInstanceId.make("claudeAgent"),
        modelSlug: "claude-haiku-4-5",
        now: t3,
      });
      assert.strictEqual(upserted.createdAt, IsoDateTime.make("2026-11-21T08:00:00.000Z"));
      assert.strictEqual(upserted.updatedAt, IsoDateTime.make("2026-11-21T08:10:00.000Z"));
      assert.strictEqual(upserted.lastAccessedAt, IsoDateTime.make("2026-11-21T08:10:00.000Z"));
      assert.deepStrictEqual(upserted.summary, updatedSummary);
      assert.strictEqual(upserted.modelInstanceId, ProviderInstanceId.make("claudeAgent"));
      assert.strictEqual(upserted.modelSlug, "claude-haiku-4-5");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("deletes entries by parent thread and prunes stale/LRU entries", () =>
    Effect.gen(function* () {
      const repo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
      const parent1 = ThreadId.make("thread-parent-a");
      const parent2 = ThreadId.make("thread-parent-b");

      const key1 = makeKey({
        parentThreadId: parent1,
        contentDigest: "1".repeat(64),
      });
      const key2 = makeKey({
        parentThreadId: parent1,
        contentDigest: "2".repeat(64),
      });
      const key3 = makeKey({
        parentThreadId: parent2,
        contentDigest: "3".repeat(64),
      });
      const key4 = makeKey({
        parentThreadId: parent2,
        contentDigest: "4".repeat(64),
      });

      yield* repo.put({
        key: key1,
        summary: SAMPLE_SUMMARY,
        now: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
      });
      yield* repo.put({
        key: key2,
        summary: SAMPLE_SUMMARY,
        now: DateTime.makeUnsafe("2026-11-10T00:00:00.000Z"),
      });
      yield* repo.put({
        key: key3,
        summary: SAMPLE_SUMMARY,
        now: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
      });
      yield* repo.put({
        key: key4,
        summary: SAMPLE_SUMMARY,
        now: DateTime.makeUnsafe("2026-11-20T00:00:00.000Z"),
      });

      // Prune entries older than 2026-11-05 -> removes key1 only.
      assert.strictEqual(
        yield* repo.pruneStale({ maxAgeBefore: IsoDateTime.make("2026-11-05T00:00:00.000Z") }),
        1,
      );
      assert.isTrue(Option.isNone(yield* repo.get(key1)));
      assert.isTrue(Option.isSome(yield* repo.get(key2)));

      // Touch key2 so it becomes newest, then keep maxEntries = 2 -> evicts key3 (oldest accessed).
      yield* repo.touch(key2, DateTime.makeUnsafe("2026-11-21T00:00:00.000Z"));
      assert.strictEqual(yield* repo.pruneStale({ maxEntries: 2 }), 1);
      assert.isTrue(Option.isNone(yield* repo.get(key3)));
      assert.isTrue(Option.isSome(yield* repo.get(key2)));
      assert.isTrue(Option.isSome(yield* repo.get(key4)));

      // Deleting by parent1 removes key2 only, leaving parent2's key4 intact.
      assert.strictEqual(yield* repo.deleteByParentThreadId(parent1), 1);
      assert.isTrue(Option.isNone(yield* repo.get(key2)));
      assert.isTrue(Option.isSome(yield* repo.get(key4)));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns correlated PersistenceDecodeError when cached JSON is corrupted", () =>
    Effect.gen(function* () {
      const repo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
      const sql = yield* SqlClient.SqlClient;
      const key = makeKey({ parentThreadId: ThreadId.make("thread-corrupt") });

      yield* repo.put({ key, summary: SAMPLE_SUMMARY });
      yield* sql`
        UPDATE subtask_summary_cache
        SET summary_json = ${"{not-valid-json"}
        WHERE parent_thread_id = ${key.parentThreadId}
      `;

      const error = yield* Effect.flip(repo.get(key));
      assert.instanceOf(error, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(error.correlation, { threadId: key.parentThreadId });
    }).pipe(Effect.provide(layerTest)),
  );
});

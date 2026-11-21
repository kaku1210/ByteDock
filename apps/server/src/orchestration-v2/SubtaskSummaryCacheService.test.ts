import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { SubtaskSummaryGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SubtaskSummaryCache from "../persistence/SubtaskSummaryCache.ts";
import * as SubtaskSummaryCacheService from "./SubtaskSummaryCacheService.ts";

const layerTest = SubtaskSummaryCacheService.layer.pipe(
  Layer.provideMerge(SubtaskSummaryCache.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const BASE_TIME = DateTime.makeUnsafe("2026-11-21T08:00:00.000Z");

const makeAssistantItem = (options: {
  readonly id: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly status?: OrchestrationV2TurnItem["status"];
}): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(options.id),
  threadId: ThreadId.make("thread-parent"),
  runId: RunId.make(options.runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: options.ordinal,
  status: options.status ?? "completed",
  title: null,
  startedAt: BASE_TIME,
  completedAt: BASE_TIME,
  updatedAt: BASE_TIME,
  type: "assistant_message",
  messageId: MessageId.make(`msg-${options.id}`),
  streaming: false,
  phase: "final_answer",
  text: options.text,
});

const SAMPLE_SUMMARY: SubtaskSummaryGenerationResult = {
  goal: "Implement Phase 3 cached semantic summaries",
  constraints: ["Single-flight concurrent deduplication"],
  decisions: ["Use SHA-256 content digest in composite cache key"],
  openQuestions: [],
  keyAnchors: ["apps/server/src/orchestration-v2/SubtaskSummaryCacheService.ts"],
  summary: "Cached semantic summary generated from parent cutoff.",
};

describe("SubtaskSummaryCacheService", () => {
  it("computes deterministic versioned keys that invalidate on content, cutoff, or strategy changes", () => {
    const parentThreadId = ThreadId.make("thread-parent");
    const baseInput: SubtaskSummaryCacheService.SubtaskSummaryCacheKeyInput = {
      parentThreadId,
      parentTitle: "Coordinate Phase 3",
      parentGoal: "Ship Track A",
      sourceAnchor: {
        sourceThreadId: parentThreadId,
        sourceRunId: RunId.make("run-5"),
        sourceOrdinal: 2,
        sourceMessageId: MessageId.make("msg-5"),
        excerpt: "Focus on P3-A2",
      },
      coveredRunOrdinals: { from: 1, to: 5 },
      parentItems: [
        makeAssistantItem({
          id: "item-1",
          runId: "run-5",
          ordinal: 2,
          text: "Initial assistant response",
        }),
      ],
      maxSummaryChars: 4_000,
    };

    const key1 = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey(baseInput);
    const key2 = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({ ...baseInput });
    assert.deepStrictEqual(key1, key2);
    assert.strictEqual(
      key1.strategyVersion,
      SubtaskSummaryCacheService.DEFAULT_SUBTASK_SUMMARY_STRATEGY_VERSION,
    );

    // Streaming update / edited content at the exact same (parentThreadId, sourceRunId) changes contentDigest.
    const streamed = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
      ...baseInput,
      parentItems: [
        makeAssistantItem({
          id: "item-1",
          runId: "run-5",
          ordinal: 2,
          text: "Initial assistant response + more streamed tokens",
        }),
      ],
    });
    assert.strictEqual(streamed.sourceCutoffKey, key1.sourceCutoffKey);
    assert.notStrictEqual(streamed.contentDigest, key1.contentDigest);

    // Status change (e.g. running -> completed) also changes contentDigest.
    const statusChanged = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
      ...baseInput,
      parentItems: [
        makeAssistantItem({
          id: "item-1",
          runId: "run-5",
          ordinal: 2,
          text: "Initial assistant response",
          status: "running",
        }),
      ],
    });
    assert.notStrictEqual(statusChanged.contentDigest, key1.contentDigest);

    // Rollback / retry removing an item changes contentDigest.
    const rolledBack = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
      ...baseInput,
      parentItems: [],
    });
    assert.notStrictEqual(rolledBack.contentDigest, key1.contentDigest);

    // Selected excerpt change changes contentDigest.
    const excerptChanged = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
      ...baseInput,
      sourceAnchor: { ...baseInput.sourceAnchor!, excerpt: "Different excerpt" },
    });
    assert.notStrictEqual(excerptChanged.contentDigest, key1.contentDigest);

    // Strategy version bump changes strategyVersion without changing contentDigest.
    const strategyChanged = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
      ...baseInput,
      strategyVersion: "llm-summary-v2",
    });
    assert.strictEqual(strategyChanged.contentDigest, key1.contentDigest);
    assert.notStrictEqual(strategyChanged.strategyVersion, key1.strategyVersion);
  });

  it.effect(
    "coalesces concurrent single-flight requests and serves subsequent calls from SQLite",
    () =>
      Effect.gen(function* () {
        const cache = yield* SubtaskSummaryCacheService.SubtaskSummaryCacheService;
        const key = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
          parentThreadId: ThreadId.make("thread-single-flight"),
          parentTitle: "Single Flight Test",
          coveredRunOrdinals: { from: 1, to: 2 },
          parentItems: [
            makeAssistantItem({ id: "i1", runId: "r1", ordinal: 1, text: "Context line" }),
          ],
        });

        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let generateCalls = 0;

        const makeCall = () =>
          cache.getOrGenerate({
            key,
            metadata: { sourceRunId: RunId.make("r1"), sourceOrdinal: 1 },
            generate: Effect.gen(function* () {
              generateCalls += 1;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return {
                summary: SAMPLE_SUMMARY,
                modelInstanceId: ProviderInstanceId.make("codex"),
                modelSlug: "gpt-5.4-mini",
              };
            }),
          });

        const fibers = yield* Effect.all(
          Array.from({ length: 5 }, () => Effect.forkChild(makeCall())),
        );
        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);

        const results = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber));
        assert.strictEqual(generateCalls, 1);
        assert.strictEqual(results.filter((result) => result.outcome === "generated").length, 1);
        assert.strictEqual(results.filter((result) => result.outcome === "coalesced").length, 4);
        for (const result of results) {
          assert.deepStrictEqual(result.entry.summary, SAMPLE_SUMMARY);
        }

        // Subsequent call hits persisted SQLite cache without invoking generate.
        const hit = yield* cache.getOrGenerate({
          key,
          generate: Effect.die("generate should not run on cache hit"),
        });
        assert.strictEqual(hit.outcome, "cache_hit");
        assert.deepStrictEqual(hit.entry.summary, SAMPLE_SUMMARY);
        assert.strictEqual(generateCalls, 1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("runs distinct versioned keys concurrently without blocking each other", () =>
    Effect.gen(function* () {
      const cache = yield* SubtaskSummaryCacheService.SubtaskSummaryCacheService;
      const keyA = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
        parentThreadId: ThreadId.make("thread-parallel"),
        parentTitle: "Parallel Test",
        coveredRunOrdinals: { from: 1, to: 1 },
        parentItems: [makeAssistantItem({ id: "i1", runId: "r1", ordinal: 1, text: "A" })],
      });
      const keyB = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
        parentThreadId: ThreadId.make("thread-parallel"),
        parentTitle: "Parallel Test",
        coveredRunOrdinals: { from: 1, to: 1 },
        parentItems: [makeAssistantItem({ id: "i1", runId: "r1", ordinal: 1, text: "B" })],
      });

      const aStarted = yield* Deferred.make<void>();
      const bStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const fiberA = yield* Effect.forkChild(
        cache.getOrGenerate({
          key: keyA,
          generate: Effect.gen(function* () {
            yield* Deferred.succeed(aStarted, undefined);
            yield* Deferred.await(release);
            return { summary: { ...SAMPLE_SUMMARY, goal: "Goal A" } };
          }),
        }),
      );
      const fiberB = yield* Effect.forkChild(
        cache.getOrGenerate({
          key: keyB,
          generate: Effect.gen(function* () {
            yield* Deferred.succeed(bStarted, undefined);
            yield* Deferred.await(release);
            return { summary: { ...SAMPLE_SUMMARY, goal: "Goal B" } };
          }),
        }),
      );

      // Both must start concurrently before release is signalled.
      yield* Deferred.await(aStarted);
      yield* Deferred.await(bStarted);
      yield* Deferred.succeed(release, undefined);

      const [resA, resB] = yield* Effect.all([Fiber.join(fiberA), Fiber.join(fiberB)]);
      assert.strictEqual(resA.entry.summary.goal, "Goal A");
      assert.strictEqual(resB.entry.summary.goal, "Goal B");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("propagates typed errors to coalesced callers without negative-caching failures", () =>
    Effect.gen(function* () {
      const cache = yield* SubtaskSummaryCacheService.SubtaskSummaryCacheService;
      const repo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
      const key = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
        parentThreadId: ThreadId.make("thread-failure"),
        parentTitle: "Failure Test",
        coveredRunOrdinals: { from: 1, to: 1 },
        parentItems: [],
      });

      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;

      const failingCall = () =>
        cache.getOrGenerate({
          key,
          generate: Effect.gen(function* () {
            calls += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* new TextGenerationError({
              operation: "generateSubtaskSummary",
              detail: "provider timeout",
            });
          }),
        });

      const fiber1 = yield* Effect.forkChild(failingCall());
      yield* Deferred.await(started);
      const fiber2 = yield* Effect.forkChild(failingCall());
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);

      const [exit1, exit2] = yield* Effect.all([Fiber.await(fiber1), Fiber.await(fiber2)]);
      assert.strictEqual(calls, 1);
      assert.isTrue(Exit.isFailure(exit1));
      assert.isTrue(Exit.isFailure(exit2));
      assert.isTrue(Option.isNone(yield* repo.get(key)));

      // Next call retries fresh and succeeds.
      const recovered = yield* cache.getOrGenerate({
        key,
        generate: Effect.succeed({ summary: SAMPLE_SUMMARY }),
      });
      assert.strictEqual(recovered.outcome, "generated");
      assert.deepStrictEqual(recovered.entry.summary, SAMPLE_SUMMARY);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "hands off leadership cleanly when leader is interrupted and isolates follower cancellation",
    () =>
      Effect.gen(function* () {
        const cache = yield* SubtaskSummaryCacheService.SubtaskSummaryCacheService;
        const key = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
          parentThreadId: ThreadId.make("thread-interrupt"),
          parentTitle: "Interrupt Handoff Test",
          coveredRunOrdinals: { from: 1, to: 1 },
          parentItems: [],
        });

        const leaderStarted = yield* Deferred.make<void>();
        const followerTakeoverStarted = yield* Deferred.make<void>();
        const releaseTakeover = yield* Deferred.make<void>();
        let attempt = 0;

        const call = () =>
          cache.getOrGenerate({
            key,
            generate: Effect.gen(function* () {
              attempt += 1;
              if (attempt === 1) {
                yield* Deferred.succeed(leaderStarted, undefined);
                return yield* Effect.never;
              }
              yield* Deferred.succeed(followerTakeoverStarted, undefined);
              yield* Deferred.await(releaseTakeover);
              return { summary: SAMPLE_SUMMARY };
            }),
          });

        const leaderFiber = yield* Effect.forkChild(call());
        yield* Deferred.await(leaderStarted);

        const followerSurviving = yield* Effect.forkChild(call());
        const followerCancelled = yield* Effect.forkChild(call());
        yield* Effect.yieldNow;

        // Interrupt one follower first: must not interrupt leader or surviving follower.
        yield* Fiber.interrupt(followerCancelled);
        assert.strictEqual(attempt, 1);

        // Now interrupt leader: surviving follower must take over leadership and succeed.
        yield* Fiber.interrupt(leaderFiber);
        yield* Deferred.await(followerTakeoverStarted);
        yield* Deferred.succeed(releaseTakeover, undefined);

        const result = yield* Fiber.join(followerSurviving);
        assert.strictEqual(attempt, 2);
        assert.strictEqual(result.outcome, "generated");
        assert.deepStrictEqual(result.entry.summary, SAMPLE_SUMMARY);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("recovers gracefully when a cached SQLite row contains corrupted JSON", () =>
    Effect.gen(function* () {
      const cache = yield* SubtaskSummaryCacheService.SubtaskSummaryCacheService;
      const repo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
      const sql = yield* SqlClient.SqlClient;
      const key = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
        parentThreadId: ThreadId.make("thread-corrupt-recover"),
        parentTitle: "Corrupt Row Recovery",
        coveredRunOrdinals: { from: 1, to: 1 },
        parentItems: [],
      });

      yield* repo.put({ key, summary: SAMPLE_SUMMARY });
      yield* sql`
        UPDATE subtask_summary_cache
        SET summary_json = ${"corrupt-json"}
        WHERE parent_thread_id = ${key.parentThreadId}
      `;

      const regenerated: SubtaskSummaryGenerationResult = {
        ...SAMPLE_SUMMARY,
        summary: "Regenerated cleanly after corrupt row",
      };
      const result = yield* cache.getOrGenerate({
        key,
        generate: Effect.succeed({ summary: regenerated }),
      });
      assert.strictEqual(result.outcome, "generated");
      assert.deepStrictEqual(result.entry.summary, regenerated);

      // Subsequent lookup now succeeds cleanly from SQLite.
      const next = yield* cache.getOrGenerate({
        key,
        generate: Effect.die("should hit repaired SQLite row"),
      });
      assert.strictEqual(next.outcome, "cache_hit");
      assert.deepStrictEqual(next.entry.summary, regenerated);
    }).pipe(Effect.provide(layerTest)),
  );
});

import { assert, describe, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type {
  SubtaskSummaryGenerationInput,
  SubtaskSummaryGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SubtaskSummaryCache from "../persistence/SubtaskSummaryCache.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";
import * as SubtaskSummaryCacheService from "./SubtaskSummaryCacheService.ts";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.effect("caps the side chat context block without summarizing discarded parent history", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:side-chat-parent");
    let summarizedItems = 0;
    const parentItems = Array.from({ length: 60 }, (_, index) => ({
      ...importedItem({
        role: index % 2 === 0 ? "user" : "assistant",
        id: `parent-${index}`,
        text: `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`,
        ordinal: index,
      }),
      get text() {
        summarizedItems++;
        return `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`;
      },
    }));
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareSideChatContext({
      parentThreadId,
      threadId: ThreadId.make("thread:side-chat"),
      targetRunId: RunId.make("run:side-chat"),
      transferId: ContextTransferId.make("transfer:side-chat"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:side-chat"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems,
      createdAt: DateTime.makeUnsafe(0),
    });
    const context = handoff.summaryText;
    assert.isBelow(summarizedItems, parentItems.length);

    assert.include(context, "- Earlier items truncated.");
    assert.notInclude(context, "item-0 ");
    assert.include(context, "- Assistant: item-59 ");
    assert.isAtMost(context.length, 8_000);
    assert.isTrue(context.isWellFormed());
    assert.isTrue(
      context.endsWith(
        `Use t3_thread_read on thread ${parentThreadId} to see the main thread's live state.`,
      ),
    );

    const framingOnly = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [],
    });
    assert.isTrue(framingOnly.startsWith("You are in a side chat beside the main thread."));
    assert.notInclude(framingOnly, "Main thread activity");

    const multiFilePatch = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [
        {
          id: TurnItemId.make("turn-item:patch"),
          threadId: parentThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 60,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe(0),
          type: "file_change",
          fileName: "src/a.ts",
          changes: [
            { operation: "update", path: "src/a.ts" },
            { operation: "add", path: "src/b.ts" },
            { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
          ],
        },
      ],
    });
    assert.include(multiFilePatch, "- File change: src/a.ts, src/b.ts, src/new.ts");
  }).pipe(Effect.provide(layerTest)),
);

it("covers the run range of a very long delta", () => {
  const runs = [
    { id: RunId.make("run:long-delta-early"), ordinal: 2 },
    { id: RunId.make("run:long-delta-late"), ordinal: 5 },
  ];
  const items = Array.from({ length: 150_000 }, (_, index) => ({
    runId: runs[index % 2]!.id,
  }));

  assert.deepEqual(
    ContextHandoffService.visibleDeltaRunOrdinals({ runs }, [...items, { runId: null }]),
    { from: 2, to: 5 },
  );
});

it.effect("inherited history stops at a missing fork ancestor", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const threadId = ThreadId.make("thread:fork-of-missing");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:fork-of-missing"),
      title: "Fork of a missing thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: {
        type: "run",
        threadId: ThreadId.make("thread:missing-ancestor"),
        runId: RunId.make("run:missing-ancestor"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
    };
    const items = yield* ContextHandoffService.readInheritedHandoffItems(
      {
        getForkSourceRunIds: () => Effect.succeed([]),
        getThreadRecords: (missing) =>
          Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: missing })),
      },
      thread,
    );
    assert.deepEqual(items, []);
  }),
);

it.effect("builds a budgeted subtask skeleton without side chat framing", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:subtask-parent");
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const parentItems = Array.from({ length: 50 }, (_, index) =>
      importedItem({
        role: index % 2 === 0 ? "user" : "assistant",
        id: `subtask-parent-${index}`,
        text: `entry-${index} ${"y".repeat(220)}`,
        ordinal: index,
      }),
    );
    const handoff = yield* service.prepareSubtaskContext({
      parentThreadId,
      parentTitle: "Main refactor thread",
      parentGoal: "Ship unified subtask orchestration",
      sourceAnchor: {
        sourceThreadId: parentThreadId,
        sourceRunId: RunId.make("run:cutoff-1"),
        sourceOrdinal: 1,
        excerpt: "Refactor storage migration for parentThreadId",
      },
      threadId: ThreadId.make("thread:subtask-child"),
      targetRunId: RunId.make("run:subtask-first"),
      transferId: ContextTransferId.make("transfer:subtask-fork"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:subtask"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems,
      createdAt: DateTime.makeUnsafe(0),
    });

    assert.equal(handoff.strategy, "manual_context");
    assert.isUndefined(handoff.history);
    assert.isAtMost(handoff.summaryText.length, 8_000);
    assert.include(handoff.summaryText, "dedicated subtask branched from parent thread");
    assert.notInclude(handoff.summaryText, "do not continue or redo the main thread's task");
    assert.include(handoff.summaryText, "Parent goal: Ship unified subtask orchestration");
    assert.include(
      handoff.summaryText,
      "Selected excerpt: Refactor storage migration for parentThreadId",
    );
    assert.include(handoff.summaryText, "Source cutoff: run=run:cutoff-1, ordinal=1");
    assert.include(handoff.summaryText, "- Earlier items truncated.");
    assert.include(handoff.summaryText, "entry-49");
    assert.include(handoff.summaryText, `t3_thread_read({ threadId: "${parentThreadId}"`);
  }).pipe(Effect.provide(layerTest)),
);

describe("Subtask cached semantic summary & fallback (P3-A3)", () => {
  const makeSemanticLayer = (
    generateSubtaskSummary: (
      input: SubtaskSummaryGenerationInput,
    ) => Effect.Effect<SubtaskSummaryGenerationResult, TextGenerationError>,
  ) => {
    const cacheRepoLayer = SubtaskSummaryCache.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
    );
    const cacheServiceLayer = SubtaskSummaryCacheService.layer.pipe(
      Layer.provideMerge(cacheRepoLayer),
    );
    const textGenerationLayer = Layer.mock(TextGeneration.TextGeneration)({
      generateSubtaskSummary,
    });
    const handoffLayer = ContextHandoffService.layer.pipe(
      Layer.provide(Layer.mergeAll(IdAllocator.layer, cacheServiceLayer, textGenerationLayer)),
    );
    return Layer.mergeAll(handoffLayer, cacheServiceLayer);
  };

  const baseSubtaskInput = (
    parentThreadId: ThreadId,
    childSuffix: string,
    parentItems: ReadonlyArray<OrchestrationV2TurnItem>,
  ) => ({
    parentThreadId,
    parentTitle: "Main refactor thread",
    parentGoal: "Ship unified subtask orchestration",
    sourceAnchor: {
      sourceThreadId: parentThreadId,
      sourceRunId: RunId.make("run:cutoff-semantic-1"),
      sourceOrdinal: 1,
      sourceTurnItemId: parentItems.at(-1)?.id,
      excerpt: "Keep t3_thread_read back-references intact",
    },
    threadId: ThreadId.make(`thread:subtask-${childSuffix}`),
    targetRunId: RunId.make(`run:subtask-${childSuffix}`),
    transferId: ContextTransferId.make(`transfer:subtask-${childSuffix}`),
    toProviderThreadId: ProviderThreadId.make(`provider-thread:${childSuffix}`),
    fromProviderInstanceId: ProviderInstanceId.make("codex"),
    toProviderInstanceId: ProviderInstanceId.make("codex"),
    coveredRunOrdinals: { from: 1, to: 1 },
    parentItems,
    createdAt: DateTime.makeUnsafe("2026-11-21T08:00:00.000Z"),
    cwd: "/workspace/project",
    projectId: ProjectId.make("proj:semantic"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-mini",
    },
  });

  it.effect(
    "generates structured semantic summary, caches it in SQLite, reuses on sibling subtask, and preserves t3_thread_read anchor",
    () => {
      let calls = 0;
      const seenInputs: Array<SubtaskSummaryGenerationInput> = [];
      const layer = makeSemanticLayer((input) => {
        calls += 1;
        seenInputs.push(input);
        return Effect.succeed({
          goal: "Ship cached semantic summaries for subtasks",
          constraints: ["Preserve t3_thread_read anchor", "Stay under 8000 chars"],
          decisions: ["Use composite SQLite primary key with content digest"],
          openQuestions: ["Tune default prune TTL after telemetry"],
          keyAnchors: [
            "apps/server/src/orchestration-v2/ContextHandoffService.ts",
            "item=turn-item:p-2",
          ],
          summary: "Parent established schema and single-flight cache; subtask implements wiring.",
        });
      });

      return Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const parentThreadId = ThreadId.make("thread:semantic-parent");
        const parentItems = [
          importedItem({
            role: "user",
            id: "p-1",
            text: "Build cached subtask summary with fallback",
            ordinal: 1,
          }),
          importedItem({
            role: "assistant",
            id: "p-2",
            text: "Agreed: preserve t3_thread_read anchor and content digest invalidation.",
            ordinal: 2,
          }),
        ];

        const first = yield* service.prepareSubtaskContext(
          baseSubtaskInput(parentThreadId, "a", parentItems),
        );
        const second = yield* service.prepareSubtaskContext(
          baseSubtaskInput(parentThreadId, "b", parentItems),
        );

        assert.equal(calls, 1);
        assert.equal(seenInputs.length, 1);
        assert.equal(seenInputs[0]!.cwd, "/workspace/project");
        assert.include(seenInputs[0]!.conversationExcerpt, "item=turn-item:p-2");

        assert.include(
          first.summaryText,
          "Context summary mode: semantic (llm-summary-v1, generated, model=codex/gpt-5.4-mini)",
        );
        assert.include(first.summaryText, "Goal: Ship cached semantic summaries for subtasks");
        assert.include(first.summaryText, "Constraints:\n- Preserve t3_thread_read anchor");
        assert.include(
          first.summaryText,
          "Decisions:\n- Use composite SQLite primary key with content digest",
        );
        assert.include(
          first.summaryText,
          "Open questions:\n- Tune default prune TTL after telemetry",
        );
        assert.include(
          first.summaryText,
          "Key anchors:\n- apps/server/src/orchestration-v2/ContextHandoffService.ts",
        );
        assert.include(
          first.summaryText,
          `t3_thread_read({ threadId: "${parentThreadId}", view: "activity" })`,
        );
        assert.include(first.summaryText, "item=turn-item:p-2");

        assert.include(
          second.summaryText,
          "Context summary mode: semantic (llm-summary-v1, cache_hit, model=codex/gpt-5.4-mini)",
        );
        assert.include(second.summaryText, "Goal: Ship cached semantic summaries for subtasks");
        assert.include(
          second.summaryText,
          `t3_thread_read({ threadId: "${parentThreadId}", view: "activity" })`,
        );

        // Mutating parent content at the same sourceRunId invalidates via content_digest.
        const updatedItems = [
          parentItems[0]!,
          importedItem({
            role: "assistant",
            id: "p-2",
            text: "Updated streaming response with additional constraint.",
            ordinal: 2,
          }),
        ];
        const third = yield* service.prepareSubtaskContext(
          baseSubtaskInput(parentThreadId, "c", updatedItems),
        );
        assert.equal(calls, 2);
        assert.include(third.summaryText, "generated");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "coalesces concurrent prepareSubtaskContext calls for the same parent cutoff into one LLM call",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const layer = makeSemanticLayer(() =>
          Effect.gen(function* () {
            calls += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return {
              goal: "Coalesced goal",
              constraints: [],
              decisions: ["Single-flight active"],
              openQuestions: [],
              keyAnchors: ["run=run:cutoff-semantic-1"],
              summary: "Generated once for both concurrent subtasks.",
            };
          }),
        );

        return yield* Effect.gen(function* () {
          const service = yield* ContextHandoffService.ContextHandoffServiceV2;
          const parentThreadId = ThreadId.make("thread:concurrent-parent");
          const parentItems = [
            importedItem({
              role: "user",
              id: "c-1",
              text: "Run two subtasks in parallel",
              ordinal: 1,
            }),
          ];

          const f1 = yield* Effect.forkChild(
            service.prepareSubtaskContext(baseSubtaskInput(parentThreadId, "c1", parentItems)),
          );
          yield* Deferred.await(started);
          const f2 = yield* Effect.forkChild(
            service.prepareSubtaskContext(baseSubtaskInput(parentThreadId, "c2", parentItems)),
          );
          yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);

          const [r1, r2] = yield* Effect.all([Fiber.join(f1), Fiber.join(f2)]);
          assert.equal(calls, 1);
          assert.include(r1.summaryText, "Coalesced goal");
          assert.include(r2.summaryText, "Coalesced goal");
          const outcomes = [r1.summaryText, r2.summaryText];
          assert.isTrue(outcomes.some((text) => text.includes(", generated,")));
          assert.isTrue(outcomes.some((text) => text.includes(", coalesced,")));
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "degrades to MVP skeleton with timeout reason and t3_thread_read anchor when LLM summary times out",
    () => {
      const layer = makeSemanticLayer(() =>
        Effect.sleep("10 seconds").pipe(
          Effect.as({
            goal: "Too late",
            constraints: [],
            decisions: [],
            openQuestions: [],
            keyAnchors: [],
            summary: "Should not be returned after timeout",
          }),
        ),
      );

      return Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const cacheRepo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
        const parentThreadId = ThreadId.make("thread:timeout-parent");
        const parentItems = [
          importedItem({
            role: "user",
            id: "t-1",
            text: "PARENT_FALLBACK_CONTENT_ON_TIMEOUT",
            ordinal: 1,
          }),
        ];
        const input = {
          ...baseSubtaskInput(parentThreadId, "timeout", parentItems),
          summaryTimeoutMs: 500,
        };

        const fiber = yield* Effect.forkChild(service.prepareSubtaskContext(input));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const handoff = yield* Fiber.join(fiber);

        assert.include(
          handoff.summaryText,
          "Context summary fallback: mvp_skeleton (reason=timeout:",
        );
        assert.include(handoff.summaryText, "PARENT_FALLBACK_CONTENT_ON_TIMEOUT");
        assert.include(
          handoff.summaryText,
          `t3_thread_read({ threadId: "${parentThreadId}", view: "activity" })`,
        );
        assert.include(handoff.summaryText, "item=turn-item:t-1");

        const key = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
          parentThreadId,
          parentTitle: input.parentTitle,
          parentGoal: input.parentGoal,
          sourceAnchor: input.sourceAnchor,
          coveredRunOrdinals: input.coveredRunOrdinals,
          parentItems,
          maxSummaryChars: 8_000,
        });
        assert.isTrue(Option.isNone(yield* cacheRepo.get(key)));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "degrades to MVP skeleton with model_unavailable reason when TextGeneration fails",
    () => {
      const layer = makeSemanticLayer(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateSubtaskSummary",
            detail: "Provider codex is unauthenticated.",
          }),
        ),
      );

      return Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const parentThreadId = ThreadId.make("thread:unavailable-parent");
        const parentItems = [
          importedItem({
            role: "user",
            id: "u-1",
            text: "PARENT_FALLBACK_CONTENT_ON_MODEL_ERROR",
            ordinal: 1,
          }),
        ];
        const handoff = yield* service.prepareSubtaskContext(
          baseSubtaskInput(parentThreadId, "unavail", parentItems),
        );

        assert.include(
          handoff.summaryText,
          "Context summary fallback: mvp_skeleton (reason=model_unavailable:",
        );
        assert.include(handoff.summaryText, "PARENT_FALLBACK_CONTENT_ON_MODEL_ERROR");
        assert.include(
          handoff.summaryText,
          `t3_thread_read({ threadId: "${parentThreadId}", view: "activity" })`,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "degrades to MVP skeleton with budget_exceeded reason when LLM output exceeds budget or budget is too small",
    () => {
      let calls = 0;
      const layer = makeSemanticLayer(() => {
        calls += 1;
        return Effect.succeed({
          goal: "Oversized summary test",
          constraints: ["Keep bounded"],
          decisions: [],
          openQuestions: [],
          keyAnchors: [],
          summary: "Z".repeat(9_000),
        });
      });

      return Effect.gen(function* () {
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const cacheRepo = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
        const parentThreadId = ThreadId.make("thread:budget-parent");
        const parentItems = [
          importedItem({
            role: "user",
            id: "b-1",
            text: "PARENT_FALLBACK_CONTENT_ON_BUDGET",
            ordinal: 1,
          }),
        ];

        // Case 1: LLM output overflows maxSummaryChars -> fallback & do not cache oversized result.
        const inputOversized = {
          ...baseSubtaskInput(parentThreadId, "budget-oversized", parentItems),
          maxSummaryChars: 2_000,
        };
        const oversizedHandoff = yield* service.prepareSubtaskContext(inputOversized);
        assert.equal(calls, 1);
        assert.isAtMost(oversizedHandoff.summaryText.length, 2_000);
        assert.include(
          oversizedHandoff.summaryText,
          "Context summary fallback: mvp_skeleton (reason=budget_exceeded:",
        );
        assert.include(oversizedHandoff.summaryText, "PARENT_FALLBACK_CONTENT_ON_BUDGET");
        assert.include(
          oversizedHandoff.summaryText,
          `t3_thread_read({ threadId: "${parentThreadId}", view: "activity" })`,
        );

        const oversizedKey = SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
          parentThreadId,
          parentTitle: inputOversized.parentTitle,
          parentGoal: inputOversized.parentGoal,
          sourceAnchor: inputOversized.sourceAnchor,
          coveredRunOrdinals: inputOversized.coveredRunOrdinals,
          parentItems,
          maxSummaryChars: 2_000,
        });
        assert.isTrue(Option.isNone(yield* cacheRepo.get(oversizedKey)));

        // Case 2: maxSummaryChars too tight for semantic wrapper -> short-circuits without LLM call.
        const tightHandoff = yield* service.prepareSubtaskContext({
          ...baseSubtaskInput(parentThreadId, "budget-tight", parentItems),
          maxSummaryChars: 420,
        });
        assert.equal(calls, 1);
        assert.isAtMost(tightHandoff.summaryText.length, 420);
        assert.include(tightHandoff.summaryText, "reason=budget_exceeded");
        assert.include(
          tightHandoff.summaryText,
          `t3_thread_read({ threadId: "${parentThreadId}", view: "activity" })`,
        );
      }).pipe(Effect.provide(layer));
    },
  );
});

const clearNow = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const clearAncestorId = ThreadId.make("thread:ancestor-before-clear");
const clearSourceId = ThreadId.make("thread:source-with-clear");
const clearAncestorRunId = RunId.make("run:ancestor-1");

function clearRun(id: RunId, threadId: ThreadId, ordinal: number, freshContext?: boolean) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: ProviderThreadId.make(`pt:${id}`),
    userMessageId: MessageId.make(`msg:${id}`),
    rootNodeId: null as never,
    activeAttemptId: null,
    status: "completed" as const,
    queuePosition: null,
    requestedAt: clearNow,
    startedAt: clearNow,
    completedAt: clearNow,
    checkpointId: null,
    contextHandoffId: null,
    ...(freshContext ? { freshContext: true } : {}),
  };
}

function clearUserItem(
  id: string,
  threadId: ThreadId,
  runId: RunId,
  text: string,
  ordinal: number,
  scheduledTaskId?: string,
) {
  return {
    ...importedItem({ role: "user", id, text, ordinal }),
    threadId,
    runId,
    ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
  } as OrchestrationV2TurnItem;
}

function clearThread(
  id: ThreadId,
  forkedFrom: OrchestrationV2AppThread["forkedFrom"],
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:clear-fork"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: clearAncestorId },
    forkedFrom,
    createdAt: clearNow,
    updatedAt: clearNow,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
  };
}

/** Portable fork history of a source forked from an ancestor, through its last run. */
const readClearFork = Effect.fn(function* (
  sourceRuns: ReadonlyArray<ReturnType<typeof clearRun>>,
  sourceItems: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const sourceThread = clearThread(clearSourceId, {
    type: "run",
    threadId: clearAncestorId,
    runId: clearAncestorRunId,
  });
  const fork = clearThread(ThreadId.make("thread:clear-fork"), {
    type: "run",
    threadId: clearSourceId,
    runId: sourceRuns.at(-1)!.id,
  });
  const store = {
    getForkSourceRunIds: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === clearSourceId ? [clearAncestorRunId] : sourceRuns.map((run) => run.id),
      ),
    getThreadRecords: (threadId: ThreadId) =>
      Effect.succeed(
        (threadId === clearAncestorId
          ? {
              thread: clearThread(clearAncestorId, null),
              runs: [clearRun(clearAncestorRunId, clearAncestorId, 1)],
              attempts: [],
              turnItems: [
                clearUserItem("anc", clearAncestorId, clearAncestorRunId, "ancestor history", 1),
              ],
            }
          : {
              thread: sourceThread,
              runs: sourceRuns,
              attempts: [],
              turnItems: sourceItems,
            }) as never,
      ),
  };
  const items = yield* ContextHandoffService.readForkHistoryItems(
    store as never,
    { thread: sourceThread, runs: sourceRuns, attempts: [] } as never,
    sourceRuns.at(-1)!,
    fork,
  );
  return items.map((item) => (item.type === "user_message" ? item.text : ""));
});

it.effect("portable fork history stops at /clear (freshContext) and drops ancestor history", () =>
  Effect.gen(function* () {
    const before = RunId.make("run:source-1");
    const clear = RunId.make("run:source-2-clear");
    const texts = yield* readClearFork(
      [clearRun(before, clearSourceId, 1), clearRun(clear, clearSourceId, 2, true)],
      [
        clearUserItem("old", clearSourceId, before, "before clear", 1),
        clearUserItem("new", clearSourceId, clear, "after clear", 2),
      ],
    );
    assert.deepEqual(texts, ["after clear"]);
  }),
);

it.effect("portable fork history keeps history past a restarted scheduled fresh run", () =>
  Effect.gen(function* () {
    const before = RunId.make("run:source-1");
    const scheduled = RunId.make("run:source-2-scheduled");
    const after = RunId.make("run:source-3");
    // A steering restart points userMessageId at the steer, which carries no scheduledTaskId.
    const scheduledRun = {
      ...clearRun(scheduled, clearSourceId, 2, true),
      userMessageId: MessageId.make("message:steer"),
    };
    const texts = yield* readClearFork(
      [clearRun(before, clearSourceId, 1), scheduledRun, clearRun(after, clearSourceId, 3)],
      [
        clearUserItem("old", clearSourceId, before, "before schedule", 1),
        clearUserItem("sched", clearSourceId, scheduled, "scheduled prompt", 2, "task-1"),
        clearUserItem("steer", clearSourceId, scheduled, "steer", 3),
        clearUserItem("new", clearSourceId, after, "after schedule", 4),
      ],
    );
    assert.deepEqual(texts, [
      "ancestor history",
      "before schedule",
      "scheduled prompt",
      "steer",
      "after schedule",
    ]);
  }),
);

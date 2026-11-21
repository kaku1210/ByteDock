import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";
import { buildSubtaskSummaryPrompt, SubtaskSummaryOutputSchema } from "./textGenerationPrompts.ts";
import { toJsonSchemaObject } from "./textGenerationUtils.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

it.effect("generates and normalizes structured subtask summary output", () =>
  Effect.gen(function* () {
    let capturedPrompt = "";
    let capturedOperation = "";
    const textGeneration = fromRunner("Stub", (request) => {
      capturedPrompt = request.prompt;
      capturedOperation = request.operation;
      return decodeJsonReply(
        request,
        "Stub",
        JSON.stringify({
          goal: "  Implement Phase 3 cached semantic summaries  ",
          constraints: [
            " Do not break Phase 1/2 snapshot formats ",
            "",
            "Do not break Phase 1/2 snapshot formats",
            "Fallback to extractive summary on LLM failure",
          ],
          decisions: [" Use SQLite versioned cache ", "Use SQLite versioned cache"],
          openQuestions: ["  Should cache TTL be configurable?  ", "   "],
          keyAnchors: [
            "apps/server/src/textGeneration/TextGeneration.ts",
            "apps/server/src/textGeneration/TextGeneration.ts",
            "  packages/provider-core/src/server/textGenerationPrompts.ts  ",
          ],
          summary:
            "  Parent thread completed Phase 2 and scoped Phase 3 Track A around TextGeneration.  ",
        }),
      );
    });

    const result = yield* textGeneration.generateSubtaskSummary({
      cwd: process.cwd(),
      parentThreadId: "thread-parent-1",
      parentTitle: "Phase 3 Subtask Coordination",
      parentGoal: "Design cached semantic summary handoff",
      sourceCutoff: "turn:turn-12",
      selectedExcerpt: "Keep P3-A1 scoped to TextGeneration interfaces",
      conversationExcerpt: "User: Let's implement P3-A1 first.\nAssistant: Agreed.",
      maxSummaryChars: 2400,
      strategyVersion: "llm-summary-v1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4-mini",
      },
    });

    assert.strictEqual(capturedOperation, "generateSubtaskSummary");
    assert.include(capturedPrompt, "Parent thread: Phase 3 Subtask Coordination (thread-parent-1)");
    assert.include(capturedPrompt, "Summary strategy version: llm-summary-v1");
    assert.include(capturedPrompt, "Source cutoff: turn:turn-12");
    assert.include(capturedPrompt, "Parent goal: Design cached semantic summary handoff");
    assert.include(
      capturedPrompt,
      "Selected excerpt: Keep P3-A1 scoped to TextGeneration interfaces",
    );
    assert.include(capturedPrompt, "BEGIN PARENT CONVERSATION REFERENCE");
    assert.include(capturedPrompt, "END PARENT CONVERSATION REFERENCE");
    assert.deepStrictEqual(result, {
      goal: "Implement Phase 3 cached semantic summaries",
      constraints: [
        "Do not break Phase 1/2 snapshot formats",
        "Fallback to extractive summary on LLM failure",
      ],
      decisions: ["Use SQLite versioned cache"],
      openQuestions: ["Should cache TTL be configurable?"],
      keyAnchors: [
        "apps/server/src/textGeneration/TextGeneration.ts",
        "packages/provider-core/src/server/textGenerationPrompts.ts",
      ],
      summary: "Parent thread completed Phase 2 and scoped Phase 3 Track A around TextGeneration.",
    });
  }),
);

it.effect("rejects subtask summary replies with empty goal or summary", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(
        request,
        "Stub",
        JSON.stringify({
          goal: "   ",
          constraints: [],
          decisions: [],
          openQuestions: [],
          keyAnchors: [],
          summary: "Non-empty summary",
        }),
      ),
    );

    const outcome = yield* textGeneration
      .generateSubtaskSummary({
        cwd: process.cwd(),
        parentThreadId: "thread-parent-2",
        parentTitle: "Empty goal test",
        conversationExcerpt: "User: hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateSubtaskSummary");
  }),
);

it.effect("rejects subtask summary replies that echo placeholder schema keys", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(
        request,
        "Stub",
        JSON.stringify({
          goal: "goal",
          constraints: [],
          decisions: [],
          openQuestions: [],
          keyAnchors: [],
          summary: "summary",
        }),
      ),
    );

    const outcome = yield* textGeneration
      .generateSubtaskSummary({
        cwd: process.cwd(),
        parentThreadId: "thread-parent-3",
        parentTitle: "Placeholder test",
        conversationExcerpt: "User: hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateSubtaskSummary");
  }),
);

it.effect("rejects malformed JSON replies for generateSubtaskSummary", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"goal":"Missing required arrays"}'),
    );

    const outcome = yield* textGeneration
      .generateSubtaskSummary({
        cwd: process.cwd(),
        parentThreadId: "thread-parent-4",
        parentTitle: "Malformed JSON test",
        conversationExcerpt: "User: hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateSubtaskSummary");
  }),
);

it("builds a valid JSON schema object and bounds prompt sections for subtask summaries", () => {
  const jsonSchema = toJsonSchemaObject(SubtaskSummaryOutputSchema) as {
    type?: unknown;
    required?: unknown;
  };
  assert.strictEqual(jsonSchema.type, "object");
  assert.deepStrictEqual(jsonSchema.required, [
    "goal",
    "constraints",
    "decisions",
    "openQuestions",
    "keyAnchors",
    "summary",
  ]);

  const built = buildSubtaskSummaryPrompt({
    parentThreadId: "thread-long",
    parentTitle: "   ",
    conversationExcerpt: "x".repeat(40_000),
    maxSummaryChars: 50,
  });

  assert.include(built.prompt, "Parent thread: (untitled) (thread-long)");
  assert.include(built.prompt, "within roughly 400 characters");
  assert.include(built.prompt, "[truncated]");
});

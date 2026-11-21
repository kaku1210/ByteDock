import { describe, expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { decodeJsonReply } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

const makeSubtaskSummaryInput = (
  modelSelection: ModelSelection,
  projectId?: ProjectId,
): TextGeneration.SubtaskSummaryGenerationInput => ({
  cwd: "/tmp/repo",
  parentThreadId: "thread-parent",
  parentTitle: "Implement Phase 3",
  parentGoal: "Add structured subtask summaries",
  sourceCutoff: "turn:turn-4",
  conversationExcerpt: "User: Let's add generateSubtaskSummary.\nAssistant: On it.",
  strategyVersion: "llm-summary-v1",
  modelSelection,
  ...(projectId !== undefined ? { projectId } : {}),
});

const SAMPLE_RESULT: TextGeneration.SubtaskSummaryGenerationResult = {
  goal: "Add structured subtask summaries",
  constraints: ["Keep fallback deterministic"],
  decisions: ["Extend TextGeneration with generateSubtaskSummary"],
  openQuestions: [],
  keyAnchors: ["apps/server/src/textGeneration/TextGeneration.ts"],
  summary: "Extend TextGeneration and provider drivers with structured subtask summary generation.",
};

const makeProviderInstance = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly snapshot: ServerProvider;
  readonly onSubtaskSummary: (
    input: TextGeneration.SubtaskSummaryGenerationInput,
  ) => Effect.Effect<TextGeneration.SubtaskSummaryGenerationResult, TextGenerationError>;
}): ProviderInstance => ({
  instanceId: options.instanceId,
  driverKind: options.driver,
  continuationIdentity: { driverKind: options.driver, continuationKey: options.instanceId },
  displayName: undefined,
  enabled: options.snapshot.enabled,
  snapshot: { getSnapshot: Effect.succeed(options.snapshot) } as ProviderInstance["snapshot"],
  orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
  textGeneration: TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateReviewGuide: () => Effect.die("unused"),
    generateSubtaskSummary: options.onSubtaskSummary,
    generateTranscriptionPostProcessing: () => Effect.die("unused"),
    generatePromptSuggestion: () => Effect.die("unused"),
  }),
});

describe("TextGeneration.generateSubtaskSummary", () => {
  it.effect("routes through a standalone TextGenerators runner when configured", () =>
    Effect.gen(function* () {
      const openrouter = ProviderInstanceId.make("openrouter");
      const selection: ModelSelection = { instanceId: openrouter, model: "openai/gpt-5-mini" };
      const runnerOps: string[] = [];

      const service = yield* TextGeneration.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              listInstances: Effect.succeed([]),
              getInstance: () => Effect.undefined,
            }),
            ServerSettings.layerTest({}),
            Layer.mock(TextGenerators.TextGenerators)({
              runner: (id) =>
                Effect.succeed(
                  id === openrouter
                    ? (request) => {
                        runnerOps.push(request.operation);
                        return decodeJsonReply(
                          request,
                          "OpenRouter",
                          JSON.stringify(SAMPLE_RESULT),
                        );
                      }
                    : undefined,
                ),
            }),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => Effect.die("unused"),
            }),
            ProviderInstallationGate.layer,
          ),
        ),
      );

      const result = yield* service.generateSubtaskSummary(makeSubtaskSummaryInput(selection));
      expect(result).toEqual(SAMPLE_RESULT);
      expect(runnerOps).toEqual(["generateSubtaskSummary"]);
    }),
  );

  it.effect(
    "falls back to defaultModelSelection when primary provider is unavailable or quota-exhausted",
    () =>
      Effect.gen(function* () {
        const primaryId = ProviderInstanceId.make("codex");
        const fallbackId = ProviderInstanceId.make("claudeAgent");
        const primaryDriver = ProviderDriverKind.make("codex");
        const fallbackDriver = ProviderDriverKind.make("claudeAgent");
        const primarySelection: ModelSelection = { instanceId: primaryId, model: "gpt-5.4-mini" };
        const fallbackSelection: ModelSelection = {
          instanceId: fallbackId,
          model: "claude-haiku-4-5",
        };
        const projectId = ProjectId.make("project-1");

        for (const scenario of [
          "not-installed",
          "quota-exhausted",
          "project-disabled-fallback",
        ] as const) {
          const calls: ModelSelection[] = [];
          const primaryUnavailable =
            scenario === "not-installed" || scenario === "project-disabled-fallback";
          const primaryInstance = makeProviderInstance({
            instanceId: primaryId,
            driver: primaryDriver,
            snapshot: {
              instanceId: primaryId,
              driver: primaryDriver,
              enabled: true,
              installed: !primaryUnavailable,
              status: primaryUnavailable ? "error" : "ready",
              auth: { status: "authenticated" },
              version: null,
              checkedAt: "1970-01-01T00:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              ...(scenario === "quota-exhausted"
                ? {
                    usageLimits: {
                      checkedAt: "1970-01-01T00:00:00Z",
                      windows: [
                        { id: "session", kind: "session", label: "Session", usedPercent: 100 },
                      ],
                    },
                  }
                : {}),
            },
            onSubtaskSummary: (input) =>
              Effect.sync(() => {
                calls.push(input.modelSelection);
                return SAMPLE_RESULT;
              }),
          });
          const fallbackInstance = makeProviderInstance({
            instanceId: fallbackId,
            driver: fallbackDriver,
            snapshot: {
              instanceId: fallbackId,
              driver: fallbackDriver,
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated" },
              version: null,
              checkedAt: "1970-01-01T00:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
            },
            onSubtaskSummary: (input) =>
              Effect.sync(() => {
                calls.push(input.modelSelection);
                return SAMPLE_RESULT;
              }),
          });
          const instances = [primaryInstance, fallbackInstance];

          const service = yield* TextGeneration.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                  listInstances: Effect.succeed(instances),
                  getInstance: (id) =>
                    Effect.succeed(instances.find((candidate) => candidate.instanceId === id)),
                }),
                ServerSettings.layerTest({
                  providerInstances: {
                    [fallbackId]: {
                      driver: fallbackDriver,
                      config: { customModels: [fallbackSelection.model] },
                    },
                  },
                  defaultModelSelection: fallbackSelection,
                  ...(scenario === "project-disabled-fallback"
                    ? {
                        projectSettingsOverrides: {
                          [projectId]: { providerInstances: { [fallbackId]: { enabled: false } } },
                        },
                      }
                    : {}),
                }),
                Layer.mock(TextGenerators.TextGenerators)({ runner: () => Effect.undefined }),
                Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
                  resolveLink: () => Effect.die("unused"),
                }),
                ProviderInstallationGate.layer,
              ),
            ),
          );

          const result = yield* service.generateSubtaskSummary(
            makeSubtaskSummaryInput(primarySelection, projectId),
          );
          expect(result).toEqual(SAMPLE_RESULT);
          expect(calls).toEqual([
            scenario === "project-disabled-fallback" ? primarySelection : fallbackSelection,
          ]);
        }
      }),
  );

  it.effect("returns TextGenerationError when no registered provider can serve the request", () =>
    Effect.gen(function* () {
      const missingId = ProviderInstanceId.make("missing-provider");
      const service = yield* TextGeneration.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              listInstances: Effect.succeed([]),
              getInstance: () => Effect.undefined,
            }),
            ServerSettings.layerTest({}),
            Layer.mock(TextGenerators.TextGenerators)({ runner: () => Effect.undefined }),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => Effect.die("unused"),
            }),
            ProviderInstallationGate.layer,
          ),
        ),
      );

      const outcome = yield* service
        .generateSubtaskSummary(
          makeSubtaskSummaryInput({ instanceId: missingId, model: "unknown-model" }),
        )
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (value) => value }));

      expect(outcome).toBeInstanceOf(TextGenerationError);
      expect((outcome as TextGenerationError).operation).toBe("generateSubtaskSummary");
    }),
  );
});

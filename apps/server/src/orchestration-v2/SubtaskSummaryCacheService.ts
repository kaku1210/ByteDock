// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cache keys need a deterministic SHA-256 content digest.
import * as NodeCrypto from "node:crypto";

import {
  IsoDateTime,
  type MessageId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2SubtaskSourceAnchor,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { SubtaskSummaryGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { SubtaskSummaryCacheRepositoryError } from "../persistence/Errors.ts";
import * as SubtaskSummaryCache from "../persistence/SubtaskSummaryCache.ts";

export const DEFAULT_SUBTASK_SUMMARY_STRATEGY_VERSION = "llm-summary-v1";

export interface SubtaskSummaryCutoffKeyInput {
  readonly parentThreadId: ThreadId;
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
}

export interface SubtaskSummaryContentDigestInput {
  readonly parentTitle: string;
  readonly parentGoal?: string | null | undefined;
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly maxSummaryChars?: number | undefined;
}

export interface SubtaskSummaryCacheKeyInput
  extends SubtaskSummaryCutoffKeyInput, SubtaskSummaryContentDigestInput {
  readonly strategyVersion?: string | undefined;
}

export interface SubtaskSummaryGeneratedValue {
  readonly summary: SubtaskSummaryGenerationResult;
  readonly modelInstanceId?: ProviderInstanceId | null | undefined;
  readonly modelSlug?: string | null | undefined;
}

export interface SubtaskSummaryCacheMetadata {
  readonly sourceRunId?: RunId | null | undefined;
  readonly sourceOrdinal?: number | null | undefined;
  readonly sourceMessageId?: MessageId | null | undefined;
  readonly sourceTurnItemId?: TurnItemId | null | undefined;
}

export type SubtaskSummaryCacheOutcome = "cache_hit" | "generated" | "coalesced";

export interface SubtaskSummaryCacheLookupResult {
  readonly entry: SubtaskSummaryCache.SubtaskSummaryCacheEntry;
  readonly outcome: SubtaskSummaryCacheOutcome;
}

export interface GetOrGenerateSubtaskSummaryInput<E, R> {
  readonly key: SubtaskSummaryCache.SubtaskSummaryCacheKey;
  readonly metadata?: SubtaskSummaryCacheMetadata | undefined;
  readonly generate: Effect.Effect<SubtaskSummaryGeneratedValue, E, R>;
}

function buildSubtaskSummaryCutoffKey(input: SubtaskSummaryCutoffKeyInput): string {
  const parts: Array<string> = [];
  if (
    input.sourceAnchor?.sourceThreadId !== undefined &&
    input.sourceAnchor.sourceThreadId !== input.parentThreadId
  ) {
    parts.push(`src=${input.sourceAnchor.sourceThreadId}`);
  }
  if (input.sourceAnchor?.sourceRunId !== undefined) {
    parts.push(`run=${input.sourceAnchor.sourceRunId}`);
  }
  if (input.sourceAnchor?.sourceOrdinal !== undefined) {
    parts.push(`ord=${input.sourceAnchor.sourceOrdinal}`);
  }
  if (input.sourceAnchor?.sourceMessageId !== undefined) {
    parts.push(`msg=${input.sourceAnchor.sourceMessageId}`);
  }
  if (input.sourceAnchor?.sourceTurnItemId !== undefined) {
    parts.push(`item=${input.sourceAnchor.sourceTurnItemId}`);
  }
  parts.push(`runs=${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`);
  return parts.join("|");
}

function canonicalTurnItemFingerprint(item: OrchestrationV2TurnItem): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: item.id,
    runId: item.runId,
    ordinal: item.ordinal,
    type: item.type,
    status: item.status,
    title: item.title,
  };
  switch (item.type) {
    case "user_message":
      return {
        ...base,
        messageId: item.messageId,
        text: item.text,
        attachments: item.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      };
    case "assistant_message":
      return {
        ...base,
        phase: item.phase,
        text: item.text,
      };
    case "command_execution":
      return {
        ...base,
        input: item.input,
        exitCode: item.exitCode,
      };
    case "file_change":
      return {
        ...base,
        fileName: item.fileName,
        changes: item.changes?.map((change) => ({
          operation: change.operation,
          path: change.path,
          oldPath: change.oldPath ?? null,
        })),
      };
    case "checkpoint":
      return {
        ...base,
        files: item.files,
      };
    case "handoff":
      return {
        ...base,
        strategy: item.strategy,
        summary: item.summary,
      };
    case "reasoning":
      return {
        ...base,
        text: item.text,
      };
    default:
      return {
        ...base,
        updatedAt: DateTime.formatIso(item.updatedAt),
      };
  }
}

function computeSubtaskSummaryContentDigest(input: SubtaskSummaryContentDigestInput): string {
  const canonicalPayload = {
    parentTitle: input.parentTitle.trim(),
    parentGoal: input.parentGoal?.trim() || null,
    selectedExcerpt: input.sourceAnchor?.excerpt?.trim() || null,
    maxSummaryChars:
      input.maxSummaryChars === undefined ? null : Math.max(0, Math.floor(input.maxSummaryChars)),
    items: input.parentItems.map(canonicalTurnItemFingerprint),
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex");
}

export function buildSubtaskSummaryCacheKey(
  input: SubtaskSummaryCacheKeyInput,
): SubtaskSummaryCache.SubtaskSummaryCacheKey {
  const strategyVersion = input.strategyVersion?.trim() || DEFAULT_SUBTASK_SUMMARY_STRATEGY_VERSION;
  return {
    parentThreadId: input.parentThreadId,
    sourceCutoffKey: buildSubtaskSummaryCutoffKey(input),
    contentDigest: computeSubtaskSummaryContentDigest(input),
    strategyVersion,
  };
}

function serializeSubtaskSummaryCacheKey(key: SubtaskSummaryCache.SubtaskSummaryCacheKey): string {
  return JSON.stringify([
    key.parentThreadId,
    key.sourceCutoffKey,
    key.contentDigest,
    key.strategyVersion,
  ]);
}

type InFlightOutcome =
  | {
      readonly _tag: "ok";
      readonly entry: SubtaskSummaryCache.SubtaskSummaryCacheEntry;
    }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<unknown>;
    }
  | {
      readonly _tag: "leader_interrupted";
    };

export interface SubtaskSummaryCacheServiceShape {
  readonly getOrGenerate: <E, R>(
    input: GetOrGenerateSubtaskSummaryInput<E, R>,
  ) => Effect.Effect<SubtaskSummaryCacheLookupResult, E, R>;
  readonly invalidateParentThread: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<number, SubtaskSummaryCacheRepositoryError>;
  readonly pruneStale: (
    input: SubtaskSummaryCache.PruneSubtaskSummaryCacheInput,
  ) => Effect.Effect<number, SubtaskSummaryCacheRepositoryError>;
}

export class SubtaskSummaryCacheService extends Context.Service<
  SubtaskSummaryCacheService,
  SubtaskSummaryCacheServiceShape
>()("t3/orchestration-v2/SubtaskSummaryCacheService") {}

const make = Effect.gen(function* () {
  const repository = yield* SubtaskSummaryCache.SubtaskSummaryCacheRepository;
  const inFlightRef = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<InFlightOutcome>>>(
    new Map(),
  );

  const readCacheBestEffort = (key: SubtaskSummaryCache.SubtaskSummaryCacheKey) =>
    repository.get(key).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "SubtaskSummaryCacheService failed to read cache entry; treating as miss",
          {
            parentThreadId: key.parentThreadId,
            sourceCutoffKey: key.sourceCutoffKey,
            strategyVersion: key.strategyVersion,
            error: error.message,
          },
        ).pipe(Effect.as(Option.none<SubtaskSummaryCache.SubtaskSummaryCacheEntry>())),
      ),
    );

  const touchBestEffort = (key: SubtaskSummaryCache.SubtaskSummaryCacheKey) =>
    repository.touch(key).pipe(
      Effect.catch((error) =>
        Effect.logDebug("SubtaskSummaryCacheService failed to update last_accessed_at", {
          parentThreadId: key.parentThreadId,
          error: error.message,
        }),
      ),
    );

  const persistBestEffort = (
    key: SubtaskSummaryCache.SubtaskSummaryCacheKey,
    metadata: SubtaskSummaryCacheMetadata | undefined,
    generated: SubtaskSummaryGeneratedValue,
  ) =>
    repository
      .put({
        key,
        summary: generated.summary,
        sourceRunId: metadata?.sourceRunId ?? null,
        sourceOrdinal: metadata?.sourceOrdinal ?? null,
        sourceMessageId: metadata?.sourceMessageId ?? null,
        sourceTurnItemId: metadata?.sourceTurnItemId ?? null,
        modelInstanceId: generated.modelInstanceId ?? null,
        modelSlug: generated.modelSlug ?? null,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "SubtaskSummaryCacheService failed to persist generated summary; returning uncached result",
              {
                parentThreadId: key.parentThreadId,
                sourceCutoffKey: key.sourceCutoffKey,
                strategyVersion: key.strategyVersion,
                error: error.message,
              },
            );
            const nowIso = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
            return {
              key,
              summary: generated.summary,
              sourceRunId: metadata?.sourceRunId ?? null,
              sourceOrdinal: metadata?.sourceOrdinal ?? null,
              sourceMessageId: metadata?.sourceMessageId ?? null,
              sourceTurnItemId: metadata?.sourceTurnItemId ?? null,
              modelInstanceId: generated.modelInstanceId ?? null,
              modelSlug: generated.modelSlug ?? null,
              createdAt: nowIso,
              updatedAt: nowIso,
              lastAccessedAt: nowIso,
            } satisfies SubtaskSummaryCache.SubtaskSummaryCacheEntry;
          }),
        ),
      );

  const getOrGenerate: SubtaskSummaryCacheServiceShape["getOrGenerate"] = Effect.fn(
    "SubtaskSummaryCacheService.getOrGenerate",
  )(function* <E, R>(input: GetOrGenerateSubtaskSummaryInput<E, R>) {
    const serializedKey = serializeSubtaskSummaryCacheKey(input.key);

    while (true) {
      const initialCached = yield* readCacheBestEffort(input.key);
      if (Option.isSome(initialCached)) {
        yield* touchBestEffort(input.key);
        return {
          entry: initialCached.value,
          outcome: "cache_hit",
        } satisfies SubtaskSummaryCacheLookupResult;
      }

      const attempt = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<InFlightOutcome>();
          type InFlightRole =
            | {
                readonly _tag: "follower";
                readonly deferred: Deferred.Deferred<InFlightOutcome>;
              }
            | {
                readonly _tag: "leader";
                readonly deferred: Deferred.Deferred<InFlightOutcome>;
              };
          const role: InFlightRole = yield* Ref.modify(
            inFlightRef,
            (
              current,
            ): readonly [InFlightRole, ReadonlyMap<string, Deferred.Deferred<InFlightOutcome>>] => {
              const existing = current.get(serializedKey);
              if (existing !== undefined) {
                return [{ _tag: "follower", deferred: existing }, current];
              }
              const next = new Map(current);
              next.set(serializedKey, candidate);
              return [{ _tag: "leader", deferred: candidate }, next];
            },
          );

          if (role._tag === "follower") {
            const awaited = yield* restore(Deferred.await(role.deferred));
            switch (awaited._tag) {
              case "ok":
                return {
                  _tag: "done" as const,
                  result: {
                    entry: awaited.entry,
                    outcome: "coalesced" as const,
                  } satisfies SubtaskSummaryCacheLookupResult,
                };
              case "failed":
                return yield* Effect.failCause(awaited.cause as Cause.Cause<E>);
              case "leader_interrupted":
                return { _tag: "retry" as const };
            }
          }

          const cleanupAndResolve = (outcome: InFlightOutcome) =>
            Ref.update(inFlightRef, (current) => {
              if (current.get(serializedKey) !== candidate) return current;
              const next = new Map(current);
              next.delete(serializedKey);
              return next;
            }).pipe(Effect.andThen(Deferred.succeed(candidate, outcome)), Effect.asVoid);

          // Re-check SQLite after claiming leadership to close the race window with a just-finished leader.
          const recheckExit = yield* Effect.exit(restore(readCacheBestEffort(input.key)));
          if (Exit.isFailure(recheckExit)) {
            yield* cleanupAndResolve(
              Cause.hasInterruptsOnly(recheckExit.cause)
                ? { _tag: "leader_interrupted" }
                : { _tag: "failed", cause: recheckExit.cause },
            );
            return yield* Effect.failCause(recheckExit.cause);
          }
          if (Option.isSome(recheckExit.value)) {
            yield* touchBestEffort(input.key);
            yield* cleanupAndResolve({ _tag: "ok", entry: recheckExit.value.value });
            return {
              _tag: "done" as const,
              result: {
                entry: recheckExit.value.value,
                outcome: "cache_hit" as const,
              } satisfies SubtaskSummaryCacheLookupResult,
            };
          }

          const generatedExit = yield* Effect.exit(restore(input.generate));
          if (Exit.isFailure(generatedExit)) {
            yield* cleanupAndResolve(
              Cause.hasInterruptsOnly(generatedExit.cause)
                ? { _tag: "leader_interrupted" }
                : { _tag: "failed", cause: generatedExit.cause },
            );
            return yield* Effect.failCause(generatedExit.cause);
          }

          const entry = yield* persistBestEffort(input.key, input.metadata, generatedExit.value);
          yield* cleanupAndResolve({ _tag: "ok", entry });
          return {
            _tag: "done" as const,
            result: {
              entry,
              outcome: "generated" as const,
            } satisfies SubtaskSummaryCacheLookupResult,
          };
        }),
      );

      if (attempt._tag === "done") {
        return attempt.result;
      }
    }
  });

  const invalidateParentThread: SubtaskSummaryCacheServiceShape["invalidateParentThread"] =
    Effect.fn("SubtaskSummaryCacheService.invalidateParentThread")(function* (parentThreadId) {
      return yield* repository.deleteByParentThreadId(parentThreadId);
    });

  const pruneStale: SubtaskSummaryCacheServiceShape["pruneStale"] = Effect.fn(
    "SubtaskSummaryCacheService.pruneStale",
  )(function* (input) {
    return yield* repository.pruneStale(input);
  });

  return SubtaskSummaryCacheService.of({
    getOrGenerate,
    invalidateParentThread,
    pruneStale,
  });
});

export const layer: Layer.Layer<
  SubtaskSummaryCacheService,
  never,
  SubtaskSummaryCache.SubtaskSummaryCacheRepository
> = Layer.effect(SubtaskSummaryCacheService, make);

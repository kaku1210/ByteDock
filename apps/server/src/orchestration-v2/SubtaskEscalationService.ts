import {
  CommandId,
  MessageId,
  NodeId,
  SubtaskEscalationError,
  SubtaskEscalationRequest,
  SubtaskEscalationRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2SubtaskSourceAnchor,
  type RunId,
  type SubtaskEscalationCreateDraftInput,
  type SubtaskEscalationCreateDraftResult,
  type SubtaskEscalationResolveInput,
  type SubtaskEscalationResolveResult,
} from "@t3tools/contracts";
import {
  latestUnheldRun,
  orchestrationV2WorktreePending,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { computeOutboundCausationChain } from "./CausationChain.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SubtaskEscalationStore from "./SubtaskEscalationStore.ts";
import {
  type HorizontalEscalationSourceError,
  validateHorizontalEscalationSource,
} from "./TaskTreeDepth.ts";

function deterministicHashHex(value: string): string {
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    const code = BigInt(value.charCodeAt(index));
    h1 = ((h1 ^ code) * prime) & mask;
    h2 = ((h2 ^ (code + BigInt(index + 1))) * prime) & mask;
  }
  return `${h1.toString(16).padStart(16, "0")}${h2.toString(16).padStart(16, "0")}`.slice(0, 24);
}

function deterministicEscalationThreadId(requestId: SubtaskEscalationRequestId): ThreadId {
  return ThreadId.make(`thread:escalation:${deterministicHashHex(requestId)}`);
}

function deterministicEscalationDraftCommandId(requestId: SubtaskEscalationRequestId): CommandId {
  return CommandId.make(`command:subtask-escalation:draft:${deterministicHashHex(requestId)}`);
}

function deterministicEscalationInboxCommandId(requestId: SubtaskEscalationRequestId): CommandId {
  return CommandId.make(`command:subtask-escalation:inbox:${deterministicHashHex(requestId)}`);
}

function deterministicEscalationInboxMessageId(requestId: SubtaskEscalationRequestId): MessageId {
  return MessageId.make(`msg:subtask-escalation:inbox:${deterministicHashHex(requestId)}`);
}

function mapSourceError(error: HorizontalEscalationSourceError): SubtaskEscalationError {
  return new SubtaskEscalationError({
    reason: error.reason,
    detail: error.message,
  });
}

function classifyDispatchFailure(error: unknown, fallbackDetail: string): SubtaskEscalationError {
  const raw =
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof error.cause === "string"
      ? error.cause
      : error instanceof Error
        ? error.message
        : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("causationchain") || lower.includes("auto-wake loop")) {
    return new SubtaskEscalationError({ reason: "causation_loop", detail: raw });
  }
  if (lower.includes("archived")) {
    return new SubtaskEscalationError({ reason: "root_archived", detail: raw });
  }
  if (lower.includes("deleted")) {
    return new SubtaskEscalationError({ reason: "root_deleted", detail: raw });
  }
  if (lower.includes("not found") || lower.includes("unreachable")) {
    return new SubtaskEscalationError({ reason: "root_unreachable", detail: raw });
  }
  if (lower.includes("worktree")) {
    return new SubtaskEscalationError({ reason: "root_worktree_pending", detail: raw });
  }
  return new SubtaskEscalationError({
    reason: "orchestration_failed",
    detail: raw || fallbackDetail,
    cause: error,
  });
}

function assertBindingsMatch(input: {
  readonly existing: SubtaskEscalationRequest;
  readonly sourceThreadId: ThreadId;
  readonly rootThreadId: ThreadId;
}): Effect.Effect<void, SubtaskEscalationError> {
  if (
    input.existing.sourceThreadId !== input.sourceThreadId ||
    input.existing.rootThreadId !== input.rootThreadId
  ) {
    return Effect.fail(
      new SubtaskEscalationError({
        reason: "binding_mismatch",
        detail: `Escalation request ${input.existing.requestId} is bound to source ${input.existing.sourceThreadId} / root ${input.existing.rootThreadId}, not ${input.sourceThreadId} / ${input.rootThreadId}.`,
      }),
    );
  }
  return Effect.void;
}

function formatEscalationInboxMessage(input: {
  readonly requestId: SubtaskEscalationRequestId;
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
  readonly title: string | null;
  readonly task: string;
  readonly reason: string | null;
  readonly excerpt: string | null;
}): string {
  const lines = [
    `[L1 Horizontal Escalation] Request ${input.requestId}`,
    `Source L1 subtask: "${input.sourceTitle}" (${input.sourceThreadId})`,
    ...(input.title ? [`Suggested sibling L1 title: ${input.title}`] : []),
    ...(input.reason ? [`Why sibling L1: ${input.reason}`] : []),
    ...(input.excerpt ? [`Source excerpt: ${input.excerpt}`] : []),
    `Requested sibling L1 task:\n${input.task}`,
    `To accept and create the sibling L1 idempotently, call delegate_task with escalationRequestId: "${input.requestId}".`,
  ];
  return lines.join("\n");
}

export interface SubmitAgentEscalationInput {
  readonly requestId: SubtaskEscalationRequestId;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId?: RunId | undefined;
  readonly sourceMessageId?: MessageId | undefined;
  readonly excerpt?: string | undefined;
  readonly title?: string | undefined;
  readonly task: string;
  readonly reason?: string | undefined;
  readonly callerIncomingChain?: ReadonlyArray<ThreadId> | undefined;
  readonly explicitCausationChain?: ReadonlyArray<ThreadId> | undefined;
  readonly holdParentQueue: boolean;
}

export interface SubmitAgentEscalationResult {
  readonly request: SubtaskEscalationRequest;
  readonly replayed: boolean;
}

export interface FulfillDelegationOutcome {
  readonly childThreadId: ThreadId;
  readonly delegatedTaskId: NodeId;
}

export interface SubtaskEscalationServiceShape {
  readonly createHumanDraft: (
    input: SubtaskEscalationCreateDraftInput,
  ) => Effect.Effect<SubtaskEscalationCreateDraftResult, SubtaskEscalationError>;
  readonly submitAgentEscalation: (
    input: SubmitAgentEscalationInput,
  ) => Effect.Effect<SubmitAgentEscalationResult, SubtaskEscalationError>;
  readonly fulfillForDelegation: <E, R>(input: {
    readonly requestId: SubtaskEscalationRequestId;
    readonly callerThreadId: ThreadId;
    readonly runDelegation: (context: {
      readonly request: SubtaskEscalationRequest;
      readonly sourceAnchor: OrchestrationV2SubtaskSourceAnchor;
    }) => Effect.Effect<FulfillDelegationOutcome, E, R>;
  }) => Effect.Effect<
    {
      readonly request: SubtaskEscalationRequest;
      readonly replayed: boolean;
      readonly childThreadId: ThreadId;
      readonly delegatedTaskId: NodeId | null;
    },
    E | SubtaskEscalationError,
    R
  >;
  readonly resolveByHuman: (
    input: SubtaskEscalationResolveInput,
  ) => Effect.Effect<SubtaskEscalationResolveResult, SubtaskEscalationError>;
  readonly listForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<SubtaskEscalationRequest>, SubtaskEscalationError>;
  readonly getById: (
    requestId: SubtaskEscalationRequestId,
  ) => Effect.Effect<Option.Option<SubtaskEscalationRequest>, SubtaskEscalationError>;
}

export class SubtaskEscalationService extends Context.Service<
  SubtaskEscalationService,
  SubtaskEscalationServiceShape
>()("t3/orchestration-v2/SubtaskEscalationService") {}

export const layer: Layer.Layer<
  SubtaskEscalationService,
  never,
  | SecureRandom.SecureRandom
  | SubtaskEscalationStore.SubtaskEscalationStore
  | Orchestrator.OrchestratorV2
  | ProjectionStore.ProjectionStoreV2
> = Layer.effect(
  SubtaskEscalationService,
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const store = yield* SubtaskEscalationStore.SubtaskEscalationStore;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    const loadThread = (threadId: ThreadId) =>
      projectionStore.getThread(threadId).pipe(
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
        }),
        Effect.mapError(
          (cause) =>
            new SubtaskEscalationError({
              reason: "persistence_failed",
              detail: `Unable to load thread ${threadId}.`,
              cause,
            }),
        ),
      );

    const loadEscalationTraceRecords = (threadId: ThreadId) =>
      projectionStore.getThreadRecords(threadId, ["runs", "messages", "subagents"]).pipe(
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
        }),
        Effect.mapError(
          (cause) =>
            new SubtaskEscalationError({
              reason: "persistence_failed",
              detail: `Unable to load escalation trace records for thread ${threadId}.`,
              cause,
            }),
        ),
      );

    /**
     * Collects benign child-return thread IDs (L2 returns to L1 or non-escalation L1 returns to L0).
     * Any prior escalation hop or sibling `sourceAnchor` disables root-side exemptions.
     */
    const resolveBenignEscalationChainThreadIds = Effect.fn(
      "SubtaskEscalationService.resolveBenignEscalationChainThreadIds",
    )(function* (input: {
      readonly sourceThread: OrchestrationV2AppThread;
      readonly rootThread: OrchestrationV2AppThread;
      readonly sourceRunId?: RunId | undefined;
      readonly callerIncomingChain?: ReadonlyArray<ThreadId> | undefined;
    }) {
      const incoming = input.callerIncomingChain ?? [];
      const hasOtherEntries = incoming.some(
        (id) => id !== input.sourceThread.id && id !== input.rootThread.id,
      );
      if (!hasOtherEntries) return [] as ReadonlyArray<ThreadId>;

      const benign = new Set<ThreadId>();
      const sourceRecords = yield* loadEscalationTraceRecords(input.sourceThread.id);
      const rootRecords = yield* loadEscalationTraceRecords(input.rootThread.id);
      const rootEscalations = yield* store.listForThread(input.rootThread.id);

      const escalationInboxRunIds = new Set<RunId>();
      const escalationInboxMessageIds = new Set<MessageId>();
      const escalationFulfilledChildIds = new Set<ThreadId>();
      for (const escalation of rootEscalations) {
        if (escalation.inboxRunId !== null) {
          escalationInboxRunIds.add(escalation.inboxRunId);
        }
        if (escalation.inboxMessageId !== null) {
          escalationInboxMessageIds.add(escalation.inboxMessageId);
        }
        if (escalation.childThreadId !== null) {
          escalationFulfilledChildIds.add(escalation.childThreadId);
        }
      }

      let originSourceRun =
        sourceRecords === null
          ? undefined
          : ((input.sourceRunId === undefined
              ? undefined
              : sourceRecords.runs.find((run) => run.id === input.sourceRunId)) ??
            sourceRecords.runs
              .filter(
                (run) =>
                  run.status === "starting" || run.status === "running" || run.status === "waiting",
              )
              .toSorted((left, right) => right.ordinal - left.ordinal)[0] ??
            latestUnheldRun(sourceRecords.runs) ??
            sourceRecords.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]);

      // Step A: Walk backwards across this L1's own L2 child completion/report wakes.
      if (sourceRecords !== null) {
        const visitedSourceRuns = new Set<RunId>();
        while (originSourceRun !== undefined && !visitedSourceRuns.has(originSourceRun.id)) {
          visitedSourceRuns.add(originSourceRun.id);
          if (originSourceRun.restartContinuationOfRunId != null) {
            const continuedFrom = sourceRecords.runs.find(
              (run) => run.id === originSourceRun!.restartContinuationOfRunId,
            );
            if (continuedFrom !== undefined) {
              originSourceRun = continuedFrom;
              continue;
            }
          }
          const runMessage = sourceRecords.messages.find(
            (message) => message.id === originSourceRun!.userMessageId,
          );
          if (runMessage?.delegatedCompletion !== undefined) {
            for (const taskId of runMessage.delegatedCompletion.taskIds) {
              const childThreadId =
                sourceRecords.subagents.find((candidate) => candidate.id === taskId)
                  ?.childThreadId ?? null;
              if (childThreadId !== null) {
                benign.add(childThreadId);
              }
            }
            originSourceRun = sourceRecords.runs.find(
              (run) => run.id === runMessage.delegatedCompletion!.parentRunId,
            );
            continue;
          }
          if (runMessage?.senderThreadId !== undefined) {
            const senderId = runMessage.senderThreadId;
            const childSubagent = sourceRecords.subagents.find(
              (candidate) => candidate.childThreadId === senderId,
            );
            const childThread = childSubagent === undefined ? yield* loadThread(senderId) : null;
            const isDirectChild =
              childSubagent !== undefined ||
              (childThread !== null &&
                childThread.lineage.parentThreadId === input.sourceThread.id);
            if (isDirectChild) {
              benign.add(senderId);
              if (childSubagent?.runId != null) {
                originSourceRun = sourceRecords.runs.find((run) => run.id === childSubagent.runId);
                continue;
              }
              const precedingRuns = sourceRecords.runs.filter(
                (run) => run.ordinal < originSourceRun!.ordinal,
              );
              originSourceRun =
                latestUnheldRun(precedingRuns) ??
                precedingRuns.toSorted((left, right) => right.ordinal - left.ordinal)[0];
              continue;
            }
          }
          break;
        }
      }

      // Step B: If this L1 was NOT created to fulfill a sibling escalation, check whether L0
      // delegated this L1 during a non-escalation child completion/report wake.
      const hasSiblingEscalationAnchor =
        escalationFulfilledChildIds.has(input.sourceThread.id) ||
        (input.sourceThread.sourceAnchor !== undefined &&
          input.sourceThread.sourceAnchor.sourceThreadId !== input.rootThread.id &&
          input.sourceThread.sourceAnchor.sourceThreadId !== input.sourceThread.id);
      const rootSubagent = rootRecords?.subagents.find(
        (candidate) => candidate.childThreadId === input.sourceThread.id,
      );
      const tracedToInitialDelegatedRun =
        originSourceRun === undefined || originSourceRun.ordinal === 1;

      if (
        !hasSiblingEscalationAnchor &&
        rootRecords !== null &&
        rootSubagent?.runId != null &&
        tracedToInitialDelegatedRun
      ) {
        const candidateRootBenign = new Set<ThreadId>();
        const visitedRootRuns = new Set<RunId>();
        const queue: Array<RunId> = [rootSubagent.runId];
        let hasEscalationAncestor = false;

        while (queue.length > 0 && !hasEscalationAncestor) {
          const runId = queue.pop()!;
          if (visitedRootRuns.has(runId)) continue;
          visitedRootRuns.add(runId);

          if (escalationInboxRunIds.has(runId)) {
            hasEscalationAncestor = true;
            break;
          }

          const run = rootRecords.runs.find((candidate) => candidate.id === runId);
          if (run === undefined) continue;
          if (escalationInboxMessageIds.has(run.userMessageId)) {
            hasEscalationAncestor = true;
            break;
          }
          if (run.restartContinuationOfRunId != null) {
            queue.push(run.restartContinuationOfRunId);
          }

          const msg = rootRecords.messages.find((message) => message.id === run.userMessageId);
          if (msg === undefined) continue;

          if (msg.delegatedCompletion !== undefined) {
            for (const taskId of msg.delegatedCompletion.taskIds) {
              const completedSub = rootRecords.subagents.find(
                (candidate) => candidate.id === taskId,
              );
              const childId = completedSub?.childThreadId ?? null;
              if (childId === null) continue;
              const childThread = yield* loadThread(childId);
              if (
                escalationFulfilledChildIds.has(childId) ||
                (childThread?.sourceAnchor !== undefined &&
                  childThread.sourceAnchor.sourceThreadId !== input.rootThread.id &&
                  childThread.sourceAnchor.sourceThreadId !== childId)
              ) {
                hasEscalationAncestor = true;
                break;
              }
              candidateRootBenign.add(childId);
              if (completedSub?.runId != null) {
                queue.push(completedSub.runId);
              }
            }
            if (hasEscalationAncestor) break;
            queue.push(msg.delegatedCompletion.parentRunId);
            continue;
          }

          if (msg.senderThreadId !== undefined) {
            const senderId = msg.senderThreadId;
            const senderThread = yield* loadThread(senderId);
            if (
              senderThread === null ||
              senderThread.lineage.parentThreadId !== input.rootThread.id
            ) {
              continue;
            }
            if (
              escalationFulfilledChildIds.has(senderId) ||
              (senderThread.sourceAnchor !== undefined &&
                senderThread.sourceAnchor.sourceThreadId !== input.rootThread.id &&
                senderThread.sourceAnchor.sourceThreadId !== senderId)
            ) {
              hasEscalationAncestor = true;
              break;
            }
            candidateRootBenign.add(senderId);
            const senderSub = rootRecords.subagents.find(
              (candidate) => candidate.childThreadId === senderId,
            );
            if (senderSub?.runId != null) {
              queue.push(senderSub.runId);
            }
          }
        }

        if (!hasEscalationAncestor) {
          for (const threadId of candidateRootBenign) {
            benign.add(threadId);
          }
          // Also exempt direct L2 children of those benign L1 siblings (e.g. L0->L1-A->L2-A->L1-A->L0->L1-B).
          for (const candidateId of incoming) {
            if (
              candidateId === input.sourceThread.id ||
              candidateId === input.rootThread.id ||
              benign.has(candidateId)
            ) {
              continue;
            }
            const candidateThread = yield* loadThread(candidateId);
            if (
              candidateThread !== null &&
              candidateThread.lineage.parentThreadId !== null &&
              candidateRootBenign.has(candidateThread.lineage.parentThreadId)
            ) {
              benign.add(candidateId);
            }
          }
        }
      }

      return [...benign] as ReadonlyArray<ThreadId>;
    });

    const createHumanDraftLocked = Effect.fn("SubtaskEscalationService.createHumanDraftLocked")(
      function* (input: {
        readonly requestId: SubtaskEscalationRequestId;
        readonly sourceThreadId: ThreadId;
        readonly targetThreadId?: ThreadId | undefined;
        readonly title?: string | undefined;
        readonly task?: string | undefined;
        readonly sourceRunId?: RunId | undefined;
        readonly sourceMessageId?: MessageId | undefined;
        readonly excerpt?: string | undefined;
      }): Effect.fn.Return<SubtaskEscalationCreateDraftResult, SubtaskEscalationError> {
        const existingOpt = yield* store.getById(input.requestId);
        if (Option.isSome(existingOpt)) {
          const existing = existingOpt.value;
          if (existing.sourceThreadId !== input.sourceThreadId) {
            return yield* new SubtaskEscalationError({
              reason: "binding_mismatch",
              detail: `Escalation request ${existing.requestId} belongs to source thread ${existing.sourceThreadId}, not ${input.sourceThreadId}.`,
            });
          }
          if (existing.status === "fulfilled" && existing.childThreadId !== null) {
            return {
              request: existing,
              childThreadId: existing.childThreadId,
              replayed: true,
            };
          }
          if (existing.status === "cancelled" || existing.status === "rejected") {
            return yield* new SubtaskEscalationError({
              reason: "already_resolved",
              detail:
                existing.resolutionReason ??
                `Escalation request ${existing.requestId} is ${existing.status}.`,
            });
          }
        }

        const { sourceThread, rootThread } = yield* validateHorizontalEscalationSource({
          sourceThreadId: input.sourceThreadId,
          loadThread,
        }).pipe(
          Effect.catchTags({
            HorizontalEscalationSourceError: (error) => Effect.fail(mapSourceError(error)),
          }),
        );

        if (Option.isSome(existingOpt)) {
          yield* assertBindingsMatch({
            existing: existingOpt.value,
            sourceThreadId: sourceThread.id,
            rootThreadId: rootThread.id,
          });
        }

        const rootRuns = yield* projectionStore.getThreadRecords(rootThread.id, ["runs"]).pipe(
          Effect.mapError(
            (cause) =>
              new SubtaskEscalationError({
                reason: "root_unreachable",
                detail: `Unable to load root thread ${rootThread.id} runs.`,
                cause,
              }),
          ),
        );
        if (orchestrationV2WorktreePending(rootThread.worktreePath, rootRuns.runs)) {
          return yield* new SubtaskEscalationError({
            reason: "root_worktree_pending",
            detail: `Root thread ${rootThread.id} worktree is still being prepared.`,
          });
        }

        const existing = Option.getOrUndefined(existingOpt);
        const childThreadId =
          existing?.childThreadId ??
          input.targetThreadId ??
          deterministicEscalationThreadId(input.requestId);
        const commandId = deterministicEscalationDraftCommandId(input.requestId);
        const excerpt = input.excerpt?.trim() || existing?.excerpt || undefined;
        const resolvedTitle = input.title?.trim() || existing?.title || undefined;
        const resolvedTask = input.task?.trim() || existing?.task || excerpt || "";
        const resolvedSourceRunId = input.sourceRunId ?? existing?.sourceRunId ?? undefined;
        const resolvedSourceMessageId =
          input.sourceMessageId ?? existing?.sourceMessageId ?? undefined;

        const sourceAnchor: OrchestrationV2SubtaskSourceAnchor = {
          sourceThreadId: sourceThread.id,
          ...(resolvedSourceRunId === undefined ? {} : { sourceRunId: resolvedSourceRunId }),
          ...(resolvedSourceMessageId === undefined
            ? {}
            : { sourceMessageId: resolvedSourceMessageId }),
          ...(excerpt === undefined ? {} : { excerpt }),
        };

        yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId,
            createdBy: "user",
            creationSource: "web",
            sourceThreadId: rootThread.id,
            targetThreadId: childThreadId,
            sourcePoint: { type: "latest_stable" },
            subtask: true,
            sourceAnchor,
            ...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const mapped = classifyDispatchFailure(
                  error,
                  `Unable to create sibling L1 draft under root thread ${rootThread.id}.`,
                );
                if (
                  Option.isSome(existingOpt) &&
                  (mapped.reason === "root_archived" || mapped.reason === "root_deleted")
                ) {
                  yield* store
                    .markTerminal({
                      requestId: input.requestId,
                      status: "cancelled",
                      resolvedBy: null,
                      resolutionReason: mapped.message,
                    })
                    .pipe(Effect.ignore);
                }
                return yield* mapped;
              }),
            ),
          );

        const saved = yield* store.upsert({
          requestId: input.requestId,
          projectId: rootThread.projectId,
          rootThreadId: rootThread.id,
          sourceThreadId: sourceThread.id,
          sourceRunId: resolvedSourceRunId ?? null,
          sourceMessageId: resolvedSourceMessageId ?? null,
          excerpt: excerpt ?? null,
          title: resolvedTitle ?? null,
          task: resolvedTask,
          trigger: existing?.trigger ?? "user",
          status: "fulfilled",
          childThreadId,
          delegatedTaskId: existing?.delegatedTaskId ?? null,
          inboxMessageId: existing?.inboxMessageId ?? null,
          inboxRunId: existing?.inboxRunId ?? null,
          parentQueueHeld: existing?.parentQueueHeld ?? false,
          causationChain: existing?.causationChain ?? [],
          resolvedBy: "user",
          resolutionReason:
            existing?.trigger === "agent"
              ? "Accepted as sibling L1 draft by user."
              : "Created sibling L1 draft.",
        });

        return {
          request: saved,
          childThreadId,
          replayed: false,
        };
      },
    );

    const createHumanDraft: SubtaskEscalationServiceShape["createHumanDraft"] = Effect.fn(
      "SubtaskEscalationService.createHumanDraft",
    )(function* (input) {
      const requestId =
        input.requestId ?? SubtaskEscalationRequestId.make(`esc:user:${yield* random.uuidV4()}`);
      return yield* store.withRequestLock(
        requestId,
        createHumanDraftLocked({
          requestId,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          title: input.title,
          task: input.task,
          sourceRunId: input.sourceRunId,
          sourceMessageId: input.sourceMessageId,
          excerpt: input.excerpt,
        }),
      );
    });

    const submitAgentEscalation: SubtaskEscalationServiceShape["submitAgentEscalation"] = Effect.fn(
      "SubtaskEscalationService.submitAgentEscalation",
    )(function* (input) {
      return yield* store.withRequestLock(
        input.requestId,
        Effect.gen(function* () {
          const existingOpt = yield* store.getById(input.requestId);
          if (Option.isSome(existingOpt)) {
            const existing = existingOpt.value;
            if (existing.sourceThreadId !== input.sourceThreadId) {
              return yield* new SubtaskEscalationError({
                reason: "binding_mismatch",
                detail: `Escalation request ${existing.requestId} is bound to source thread ${existing.sourceThreadId}, not ${input.sourceThreadId}.`,
              });
            }
            if (existing.status === "fulfilled") {
              return { request: existing, replayed: true };
            }
            if (existing.status === "cancelled" || existing.status === "rejected") {
              return yield* new SubtaskEscalationError({
                reason: "already_resolved",
                detail:
                  existing.resolutionReason ??
                  `Escalation request ${existing.requestId} is ${existing.status}.`,
              });
            }
            // Pending replay: verify root is still live so retries after root archive return explicit terminal error.
            const rootNow = yield* loadThread(existing.rootThreadId);
            if (rootNow === null) {
              const cancelled = yield* store.markTerminal({
                requestId: existing.requestId,
                status: "cancelled",
                resolvedBy: null,
                resolutionReason: `Root thread ${existing.rootThreadId} could not be reached.`,
              });
              return yield* new SubtaskEscalationError({
                reason: "root_unreachable",
                ...(cancelled.resolutionReason === null
                  ? {}
                  : { detail: cancelled.resolutionReason }),
              });
            }
            if (rootNow.deletedAt !== null) {
              const cancelled = yield* store.markTerminal({
                requestId: existing.requestId,
                status: "cancelled",
                resolvedBy: null,
                resolutionReason: `Root thread ${existing.rootThreadId} was deleted.`,
              });
              return yield* new SubtaskEscalationError({
                reason: "root_deleted",
                ...(cancelled.resolutionReason === null
                  ? {}
                  : { detail: cancelled.resolutionReason }),
              });
            }
            if (rootNow.archivedAt !== null) {
              const cancelled = yield* store.markTerminal({
                requestId: existing.requestId,
                status: "cancelled",
                resolvedBy: null,
                resolutionReason: `Root thread ${existing.rootThreadId} is archived.`,
              });
              return yield* new SubtaskEscalationError({
                reason: "root_archived",
                ...(cancelled.resolutionReason === null
                  ? {}
                  : { detail: cancelled.resolutionReason }),
              });
            }
            return { request: existing, replayed: true };
          }

          const { sourceThread, rootThread } = yield* validateHorizontalEscalationSource({
            sourceThreadId: input.sourceThreadId,
            loadThread,
          }).pipe(
            Effect.catchTags({
              HorizontalEscalationSourceError: (error) => Effect.fail(mapSourceError(error)),
            }),
          );

          const benignChildReturnThreadIds = yield* resolveBenignEscalationChainThreadIds({
            sourceThread,
            rootThread,
            sourceRunId: input.sourceRunId,
            callerIncomingChain: input.callerIncomingChain,
          });
          const computedChain = computeOutboundCausationChain({
            callerThreadId: sourceThread.id,
            targetThreadId: rootThread.id,
            callerIncomingChain: input.callerIncomingChain,
            explicitChain: input.explicitCausationChain,
            intent: "escalation",
            benignChildReturnThreadIds,
          });
          if (computedChain.loopDetected) {
            return yield* new SubtaskEscalationError({
              reason: "causation_loop",
              detail:
                computedChain.loopReason ??
                `Escalation loop detected targeting root thread ${rootThread.id}.`,
            });
          }
          const causationChain = computedChain.causationChain ?? [sourceThread.id];

          const commandId = deterministicEscalationInboxCommandId(input.requestId);
          const messageId = deterministicEscalationInboxMessageId(input.requestId);
          const excerpt = input.excerpt?.trim() || null;
          const title = input.title?.trim() || null;
          const reason = input.reason?.trim() || null;
          const inboxText = formatEscalationInboxMessage({
            requestId: input.requestId,
            sourceThreadId: sourceThread.id,
            sourceTitle: sourceThread.title,
            title,
            task: input.task,
            reason,
            excerpt,
          });

          const dispatched = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId,
              createdBy: "agent",
              creationSource: "mcp",
              threadId: rootThread.id,
              senderThreadId: sourceThread.id,
              messageId,
              text: inboxText,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              causationChain: [...causationChain],
              childReport: {
                childThreadId: sourceThread.id,
                ...(input.sourceRunId === undefined ? {} : { childRunId: input.sourceRunId }),
                reportKind: "interim",
                resultVersion: 0,
                ...(input.holdParentQueue ? { holdParentQueue: true } : {}),
                causationChain: [...causationChain],
                escalationRequestId: input.requestId,
              },
            })
            .pipe(
              Effect.mapError((error) =>
                classifyDispatchFailure(
                  error,
                  `Unable to enqueue escalation request ${input.requestId} into root thread ${rootThread.id}.`,
                ),
              ),
            );

          const runEvent = dispatched.storedEvents.find(
            (stored) =>
              stored.event.type === "run.created" && stored.event.threadId === rootThread.id,
          );
          const inboxRunId =
            runEvent?.event.type === "run.created" ? runEvent.event.payload.id : null;
          const parentQueueHeld =
            runEvent?.event.type === "run.created"
              ? runEvent.event.payload.queueHeld === true
              : input.holdParentQueue;

          const saved = yield* store.upsert({
            requestId: input.requestId,
            projectId: rootThread.projectId,
            rootThreadId: rootThread.id,
            sourceThreadId: sourceThread.id,
            sourceRunId: input.sourceRunId ?? null,
            sourceMessageId: input.sourceMessageId ?? null,
            excerpt,
            title,
            task: input.task,
            trigger: "agent",
            status: "pending",
            childThreadId: null,
            delegatedTaskId: null,
            inboxMessageId: messageId,
            inboxRunId,
            parentQueueHeld,
            causationChain,
            resolvedBy: null,
            resolutionReason: null,
          });

          // Recheck root after persisting in case concurrent archive committed between dispatch and upsert.
          const rootAfter = yield* loadThread(rootThread.id);
          if (rootAfter === null || rootAfter.deletedAt !== null || rootAfter.archivedAt !== null) {
            const detail =
              rootAfter === null
                ? `Root thread ${rootThread.id} became unreachable.`
                : rootAfter.deletedAt !== null
                  ? `Root thread ${rootThread.id} was deleted.`
                  : `Root thread ${rootThread.id} was archived.`;
            yield* store
              .markTerminal({
                requestId: saved.requestId,
                status: "cancelled",
                resolvedBy: null,
                resolutionReason: detail,
              })
              .pipe(Effect.ignore);
            return yield* new SubtaskEscalationError({
              reason:
                rootAfter === null
                  ? "root_unreachable"
                  : rootAfter.deletedAt !== null
                    ? "root_deleted"
                    : "root_archived",
              detail,
            });
          }

          return { request: saved, replayed: false };
        }),
      );
    });

    const fulfillForDelegation: SubtaskEscalationServiceShape["fulfillForDelegation"] = Effect.fn(
      "SubtaskEscalationService.fulfillForDelegation",
    )(function* (input) {
      return yield* store.withRequestLock(
        input.requestId,
        Effect.gen(function* () {
          const existingOpt = yield* store.getById(input.requestId);
          if (Option.isNone(existingOpt)) {
            return yield* new SubtaskEscalationError({
              reason: "not_found",
              detail: `Subtask escalation request ${input.requestId} was not found.`,
            });
          }
          const existing = existingOpt.value;
          if (existing.rootThreadId !== input.callerThreadId) {
            return yield* new SubtaskEscalationError({
              reason: "privilege_denied",
              detail: `Only root thread ${existing.rootThreadId} may fulfill escalation request ${existing.requestId}.`,
            });
          }
          if (existing.status === "fulfilled" && existing.childThreadId !== null) {
            return {
              request: existing,
              replayed: true,
              childThreadId: existing.childThreadId,
              delegatedTaskId: existing.delegatedTaskId,
            };
          }
          if (existing.status === "cancelled" || existing.status === "rejected") {
            return yield* new SubtaskEscalationError({
              reason: "already_resolved",
              detail:
                existing.resolutionReason ??
                `Subtask escalation request ${existing.requestId} is ${existing.status}.`,
            });
          }

          const rootNow = yield* loadThread(existing.rootThreadId);
          if (rootNow === null || rootNow.deletedAt !== null || rootNow.archivedAt !== null) {
            const reason =
              rootNow === null
                ? ("root_unreachable" as const)
                : rootNow.deletedAt !== null
                  ? ("root_deleted" as const)
                  : ("root_archived" as const);
            const detail =
              reason === "root_unreachable"
                ? `Root thread ${existing.rootThreadId} could not be reached.`
                : reason === "root_deleted"
                  ? `Root thread ${existing.rootThreadId} was deleted.`
                  : `Root thread ${existing.rootThreadId} is archived.`;
            yield* store
              .markTerminal({
                requestId: existing.requestId,
                status: "cancelled",
                resolvedBy: null,
                resolutionReason: detail,
              })
              .pipe(Effect.ignore);
            return yield* new SubtaskEscalationError({ reason, detail });
          }

          const sourceAnchor: OrchestrationV2SubtaskSourceAnchor = {
            sourceThreadId: existing.sourceThreadId,
            ...(existing.sourceRunId === null ? {} : { sourceRunId: existing.sourceRunId }),
            ...(existing.sourceMessageId === null
              ? {}
              : { sourceMessageId: existing.sourceMessageId }),
            ...(existing.excerpt === null ? {} : { excerpt: existing.excerpt }),
          };

          const delegated = yield* input.runDelegation({
            request: existing,
            sourceAnchor,
          });

          const fulfilled = yield* store.markFulfilled({
            requestId: existing.requestId,
            childThreadId: delegated.childThreadId,
            delegatedTaskId: delegated.delegatedTaskId,
            resolvedBy: "agent",
            resolutionReason: "Fulfilled by L0 coordinator via delegate_task.",
          });

          return {
            request: fulfilled,
            replayed: false,
            childThreadId: delegated.childThreadId,
            delegatedTaskId: delegated.delegatedTaskId,
          };
        }),
      );
    });

    const resolveByHuman: SubtaskEscalationServiceShape["resolveByHuman"] = Effect.fn(
      "SubtaskEscalationService.resolveByHuman",
    )(function* (input) {
      return yield* store.withRequestLock(
        input.requestId,
        Effect.gen(function* () {
          const existingOpt = yield* store.getById(input.requestId);
          if (Option.isNone(existingOpt)) {
            return yield* new SubtaskEscalationError({
              reason: "not_found",
              detail: `Subtask escalation request ${input.requestId} was not found.`,
            });
          }
          const existing = existingOpt.value;
          if (input.decision === "reject") {
            if (existing.status === "fulfilled") {
              return yield* new SubtaskEscalationError({
                reason: "already_resolved",
                detail: `Escalation request ${existing.requestId} was already fulfilled with child ${existing.childThreadId}.`,
              });
            }
            if (existing.status === "rejected" || existing.status === "cancelled") {
              return { request: existing, childThreadId: existing.childThreadId };
            }
            const rejected = yield* store.markTerminal({
              requestId: existing.requestId,
              status: "rejected",
              resolvedBy: "user",
              resolutionReason: input.reason?.trim() || "Rejected by user.",
            });
            return { request: rejected, childThreadId: null };
          }

          // decision === "create_draft"
          const created = yield* createHumanDraftLocked({
            requestId: existing.requestId,
            sourceThreadId: existing.sourceThreadId,
            title: existing.title ?? undefined,
            task: existing.task,
            sourceRunId: existing.sourceRunId ?? undefined,
            sourceMessageId: existing.sourceMessageId ?? undefined,
            excerpt: existing.excerpt ?? undefined,
          });
          return {
            request: created.request,
            childThreadId: created.childThreadId,
          };
        }),
      );
    });

    return SubtaskEscalationService.of({
      createHumanDraft,
      submitAgentEscalation,
      fulfillForDelegation,
      resolveByHuman,
      listForThread: store.listForThread,
      getById: store.getById,
    });
  }),
);

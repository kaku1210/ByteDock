import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2SubtaskSourceAnchor,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { SubtaskSummaryGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffCoverage,
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import * as SubtaskSummaryCacheService from "./SubtaskSummaryCacheService.ts";

export class ContextHandoffPrepareError extends Schema.TaggedError<ContextHandoffPrepareError>()(
  "ContextHandoffPrepareError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to prepare context handoff for run ${this.targetRunId} in thread ${this.threadId}.`;
  }
}

export const ContextHandoffServiceV2Error = Schema.Union([ContextHandoffPrepareError]);
export type ContextHandoffServiceV2Error = typeof ContextHandoffServiceV2Error.Type;

export interface ContextHandoffServiceV2Shape {
  readonly prepareLegacyImport: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly toProviderThreadId: ProviderThreadId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareForkDelta: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareProviderHandoff: (input: {
    readonly threadId: ThreadId;
    /** Thread the items came from, when it is not `threadId` (a fork's source). */
    readonly sourceThreadId?: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly strategy: Extract<
      OrchestrationV2ContextHandoff["strategy"],
      "delta_since_target_last_seen" | "full_thread_summary"
    >;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly additionalContext?: string | undefined;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  /** Parent activity after the fork point, prepended to a side chat's first provider turn. */
  readonly prepareSideChatContext: (input: {
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  /** Budgeted semantic summary (with cached LLM generation + MVP skeleton fallback) for a subtask's first turn. */
  readonly prepareSubtaskContext: (input: {
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly parentTitle: string;
    readonly parentGoal?: string | null | undefined;
    readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
    readonly cwd?: string | null | undefined;
    readonly projectId?: ProjectId | null | undefined;
    readonly modelSelection?: ModelSelection | null | undefined;
    readonly summaryTimeoutMs?: number | undefined;
    readonly maxSummaryChars?: number | undefined;
    readonly strategyVersion?: string | undefined;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  /** Aggregated multi-source merge-back handoff with shared budget and per-source guaranteed floor. */
  readonly prepareMultiMergeBack: (input: {
    readonly targetThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly sources: ReadonlyArray<{
      readonly sourceThreadId: ThreadId;
      readonly sourceTitle: string;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
    }>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
}

export class ContextHandoffServiceV2 extends Context.Service<
  ContextHandoffServiceV2,
  ContextHandoffServiceV2Shape
>()("t3/orchestration-v2/ContextHandoffService/ContextHandoffServiceV2") {}

function compactText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  const end = maxLength - 3;
  const last = compacted.charCodeAt(end - 1);
  return `${compacted.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}...`;
}

export function visibleDeltaRunOrdinals(
  projection: { readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">> },
  items: ReadonlyArray<Pick<OrchestrationV2TurnItem, "runId">>,
): OrchestrationV2ContextHandoff["coveredRunOrdinals"] {
  const ordinalByRunId = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  let from = Infinity;
  let to = -Infinity;
  for (const item of items) {
    const ordinal = item.runId === null ? undefined : ordinalByRunId.get(item.runId);
    if (ordinal === undefined) continue;
    from = Math.min(from, ordinal);
    to = Math.max(to, ordinal);
  }
  return from === Infinity ? { from: 1, to: 1 } : { from, to };
}

/** Drops rolled-back runs and cancelled queued messages, which are not part of the conversation. */
export function visibleConversationItems(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts">,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const visible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items,
  });
  return items.filter(visible);
}

type ForkHistorySource = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "attempts">;

/** Visible rows of `source`'s own runs through `throughRun`, plus its v1 imported rows. */
const readOwnHistoryItems = Effect.fn("orchestrationV2.contextHandoff.readOwnHistoryItems")(
  function* (
    projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
    source: ForkHistorySource,
    throughRun: Pick<OrchestrationV2Run, "ordinal">,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(source.thread.id, ["turnItems"], {
      turnItemRunIds: [
        ...source.runs.filter((run) => run.ordinal <= throughRun.ordinal).map((run) => run.id),
        ...(source.thread.historyOrigin === "v1_import" ? [null] : []),
      ],
    });
    return visibleConversationItems(source, turnItems);
  },
);

/** History `thread` shows from its fork ancestors, oldest first. Side chats inherit no rows. */
export const readInheritedHandoffItems = Effect.fn(
  "orchestrationV2.contextHandoff.readInheritedHandoffItems",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  thread: OrchestrationV2AppThread,
) {
  const segments: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
  const seen = new Set([thread.id]);
  let current = thread;
  while (
    current.forkedFrom?.type === "run" &&
    current.lineage.sideChat !== true &&
    !seen.has(current.forkedFrom.threadId)
  ) {
    const { threadId, runId } = current.forkedFrom;
    seen.add(threadId);
    const source = yield* projectionStore
      .getThreadRecords(threadId, ["runs", "attempts"])
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    const forkRun = source?.runs.find((run) => run.id === runId);
    if (source === null || forkRun === undefined) break;
    segments.unshift(yield* readOwnHistoryItems(projectionStore, source, forkRun));
    current = source.thread;
  }
  return segments.flat();
});

/** What a portable fork from `throughRun` of `source` carries: inherited rows, then its own. */
export const readForkHistoryItems = Effect.fn(
  "orchestrationV2.contextHandoff.readForkHistoryItems",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  source: ForkHistorySource,
  throughRun: Pick<OrchestrationV2Run, "ordinal">,
) {
  return [
    ...(yield* readInheritedHandoffItems(projectionStore, source.thread)),
    ...(yield* readOwnHistoryItems(projectionStore, source, throughRun)),
  ];
});

function summarizeDeltaItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `- User: ${compactText(item.text)}`;
    case "assistant_message":
      return `- Assistant: ${compactText(item.text)}`;
    case "command_execution":
      return `- Command: ${compactText(item.input)}`;
    case "file_change":
      return `- File change: ${compactText(item.changes?.length ? item.changes.map((change) => change.path).join(", ") : item.fileName)}`;
    case "checkpoint":
      return `- Checkpoint: ${item.files.length} files`;
    case "handoff":
      return `- Handoff: ${compactText(item.summary ?? item.strategy)}`;
    default:
      return null;
  }
}

function makeForkDeltaSummary(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const itemLines = input.deltaItems.flatMap((item) => {
    const line = summarizeDeltaItem(item);
    return line === null ? [] : [line];
  });
  return [
    "Merge-back context from forked conversation.",
    `Source thread: ${input.sourceThreadId}`,
    `Target thread: ${input.targetThreadId}`,
    `Covered fork runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
    "Fork delta:",
    ...(itemLines.length === 0 ? ["- No user-visible delta items."] : itemLines),
  ].join("\n");
}

const MULTI_MERGE_BACK_MAX_CHARS = 12_000;

function makeMultiMergeBackSummary(input: {
  readonly targetThreadId: ThreadId;
  readonly sources: ReadonlyArray<{
    readonly sourceThreadId: ThreadId;
    readonly sourceTitle: string;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
  }>;
}): string {
  const header = `Merged context from ${input.sources.length} child threads into ${input.targetThreadId}:`;
  const omittedMarker = "- Earlier items omitted due to shared merge-back budget.";
  const sections = input.sources.map((source) => {
    const allLines = source.deltaItems.flatMap((item) => {
      const line = summarizeDeltaItem(item);
      return line === null ? [] : [line];
    });
    const lastAssistant = source.deltaItems.findLast((item) => item.type === "assistant_message");
    const floorLine =
      lastAssistant?.type === "assistant_message"
        ? `- Conclusion: ${compactText(lastAssistant.text, 320)}`
        : (allLines.at(-1) ?? "- No user-visible delta items.");
    const extraLines =
      lastAssistant?.type === "assistant_message"
        ? allLines.filter((line) => line !== `- Assistant: ${compactText(lastAssistant.text)}`)
        : allLines.slice(0, -1);
    const titleLine = `### ${compactText(source.sourceTitle, 120)} (${source.sourceThreadId}, runs ${source.coveredRunOrdinals.from}-${source.coveredRunOrdinals.to})`;
    const backRefLine = `Full history: t3_thread_read({ threadId: "${source.sourceThreadId}", view: "activity" })`;
    return {
      titleLine,
      floorLine,
      backRefLine,
      extraLines,
      keptExtras: [] as Array<string>,
      omitted: false,
    };
  });

  // Reserve guaranteed floor (header + each source's title, conclusion floor, back-ref, and omission slack).
  const fixedChars =
    header.length +
    sections.reduce(
      (sum, section) =>
        sum +
        2 +
        section.titleLine.length +
        1 +
        section.floorLine.length +
        1 +
        section.backRefLine.length +
        1 +
        omittedMarker.length,
      0,
    );
  let remaining = Math.max(0, MULTI_MERGE_BACK_MAX_CHARS - fixedChars);

  // Distribute remaining shared budget fairly across sources (round-robin, newest lines first).
  const cursors = sections.map((section) => section.extraLines.length - 1);
  let progressed = true;
  while (progressed && remaining > 0) {
    progressed = false;
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index]!;
      const cursor = cursors[index]!;
      if (cursor < 0) continue;
      const line = section.extraLines[cursor]!;
      cursors[index] = cursor - 1;
      if (line.length + 1 <= remaining) {
        section.keptExtras.unshift(line);
        remaining -= line.length + 1;
        progressed = true;
      } else {
        section.omitted = true;
        cursors[index] = -1;
      }
    }
  }
  for (let index = 0; index < sections.length; index++) {
    if (cursors[index]! >= 0) {
      sections[index]!.omitted = true;
    }
  }

  return [
    header,
    ...sections.flatMap((section) => [
      "",
      section.titleLine,
      ...(section.omitted ? [omittedMarker] : []),
      ...section.keptExtras,
      section.floorLine,
      section.backRefLine,
    ]),
  ].join("\n");
}

const SIDE_CHAT_CONTEXT_MAX_CHARS = 8_000;

/** Oldest first; raw parent items are summarized only until the context cap is reached. */
export function makeSideChatContext(input: {
  readonly parentThreadId: ThreadId;
  readonly digest: ReadonlyArray<string | OrchestrationV2TurnItem>;
}): string {
  const framing =
    "You are in a side chat beside the main thread. The main thread may still be running in the same worktree. Answer the user's questions; do not continue or redo the main thread's task.";
  const header = "Main thread activity since this side chat's starting point:";
  const truncated = "- Earlier items truncated.";
  const footer = `Use t3_thread_read on thread ${input.parentThreadId} to see the main thread's live state.`;
  const kept: Array<string> = [];
  let omitted = false;
  // The cap covers the whole block, so the fixed lines are reserved before any digest line.
  let remaining =
    SIDE_CHAT_CONTEXT_MAX_CHARS - [framing, "", header, truncated, "", footer].join("\n").length;
  for (let index = input.digest.length - 1; index >= 0; index--) {
    const item = input.digest[index]!;
    const line = typeof item === "string" ? item : summarizeDeltaItem(item);
    if (line === null) continue;
    if (line.length + 1 > remaining) {
      omitted = true;
      break;
    }
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  return [
    framing,
    ...(kept.length === 0 ? [] : ["", header, ...(omitted ? [truncated] : []), ...kept]),
    "",
    footer,
  ].join("\n");
}

/** Side chat and subtask inline contexts are prepended verbatim, never replayed as history. */
export const isSideChatContextHandoff = (handoff: OrchestrationV2ContextHandoff): boolean =>
  handoff.strategy === "manual_context" && handoff.transferId != null;

const SUBTASK_CONTEXT_MAX_CHARS = 8_000;
const SUBTASK_CONTEXT_MIN_MAX_CHARS = 256;
const DEFAULT_SUBTASK_SUMMARY_TIMEOUT_MS = 12_000;
const SUBTASK_SUMMARY_CONVERSATION_EXCERPT_MAX_CHARS = 28_000;
const SUBTASK_SUMMARY_MIN_BODY_CHARS = 160;

type SubtaskSummaryFallbackReason = "timeout" | "model_unavailable" | "budget_exceeded";

interface SubtaskSummaryFallbackNotice {
  readonly reason: SubtaskSummaryFallbackReason;
  readonly detail: string;
}

class SubtaskSummaryFallbackError extends Schema.TaggedError<SubtaskSummaryFallbackError>()(
  "SubtaskSummaryFallbackError",
  {
    reason: Schema.Literals(["timeout", "model_unavailable", "budget_exceeded"]),
    detail: Schema.String,
  },
) {}

function subtaskCutoffParts(input: {
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
}): ReadonlyArray<string> {
  return [
    input.sourceAnchor?.sourceRunId ? `run=${input.sourceAnchor.sourceRunId}` : null,
    input.sourceAnchor?.sourceOrdinal !== undefined
      ? `ordinal=${input.sourceAnchor.sourceOrdinal}`
      : input.coveredRunOrdinals.to > 0
        ? `runs=${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`
        : null,
    input.sourceAnchor?.sourceMessageId ? `message=${input.sourceAnchor.sourceMessageId}` : null,
    input.sourceAnchor?.sourceTurnItemId ? `item=${input.sourceAnchor.sourceTurnItemId}` : null,
  ].filter((part): part is string => part !== null);
}

function buildSubtaskReadBackAnchor(input: {
  readonly parentThreadId: ThreadId;
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const anchorItemId =
    input.sourceAnchor?.sourceTurnItemId ?? input.parentItems.at(-1)?.id ?? undefined;
  const anchorParts = [
    input.sourceAnchor?.sourceRunId ? `run=${input.sourceAnchor.sourceRunId}` : null,
    input.sourceAnchor?.sourceOrdinal !== undefined
      ? `ordinal=${input.sourceAnchor.sourceOrdinal}`
      : input.coveredRunOrdinals.to > 0
        ? `runs=${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`
        : null,
    input.sourceAnchor?.sourceMessageId ? `message=${input.sourceAnchor.sourceMessageId}` : null,
    anchorItemId ? `item=${anchorItemId}` : null,
  ].filter((part): part is string => part !== null);
  const anchorSuffix = anchorParts.length > 0 ? ` (cutoff anchor: ${anchorParts.join(", ")})` : "";
  return `Use t3_thread_read({ threadId: "${input.parentThreadId}", view: "activity" }) to inspect full parent history or later updates${anchorSuffix}.`;
}

function buildSubtaskBaseMetadataLines(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly parentGoal?: string | null | undefined;
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
}): ReadonlyArray<string> {
  const cutoffParts = subtaskCutoffParts(input);
  return [
    `Parent thread: ${compactText(input.parentTitle, 140)} (${input.parentThreadId})`,
    ...(input.sourceAnchor?.sourceThreadId &&
    input.sourceAnchor.sourceThreadId !== input.parentThreadId
      ? [`Escalated from sibling L1 subtask: ${input.sourceAnchor.sourceThreadId}`]
      : []),
    ...(cutoffParts.length > 0 ? [`Source cutoff: ${cutoffParts.join(", ")}`] : []),
    ...(input.parentGoal && input.parentGoal.trim().length > 0
      ? [`Parent goal: ${compactText(input.parentGoal, 320)}`]
      : []),
    ...(input.sourceAnchor?.excerpt
      ? [`Selected excerpt: ${compactText(input.sourceAnchor.excerpt, 600)}`]
      : []),
  ];
}

function formatSubtaskConversationExcerpt(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  maxChars = SUBTASK_SUMMARY_CONVERSATION_EXCERPT_MAX_CHARS,
): string {
  const entries: Array<string> = [];
  for (const item of items) {
    let body: string | null = null;
    switch (item.type) {
      case "user_message":
        body = `User: ${item.text.trim()}`;
        break;
      case "assistant_message":
        body = `Assistant: ${item.text.trim()}`;
        break;
      case "command_execution":
        body = `Command (exit=${item.exitCode ?? "unknown"}): ${compactText(item.input, 400)}`;
        break;
      case "file_change": {
        const paths = item.changes?.length
          ? item.changes.map((change) => `${change.operation}:${change.path}`).join(", ")
          : item.fileName;
        body = `File change: ${compactText(paths, 400)}`;
        break;
      }
      case "checkpoint":
        body = `Checkpoint: ${item.files.length} files`;
        break;
      case "handoff":
        body = `Handoff: ${compactText(item.summary ?? item.strategy, 500)}`;
        break;
      default:
        body = null;
        break;
    }
    if (body === null || body.length === 0) continue;
    entries.push(`[#${item.ordinal} item=${item.id}] ${body}`);
  }
  if (entries.length === 0) return "";

  const truncatedHeader = "[Earlier parent items truncated]";
  const kept: Array<string> = [];
  let omitted = false;
  let remaining = maxChars - truncatedHeader.length - 1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.length + 1 <= remaining) {
      kept.unshift(entry);
      remaining -= entry.length + 1;
      continue;
    }
    if (kept.length === 0 && remaining > 40) {
      kept.unshift(compactText(entry, remaining));
      remaining = 0;
    }
    omitted = true;
    break;
  }
  return [...(omitted ? [truncatedHeader] : []), ...kept].join("\n");
}

function formatSemanticBulletSection(title: string, items: ReadonlyArray<string>): Array<string> {
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (cleaned.length === 0) return [];
  return [`${title}:`, ...cleaned.map((item) => `- ${item}`)];
}

function renderSemanticSubtaskContext(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly parentGoal?: string | null | undefined;
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly summary: SubtaskSummaryGenerationResult;
  readonly strategyVersion: string;
  readonly cacheOutcome: SubtaskSummaryCacheService.SubtaskSummaryCacheOutcome;
  readonly modelInstanceId?: ProviderInstanceId | null | undefined;
  readonly modelSlug?: string | null | undefined;
}): string {
  const framing = `You are working in a dedicated subtask branched from parent thread ${input.parentThreadId}. Proceed with the user's instructions for this subtask; coordinate carefully if the parent shares this workspace.`;
  const modelTag =
    input.modelInstanceId && input.modelSlug
      ? `, model=${input.modelInstanceId}/${input.modelSlug}`
      : "";
  const metadataLines = [
    ...buildSubtaskBaseMetadataLines(input),
    `Context summary mode: semantic (${input.strategyVersion}, ${input.cacheOutcome}${modelTag})`,
  ];
  const header = "Parent semantic summary up to source cutoff:";
  const bodyLines: Array<string> = [
    ...(input.summary.goal.trim().length > 0 ? [`Goal: ${input.summary.goal.trim()}`] : []),
    ...(input.summary.summary.trim().length > 0
      ? [`Summary: ${input.summary.summary.trim()}`]
      : []),
    ...formatSemanticBulletSection("Constraints", input.summary.constraints),
    ...formatSemanticBulletSection("Decisions", input.summary.decisions),
    ...formatSemanticBulletSection("Open questions", input.summary.openQuestions),
    ...formatSemanticBulletSection("Key anchors", input.summary.keyAnchors),
  ];
  const footer = buildSubtaskReadBackAnchor(input);
  return [framing, "", ...metadataLines, "", header, ...bodyLines, "", footer].join("\n");
}

/** Budgeted structured skeleton from the parent cutoff, never framed as a read-only side chat. */
function makeSubtaskContext(input: {
  readonly parentThreadId: ThreadId;
  readonly parentTitle: string;
  readonly parentGoal?: string | null | undefined;
  readonly sourceAnchor?: OrchestrationV2SubtaskSourceAnchor | undefined;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly digest: ReadonlyArray<string | OrchestrationV2TurnItem>;
  readonly parentItems?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly maxChars?: number | undefined;
  readonly fallback?: SubtaskSummaryFallbackNotice | undefined;
}): string {
  const maxChars = Math.max(
    SUBTASK_CONTEXT_MIN_MAX_CHARS,
    Math.floor(input.maxChars ?? SUBTASK_CONTEXT_MAX_CHARS),
  );
  const framing = `You are working in a dedicated subtask branched from parent thread ${input.parentThreadId}. Proceed with the user's instructions for this subtask; coordinate carefully if the parent shares this workspace.`;
  const fallbackLine =
    input.fallback === undefined
      ? null
      : `Context summary fallback: mvp_skeleton (reason=${input.fallback.reason}: ${compactText(input.fallback.detail, 200)})`;
  const metadataLines = [
    ...buildSubtaskBaseMetadataLines(input),
    ...(fallbackLine === null ? [] : [fallbackLine]),
  ];
  const header = "Parent context up to source cutoff:";
  const truncated = "- Earlier items truncated.";
  const footer = buildSubtaskReadBackAnchor({
    parentThreadId: input.parentThreadId,
    sourceAnchor: input.sourceAnchor,
    coveredRunOrdinals: input.coveredRunOrdinals,
    parentItems:
      input.parentItems ??
      input.digest.filter((entry): entry is OrchestrationV2TurnItem => typeof entry !== "string"),
  });
  const kept: Array<string> = [];
  let omitted = false;
  let remaining =
    maxChars - [framing, "", ...metadataLines, "", header, truncated, "", footer].join("\n").length;
  for (let index = input.digest.length - 1; index >= 0; index--) {
    const item = input.digest[index]!;
    const line = typeof item === "string" ? item : summarizeDeltaItem(item);
    if (line === null) continue;
    if (line.length + 1 > remaining) {
      omitted = true;
      break;
    }
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  const fullRendered = [
    framing,
    "",
    ...metadataLines,
    ...(kept.length === 0 ? [] : ["", header, ...(omitted ? [truncated] : []), ...kept]),
    "",
    footer,
  ].join("\n");
  if (fullRendered.length <= maxChars) {
    return fullRendered;
  }

  // Tight-budget fallback: preserve framing, fallback reason, and t3_thread_read anchor within maxChars.
  const compactFraming = `Subtask of parent thread ${input.parentThreadId}.`;
  const essentialFooter =
    footer.length <= maxChars - 80
      ? footer
      : `Use t3_thread_read({ threadId: "${input.parentThreadId}", view: "activity" }) to inspect parent history.`;
  const compactFallback =
    input.fallback === undefined
      ? null
      : `Context summary fallback: mvp_skeleton (reason=${input.fallback.reason})`;
  const candidateBase = [
    compactFraming,
    ...(compactFallback === null ? [] : [compactFallback]),
    essentialFooter,
  ].join("\n");
  if (candidateBase.length <= maxChars) {
    return candidateBase;
  }
  return [...(compactFallback === null ? [] : [compactFallback]), essentialFooter]
    .join("\n")
    .slice(0, maxChars);
}

function makeLegacyImportSummary(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const sections = items.flatMap((item) => {
    switch (item.type) {
      case "user_message":
        return [{ label: "User", body: item.text }];
      case "assistant_message":
        return [{ label: "Assistant", body: item.text }];
      default:
        return [];
    }
  });
  const header =
    "Imported conversation history from the previous T3 Code orchestrator. Use it as context; do not repeat it unless the user asks.";
  const maxChars = 32_000;
  const selected: Array<string> = [];
  let remaining = maxChars - header.length - 2;
  for (const section of sections.toReversed()) {
    if (remaining <= 0) break;
    const fullSection = `${section.label}:\n${section.body}`;
    if (fullSection.length <= remaining) {
      selected.unshift(fullSection);
      remaining -= fullSection.length + 2;
      continue;
    }

    const prefix = `${section.label}:\n... `;
    const bodyBudget = remaining - prefix.length;
    if (bodyBudget <= 0) continue;

    const initialStart = section.body.length - bodyBudget;
    let bodyStart = Math.max(0, initialStart);
    if (
      bodyStart > 0 &&
      !/\s/.test(section.body[bodyStart - 1] ?? "") &&
      !/\s/.test(section.body[bodyStart] ?? "")
    ) {
      const nextWhitespace = section.body.slice(bodyStart).search(/\s/);
      if (nextWhitespace !== -1) {
        bodyStart += nextWhitespace;
      }
    }
    const codeUnitAtStart = section.body.charCodeAt(bodyStart);
    const codeUnitBeforeStart = section.body.charCodeAt(bodyStart - 1);
    if (
      codeUnitAtStart >= 0xdc00 &&
      codeUnitAtStart <= 0xdfff &&
      codeUnitBeforeStart >= 0xd800 &&
      codeUnitBeforeStart <= 0xdbff
    ) {
      bodyStart += 1;
    }
    const bodySuffix = section.body.slice(bodyStart).trimStart();
    if (bodySuffix.length === 0) continue;

    const suffix = `${prefix}${bodySuffix}`;
    selected.unshift(suffix);
    remaining -= suffix.length + 2;
  }
  return [header, ...selected].join("\n\n");
}

const makeContextHandoffService = Effect.fn("orchestrationV2.ContextHandoffService.layer")(
  function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const textGenerationOption = yield* Effect.serviceOption(TextGeneration.TextGeneration);
    const summaryCacheOption = yield* Effect.serviceOption(
      SubtaskSummaryCacheService.SubtaskSummaryCacheService,
    );
    const serverSettingsOption = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const tokenCap = yield* handoffTokenCapConfig.pipe(
      Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
    );

    const prepareLegacyImport = Effect.fn("orchestrationV2.contextHandoff.prepareLegacyImport")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly targetRunId: RunId;
        readonly toProviderThreadId: ProviderThreadId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.threadId,
            fromProviderInstanceId: ProviderInstanceId.make("legacy"),
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: [],
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({ ...input, coveredRunOrdinals: { from: 1, to: 1 } });
        const selected = selectHistory({
          messages: input.items.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: null,
          threadId: input.threadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeLegacyImportSummary(input.items),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareForkDelta = Effect.fn("orchestrationV2.contextHandoff.prepareForkDelta")(
      function* (input: {
        readonly sourceThreadId: ThreadId;
        readonly targetThreadId: ThreadId;
        readonly targetRunId: RunId;
        readonly transferId: OrchestrationV2ContextHandoff["transferId"];
        readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
        readonly toProviderThreadId: ProviderThreadId;
        readonly fromProviderInstanceId: ProviderInstanceId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
        readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.targetThreadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.targetThreadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({
          threadId: input.sourceThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          items: input.deltaItems,
        });
        const selected = selectHistory({
          messages: input.deltaItems.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.targetThreadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          strategy: "fork_delta_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeForkDeltaSummary(input),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareProviderHandoff = Effect.fn(
      "orchestrationV2.contextHandoff.prepareProviderHandoff",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly sourceThreadId?: ThreadId;
      readonly targetRunId: RunId;
      readonly transferId: OrchestrationV2ContextHandoff["transferId"];
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
      readonly fromProviderInstanceId: ProviderInstanceId;
      readonly toProviderInstanceId: ProviderInstanceId;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly runs?: ReadonlyArray<OrchestrationV2Run>;
      readonly strategy: Extract<
        OrchestrationV2ContextHandoff["strategy"],
        "delta_since_target_last_seen" | "full_thread_summary"
      >;
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
      readonly additionalContext?: string | undefined;
      readonly createdAt: DateTime.Utc;
    }) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      const runStatuses = new Map(input.runs?.map((run) => [run.id, run.status]));
      const coverage = handoffCoverage({
        ...input,
        threadId: input.sourceThreadId ?? input.threadId,
        additionalContext: input.additionalContext,
      });
      const selected = selectHistory({
        messages: input.items.flatMap((item) => {
          const message = historicalMessage(item);
          return message === null
            ? []
            : [
                {
                  ...message,
                  ...(item.runId === null ? {} : { runStatus: runStatuses.get(item.runId) }),
                },
              ];
        }),
        coverage,
        budget: tokenCap,
      });
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: input.strategy,
        status: "ready",
        summaryMessageId: null,
        summaryText: renderHistory(selected.messages, selected.context),
        history: {
          messages: selected.messages,
          coverage,
          omittedItems: selected.omittedItems,
          omittedItemIds: selected.omittedItemIds,
        },
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareSideChatContext = Effect.fn(
      "orchestrationV2.contextHandoff.prepareSideChatContext",
    )(function* (input: Parameters<ContextHandoffServiceV2Shape["prepareSideChatContext"]>[0]) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: [],
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: [],
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: "manual_context",
        status: "ready",
        summaryMessageId: null,
        summaryText: makeSideChatContext({
          parentThreadId: input.parentThreadId,
          digest: input.parentItems,
        }),
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareSubtaskContext = Effect.fn("orchestrationV2.contextHandoff.prepareSubtaskContext")(
      function* (input: Parameters<ContextHandoffServiceV2Shape["prepareSubtaskContext"]>[0]) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.threadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: [],
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );

        const maxSummaryChars = Math.max(
          SUBTASK_CONTEXT_MIN_MAX_CHARS,
          Math.floor(input.maxSummaryChars ?? SUBTASK_CONTEXT_MAX_CHARS),
        );
        const strategyVersion =
          input.strategyVersion?.trim() ||
          SubtaskSummaryCacheService.DEFAULT_SUBTASK_SUMMARY_STRATEGY_VERSION;
        const timeoutMs = Math.max(
          1,
          Math.floor(input.summaryTimeoutMs ?? DEFAULT_SUBTASK_SUMMARY_TIMEOUT_MS),
        );
        const conversationExcerpt = formatSubtaskConversationExcerpt(input.parentItems);

        const makeFallbackSummary = (fallback?: SubtaskSummaryFallbackNotice) =>
          makeSubtaskContext({
            parentThreadId: input.parentThreadId,
            parentTitle: input.parentTitle,
            parentGoal: input.parentGoal,
            sourceAnchor: input.sourceAnchor,
            coveredRunOrdinals: input.coveredRunOrdinals,
            digest: input.parentItems,
            parentItems: input.parentItems,
            maxChars: maxSummaryChars,
            fallback,
          });

        const summaryText =
          conversationExcerpt.length === 0
            ? makeFallbackSummary()
            : yield* Effect.gen(function* () {
                if (Option.isNone(textGenerationOption)) {
                  return yield* new SubtaskSummaryFallbackError({
                    reason: "model_unavailable",
                    detail: "Text generation service is unavailable.",
                  });
                }

                let resolvedModelSelection: ModelSelection | null = input.modelSelection ?? null;
                if (resolvedModelSelection === null && Option.isSome(serverSettingsOption)) {
                  resolvedModelSelection = yield* serverSettingsOption.value.getSettings.pipe(
                    Effect.map(
                      (settings) =>
                        resolveProjectSettings(settings, input.projectId ?? null).settings
                          .textGenerationModelSelection,
                    ),
                    Effect.orElseSucceed(() => null),
                  );
                }
                if (resolvedModelSelection === null) {
                  return yield* new SubtaskSummaryFallbackError({
                    reason: "model_unavailable",
                    detail: "No text generation model is configured for subtask summary.",
                  });
                }

                const wrapperOverhead = renderSemanticSubtaskContext({
                  parentThreadId: input.parentThreadId,
                  parentTitle: input.parentTitle,
                  parentGoal: input.parentGoal,
                  sourceAnchor: input.sourceAnchor,
                  coveredRunOrdinals: input.coveredRunOrdinals,
                  parentItems: input.parentItems,
                  summary: {
                    goal: "",
                    constraints: [],
                    decisions: [],
                    openQuestions: [],
                    keyAnchors: [],
                    summary: "",
                  },
                  strategyVersion,
                  cacheOutcome: "coalesced",
                  modelInstanceId: resolvedModelSelection.instanceId,
                  modelSlug: resolvedModelSelection.model,
                }).length;
                const semanticBodyBudget = maxSummaryChars - wrapperOverhead;
                if (semanticBodyBudget < SUBTASK_SUMMARY_MIN_BODY_CHARS) {
                  return yield* new SubtaskSummaryFallbackError({
                    reason: "budget_exceeded",
                    detail: `Remaining semantic summary budget (${Math.max(0, semanticBodyBudget)} chars) is below the ${SUBTASK_SUMMARY_MIN_BODY_CHARS}-char minimum.`,
                  });
                }

                const cutoffText = subtaskCutoffParts({
                  sourceAnchor: input.sourceAnchor,
                  coveredRunOrdinals: input.coveredRunOrdinals,
                }).join(", ");
                const resolvedCwd = input.cwd?.trim() || ".";
                const textGeneration = textGenerationOption.value;
                const selectedModel = resolvedModelSelection;

                const generateSummary = Effect.gen(function* () {
                  const generated = yield* textGeneration
                    .generateSubtaskSummary({
                      cwd: resolvedCwd,
                      parentThreadId: input.parentThreadId,
                      parentTitle: input.parentTitle,
                      parentGoal: input.parentGoal,
                      ...(cutoffText.length > 0 ? { sourceCutoff: cutoffText } : {}),
                      ...(input.sourceAnchor?.excerpt
                        ? { selectedExcerpt: input.sourceAnchor.excerpt }
                        : {}),
                      conversationExcerpt,
                      maxSummaryChars: semanticBodyBudget,
                      strategyVersion,
                      modelSelection: selectedModel,
                      projectId: input.projectId,
                    })
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new SubtaskSummaryFallbackError({
                            reason: "model_unavailable",
                            detail: compactText(
                              error.message || "Subtask summary model call failed.",
                              200,
                            ),
                          }),
                      ),
                      Effect.timeoutOrElse({
                        duration: Duration.millis(timeoutMs),
                        orElse: () =>
                          Effect.fail(
                            new SubtaskSummaryFallbackError({
                              reason: "timeout",
                              detail: `Semantic summary generation timed out after ${timeoutMs}ms.`,
                            }),
                          ),
                      }),
                    );

                  if (generated.goal.trim().length === 0 && generated.summary.trim().length === 0) {
                    return yield* new SubtaskSummaryFallbackError({
                      reason: "model_unavailable",
                      detail: "Model returned an empty semantic subtask summary.",
                    });
                  }

                  const candidateRendered = renderSemanticSubtaskContext({
                    parentThreadId: input.parentThreadId,
                    parentTitle: input.parentTitle,
                    parentGoal: input.parentGoal,
                    sourceAnchor: input.sourceAnchor,
                    coveredRunOrdinals: input.coveredRunOrdinals,
                    parentItems: input.parentItems,
                    summary: generated,
                    strategyVersion,
                    cacheOutcome: "coalesced",
                    modelInstanceId: selectedModel.instanceId,
                    modelSlug: selectedModel.model,
                  });
                  if (candidateRendered.length > maxSummaryChars) {
                    return yield* new SubtaskSummaryFallbackError({
                      reason: "budget_exceeded",
                      detail: `Semantic summary rendered ${candidateRendered.length} chars, exceeding the ${maxSummaryChars}-char context budget.`,
                    });
                  }

                  return {
                    summary: generated,
                    modelInstanceId: selectedModel.instanceId,
                    modelSlug: selectedModel.model,
                  } satisfies SubtaskSummaryCacheService.SubtaskSummaryGeneratedValue;
                });

                const lookupResult: {
                  readonly summary: SubtaskSummaryGenerationResult;
                  readonly outcome: SubtaskSummaryCacheService.SubtaskSummaryCacheOutcome;
                  readonly modelInstanceId: ProviderInstanceId | null;
                  readonly modelSlug: string | null;
                } = Option.isSome(summaryCacheOption)
                  ? yield* summaryCacheOption.value
                      .getOrGenerate({
                        key: SubtaskSummaryCacheService.buildSubtaskSummaryCacheKey({
                          parentThreadId: input.parentThreadId,
                          parentTitle: input.parentTitle,
                          parentGoal: input.parentGoal,
                          sourceAnchor: input.sourceAnchor,
                          coveredRunOrdinals: input.coveredRunOrdinals,
                          parentItems: input.parentItems,
                          maxSummaryChars,
                          strategyVersion,
                        }),
                        metadata: {
                          sourceRunId: input.sourceAnchor?.sourceRunId ?? null,
                          sourceOrdinal: input.sourceAnchor?.sourceOrdinal ?? null,
                          sourceMessageId: input.sourceAnchor?.sourceMessageId ?? null,
                          sourceTurnItemId:
                            input.sourceAnchor?.sourceTurnItemId ??
                            input.parentItems.at(-1)?.id ??
                            null,
                        },
                        generate: generateSummary,
                      })
                      .pipe(
                        Effect.timeoutOrElse({
                          duration: Duration.millis(timeoutMs),
                          orElse: () =>
                            Effect.fail(
                              new SubtaskSummaryFallbackError({
                                reason: "timeout",
                                detail: `Timed out waiting ${timeoutMs}ms for cached semantic summary.`,
                              }),
                            ),
                        }),
                        Effect.map(({ entry, outcome }) => ({
                          summary: entry.summary,
                          outcome,
                          modelInstanceId: entry.modelInstanceId,
                          modelSlug: entry.modelSlug,
                        })),
                      )
                  : yield* generateSummary.pipe(
                      Effect.map((generated) => ({
                        summary: generated.summary,
                        outcome: "generated" as const,
                        modelInstanceId: generated.modelInstanceId ?? null,
                        modelSlug: generated.modelSlug ?? null,
                      })),
                    );

                const rendered = renderSemanticSubtaskContext({
                  parentThreadId: input.parentThreadId,
                  parentTitle: input.parentTitle,
                  parentGoal: input.parentGoal,
                  sourceAnchor: input.sourceAnchor,
                  coveredRunOrdinals: input.coveredRunOrdinals,
                  parentItems: input.parentItems,
                  summary: lookupResult.summary,
                  strategyVersion,
                  cacheOutcome: lookupResult.outcome,
                  modelInstanceId: lookupResult.modelInstanceId,
                  modelSlug: lookupResult.modelSlug,
                });
                if (rendered.length > maxSummaryChars) {
                  return yield* new SubtaskSummaryFallbackError({
                    reason: "budget_exceeded",
                    detail: `Rendered semantic summary (${rendered.length} chars) exceeded the ${maxSummaryChars}-char context budget.`,
                  });
                }
                return rendered;
              }).pipe(
                Effect.catchTags({
                  SubtaskSummaryFallbackError: (fallback) =>
                    Effect.logDebug("Falling back to deterministic MVP subtask skeleton", {
                      threadId: input.threadId,
                      parentThreadId: input.parentThreadId,
                      reason: fallback.reason,
                      detail: fallback.detail,
                    }).pipe(
                      Effect.as(
                        makeFallbackSummary({
                          reason: fallback.reason,
                          detail: fallback.detail,
                        }),
                      ),
                    ),
                }),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logWarning(
                        "Unexpected defect preparing semantic subtask summary; falling back to MVP skeleton",
                        {
                          threadId: input.threadId,
                          parentThreadId: input.parentThreadId,
                          cause,
                        },
                      ).pipe(
                        Effect.as(
                          makeFallbackSummary({
                            reason: "model_unavailable",
                            detail: "Unexpected error during semantic summary generation.",
                          }),
                        ),
                      ),
                ),
              );

        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.threadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText,
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareMultiMergeBack = Effect.fn("orchestrationV2.contextHandoff.prepareMultiMergeBack")(
      function* (input: Parameters<ContextHandoffServiceV2Shape["prepareMultiMergeBack"]>[0]) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.targetThreadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.targetThreadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const minFrom = Math.min(...input.sources.map((source) => source.coveredRunOrdinals.from));
        const maxTo = Math.max(...input.sources.map((source) => source.coveredRunOrdinals.to));
        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.targetThreadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: {
            from: Number.isFinite(minFrom) ? minFrom : 1,
            to: Number.isFinite(maxTo) ? maxTo : 1,
          },
          strategy: "fork_delta_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeMultiMergeBackSummary({
            targetThreadId: input.targetThreadId,
            sources: input.sources,
          }),
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    return ContextHandoffServiceV2.of({
      prepareLegacyImport,
      prepareForkDelta,
      prepareProviderHandoff,
      prepareSideChatContext,
      prepareSubtaskContext,
      prepareMultiMergeBack,
    });
  },
);

export const layer: Layer.Layer<ContextHandoffServiceV2, never, IdAllocator.IdAllocatorV2> =
  Layer.effect(ContextHandoffServiceV2, makeContextHandoffService());

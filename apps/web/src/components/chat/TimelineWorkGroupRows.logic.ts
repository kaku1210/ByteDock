import { toServerClock } from "@t3tools/client-runtime/clock";
import { toolGroupAction } from "@t3tools/client-runtime/work-log/presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { workEntryDisplayIndicatesToolFailure, type WorkLogEntry } from "../../session-logic";
import { liveWorkEntryLabel } from "./MessagesTimeline.logic";

export const LONG_WORK_GROUP_SUMMARY_THRESHOLD = 8;
export const LONG_WORK_GROUP_EXPAND_HEIGHT_THRESHOLD = 12;

const GENERIC_READ_OUTPUTS = new Set([
  "tool execution",
  "read file",
  "file read",
  "file read successfully",
  "ok",
  "done",
  "success",
  "completed",
  "succeeded",
]);

const CODE_OR_DATA_PREFIX_PATTERN =
  /^(?:\d+\s*[:|\t]|[{[</#]|```|(?:import|export|const|let|var|function|class|interface|type|return|def|pub|fn|package|using)\s)/;

const GIT_COMMIT_COMMAND_PATTERN = /\bgit\b[\s\S]*\bcommit\b/;
const GIT_COMMIT_NON_COMMIT_FLAG_PATTERN = /(?:^|\s)(?:--dry-run|--help|-h)(?:\s|$)/;
const GIT_COMMIT_OUTPUT_HEADER_PATTERN = /^\[[^\]\r\n]+\s+[0-9a-f]{7,}\]\s+([^\r\n]+)$/m;
const GIT_COMMIT_MESSAGE_FLAG_PATTERN =
  /(?:^|\s)(?:-[a-zA-Z]*m|--message(?:=|\s+))\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'\r\n]+))/;

export interface WorkGroupProgressSummary {
  readonly totalSteps: number;
  readonly editedFileCount: number;
  readonly failedCount: number;
  readonly latestCommitMessage: string | null;
  readonly latestActionLabel: string | null;
  readonly latestIsInProgress: boolean;
}

export function formatWorkingTimerNow(startIso: string, environmentId: EnvironmentId): string {
  const startedAtMs = Date.parse(startIso);
  if (!Number.isFinite(startedAtMs)) {
    return m(msg("{seconds}s", { seconds: 0 }));
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((toServerClock(environmentId, Date.now()) - startedAtMs) / 1000),
  );
  if (elapsedSeconds < 60) {
    return m(msg("{seconds}s", { seconds: elapsedSeconds }));
  }

  return formatDuration(elapsedSeconds * 1_000, m);
}

function rawDynamicToolOutput(entry: WorkLogEntry): unknown {
  if (entry.structuredPayload?.type === "dynamic_tool") {
    return entry.structuredPayload.output;
  }
  if (entry.toolData !== null && typeof entry.toolData === "object" && "output" in entry.toolData) {
    return (entry.toolData as { readonly output?: unknown }).output;
  }
  return undefined;
}

/**
 * Antigravity ACP often returns a short single-line intent summary as the `output` of `Read`
 * dynamic tools (for example, `"Read prepareForkDelta implementation"`). Filter out file dumps,
 * code lines, bare paths, and generic placeholders so only readable summaries surface inline.
 */
export function extractWorkEntryReadIntentSummary(
  entry: WorkLogEntry,
  displayLabel?: string,
): string | null {
  if (toolGroupAction(entry) !== "read") return null;
  const raw = rawDynamicToolOutput(entry);
  if (typeof raw !== "string") return null;
  if (/[\r\n]/.test(raw)) return null;

  const summary = raw.replace(/\s+/g, " ").trim();
  if (summary.length < 4 || summary.length > 120) return null;
  if (summary.includes("[Earlier output truncated]")) return null;
  if (GENERIC_READ_OUTPUTS.has(summary.toLowerCase())) return null;
  if (CODE_OR_DATA_PREFIX_PATTERN.test(summary)) return null;
  // Reject bare file paths (no spaces and containing path separators or drive letters).
  if (!summary.includes(" ") && (/[\\/]/.test(summary) || /^[a-zA-Z]:/.test(summary))) {
    return null;
  }

  if (displayLabel) {
    const normalizedLabel = displayLabel.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedSummary = summary.toLowerCase();
    if (
      normalizedSummary === normalizedLabel ||
      (normalizedLabel.startsWith("read ") && normalizedSummary === normalizedLabel.slice(5))
    ) {
      return null;
    }
  }

  return summary;
}

function truncateSummary(text: string, maxLength = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function extractWorkEntryGitCommitMessage(entry: WorkLogEntry): string | null {
  if (entry.toolLifecycleStatus === "inProgress" || workEntryDisplayIndicatesToolFailure(entry)) {
    return null;
  }
  const command = entry.rawCommand ?? entry.command;
  if (!command || !GIT_COMMIT_COMMAND_PATTERN.test(command)) return null;
  if (GIT_COMMIT_NON_COMMIT_FLAG_PATTERN.test(command)) return null;

  const output =
    entry.structuredPayload?.type === "command_execution"
      ? entry.structuredPayload.output
      : entry.detail;
  if (typeof output === "string") {
    const outputMatch = GIT_COMMIT_OUTPUT_HEADER_PATTERN.exec(output);
    const fromOutput = outputMatch?.[1]?.trim();
    if (fromOutput) return truncateSummary(fromOutput);
  }

  const flagMatch = GIT_COMMIT_MESSAGE_FLAG_PATTERN.exec(command);
  const fromFlag = (flagMatch?.[1] ?? flagMatch?.[2] ?? flagMatch?.[3])?.trim();
  if (!fromFlag || fromFlag.startsWith("$") || fromFlag.startsWith("<<")) {
    return null;
  }
  return truncateSummary(fromFlag);
}

export function summarizeWorkGroupProgress(
  entries: ReadonlyArray<WorkLogEntry>,
  workspaceRoot: string | undefined,
): WorkGroupProgressSummary {
  const editedFiles = new Set<string>();
  let failedCount = 0;
  let latestCommitMessage: string | null = null;
  let latestInProgressEntry: WorkLogEntry | undefined;

  for (const entry of entries) {
    if (workEntryDisplayIndicatesToolFailure(entry)) {
      failedCount += 1;
    }
    if (entry.itemType === "file_change" || toolGroupAction(entry) === "edit") {
      for (const path of entry.changedFiles ?? []) {
        const normalized = path.trim().replaceAll("\\", "/");
        if (normalized.length > 0) editedFiles.add(normalized);
      }
    }
    if (entry.toolLifecycleStatus === "inProgress") {
      latestInProgressEntry = entry;
    }
    const commitMessage = extractWorkEntryGitCommitMessage(entry);
    if (commitMessage !== null) {
      latestCommitMessage = commitMessage;
    }
  }

  const latestEntry = latestInProgressEntry ?? entries.at(-1);
  const latestIsInProgress = latestInProgressEntry !== undefined;
  let latestActionLabel: string | null = null;
  if (latestEntry) {
    const fallbackLabel = liveWorkEntryLabel(latestEntry, workspaceRoot, latestIsInProgress);
    const readSummary = extractWorkEntryReadIntentSummary(latestEntry, fallbackLabel);
    const candidate = readSummary ?? fallbackLabel;
    latestActionLabel = candidate ? truncateSummary(candidate, 72) : null;
  }

  return {
    totalSteps: entries.length,
    editedFileCount: editedFiles.size,
    failedCount,
    latestCommitMessage,
    latestActionLabel,
    latestIsInProgress,
  };
}

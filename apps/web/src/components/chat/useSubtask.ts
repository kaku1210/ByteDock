import {
  CommandId,
  MAX_TASK_TREE_DEPTH,
  isTaskChildLineage,
  type AssistantCitation,
  type ModelSelection,
  type OrchestrationV2SubtaskSourceAnchor,
  type RunId,
  type RuntimeMode,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";

import { newThreadId, randomUUID } from "~/lib/utils";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";

function readTaskTreeDepth(threadRef: ScopedThreadRef | null): number {
  if (threadRef === null) return 0;
  let depth = 0;
  const seen = new Set<ThreadId>([threadRef.threadId]);
  let current = readThreadShell(threadRef);
  while (
    current !== null &&
    isTaskChildLineage(current.lineage) &&
    current.lineage.parentThreadId !== null &&
    depth <= MAX_TASK_TREE_DEPTH
  ) {
    depth += 1;
    const parentId = current.lineage.parentThreadId;
    if (seen.has(parentId)) break;
    seen.add(parentId);
    current = readThreadShell(scopeThreadRef(threadRef.environmentId, parentId));
  }
  return depth;
}

export function canSplitSubtaskFromThread(threadRef: ScopedThreadRef | null): boolean {
  if (threadRef === null) return false;
  const shell = readThreadShell(threadRef);
  if (shell === null || shell.lineage.sideChat === true) return false;
  return readTaskTreeDepth(threadRef) < MAX_TASK_TREE_DEPTH;
}

interface PendingSplitIntent {
  readonly key: string;
  readonly commandId: CommandId;
  readonly targetThreadId: ThreadId;
}

function splitIntentKey(
  threadRef: ScopedThreadRef,
  runId: RunId | undefined,
  citation: AssistantCitation | undefined,
): string {
  return JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    runId ?? null,
    citation?.messageId ?? null,
    citation?.text ?? null,
  ]);
}

function appendCitationDraft(threadRef: ScopedThreadRef, citation: AssistantCitation) {
  const drafts = useComposerDraftStore.getState();
  const prompt = drafts.getComposerDraft(threadRef)?.prompt ?? "";
  const formatted = formatAssistantCitationForComposer(citation, citation.comment);
  if (prompt.includes(formatted)) return;
  const separator = prompt && !/\s$/.test(prompt) ? " " : "";
  drafts.setPrompt(threadRef, `${prompt}${separator}${formatted}`);
}

/**
 * Splits a persistent subtask from `threadRef` anchored at the selected message/run or
 * latest stable cutoff. Prefills the subtask composer draft without auto-sending and
 * preserves idempotency across disconnect retries.
 */
export function useSubtask(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly resolveRunIdForMessage?: (
    messageId: AssistantCitation["messageId"],
  ) => RunId | undefined;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const pendingRef = useRef(false);
  const pendingIntentRef = useRef<PendingSplitIntent | null>(null);
  const createSubtask = useAtomCommand(threadEnvironment.createSubtask, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });

  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };

  const split = async (options?: {
    readonly citation?: AssistantCitation | undefined;
    readonly runId?: RunId | undefined;
    readonly title?: string | undefined;
  }): Promise<boolean> => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    try {
      const citation = options?.citation;
      const runId =
        options?.runId ??
        (citation ? input.resolveRunIdForMessage?.(citation.messageId) : undefined);
      const key = splitIntentKey(threadRef, runId, citation);
      const intent =
        pendingIntentRef.current?.key === key
          ? pendingIntentRef.current
          : {
              key,
              commandId: CommandId.make(randomUUID()),
              targetThreadId: newThreadId(),
            };
      pendingIntentRef.current = intent;
      const targetRef = scopeThreadRef(threadRef.environmentId, intent.targetThreadId);
      const excerpt = citation?.text.trim();
      const sourceAnchor: OrchestrationV2SubtaskSourceAnchor = {
        sourceThreadId: threadRef.threadId,
        ...(runId === undefined ? {} : { sourceRunId: runId }),
        ...(citation === undefined ? {} : { sourceMessageId: citation.messageId }),
        ...(excerpt && excerpt.length > 0 ? { excerpt } : {}),
      };
      const { runtimeMode, modelSelection } = input.readSettings();
      const created = await createSubtask({
        environmentId: threadRef.environmentId,
        input: {
          commandId: intent.commandId,
          sourceThreadId: threadRef.threadId,
          targetThreadId: intent.targetThreadId,
          ...(runId === undefined ? {} : { runId }),
          ...(options?.title === undefined ? {} : { title: options.title }),
          sourceAnchor,
        },
      });
      if (created._tag === "Failure") {
        reportFailure(created, "Could not create subtask.");
        return false;
      }
      if (modelSelection !== undefined) {
        useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
      }
      if (citation !== undefined) {
        appendCitationDraft(targetRef, citation);
      }
      // Persistent draft: never delete on client timeout; user can reconnect and open it.
      if (!(await waitForThreadShell(targetRef))) {
        input.onError(
          "The subtask was created, but its thread data did not reach this client yet. Reconnect or retry to open it.",
        );
        return false;
      }
      const subtaskShell = readThreadShell(targetRef);
      if (subtaskShell !== null && runtimeMode !== subtaskShell.runtimeMode) {
        await setThreadRuntimeMode({
          environmentId: threadRef.environmentId,
          input: {
            threadId: intent.targetThreadId,
            runtimeMode,
            createdAt: new Date().toISOString(),
          },
        });
      }
      pendingIntentRef.current = null;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetRef),
      });
      return true;
    } finally {
      pendingRef.current = false;
    }
  };

  const splitStable = useStableCallback(split);
  const splitFromCitation = useStableCallback((citation: AssistantCitation) => split({ citation }));

  return {
    available: input.threadRef !== null,
    split: splitStable,
    splitFromCitation,
  };
}

import {
  CommandId,
  MAX_TASK_TREE_DEPTH,
  SubtaskEscalationRequestId,
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
import { readThreadShell, useQuietThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";

/** Reactive task-tree depth guard for UI affordances (blocks L2+ and side chats). */
export function useCanSplitSubtaskFromThread(threadRef: ScopedThreadRef | null): boolean {
  const shell = useQuietThreadShell(threadRef);
  const parentRef =
    threadRef !== null &&
    shell !== null &&
    isTaskChildLineage(shell.lineage) &&
    shell.lineage.parentThreadId !== null
      ? scopeThreadRef(threadRef.environmentId, shell.lineage.parentThreadId)
      : null;
  const parentShell = useQuietThreadShell(parentRef);
  if (threadRef === null || shell === null || shell.lineage.sideChat === true) return false;
  if (!isTaskChildLineage(shell.lineage) || shell.lineage.parentThreadId === null) {
    return true;
  }
  if (shell.lineage.rootThreadId !== shell.lineage.parentThreadId) {
    return false;
  }
  if (
    parentShell !== null &&
    isTaskChildLineage(parentShell.lineage) &&
    parentShell.lineage.parentThreadId !== null
  ) {
    return false;
  }
  return MAX_TASK_TREE_DEPTH > 1;
}

/** Reactive L1-only guard for horizontal escalation to root L0 (hides on L0, L2+, side chats, remote). */
export function useCanEscalateSubtaskFromThread(threadRef: ScopedThreadRef | null): boolean {
  const shell = useQuietThreadShell(threadRef);
  const parentRef =
    threadRef !== null &&
    shell !== null &&
    isTaskChildLineage(shell.lineage) &&
    shell.lineage.parentThreadId !== null
      ? scopeThreadRef(threadRef.environmentId, shell.lineage.parentThreadId)
      : null;
  const parentShell = useQuietThreadShell(parentRef);
  if (
    threadRef === null ||
    shell === null ||
    shell.lineage.sideChat === true ||
    shell.delegatedFrom != null
  ) {
    return false;
  }
  if (!isTaskChildLineage(shell.lineage) || shell.lineage.parentThreadId === null) {
    return false;
  }
  if (shell.lineage.rootThreadId !== shell.lineage.parentThreadId) {
    return false;
  }
  if (parentShell !== null) {
    if (
      (isTaskChildLineage(parentShell.lineage) && parentShell.lineage.parentThreadId !== null) ||
      parentShell.archivedAt != null
    ) {
      return false;
    }
  }
  return true;
}

interface PendingSplitIntent {
  readonly key: string;
  readonly commandId: CommandId;
  readonly targetThreadId: ThreadId;
}

interface PendingEscalationIntent {
  readonly key: string;
  readonly requestId: SubtaskEscalationRequestId;
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
 * latest stable cutoff, and supports horizontal escalation from L1 to root L0 as a new
 * sibling L1 draft. Prefills the draft composer without auto-sending and preserves
 * idempotency across disconnect retries.
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
  const pendingEscalationIntentRef = useRef<PendingEscalationIntent | null>(null);
  const createSubtask = useAtomCommand(threadEnvironment.createSubtask, { reportFailure: false });
  const escalateSubtaskToRoot = useAtomCommand(threadEnvironment.escalateSubtaskToRoot, {
    reportFailure: false,
  });
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

  const escalate = async (options?: {
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
        pendingEscalationIntentRef.current?.key === key
          ? pendingEscalationIntentRef.current
          : {
              key,
              requestId: SubtaskEscalationRequestId.make(`esc:user:${randomUUID()}`),
              targetThreadId: newThreadId(),
            };
      pendingEscalationIntentRef.current = intent;
      const excerpt = citation?.text.trim();
      const { runtimeMode, modelSelection } = input.readSettings();
      const created = await escalateSubtaskToRoot({
        environmentId: threadRef.environmentId,
        input: {
          requestId: intent.requestId,
          sourceThreadId: threadRef.threadId,
          targetThreadId: intent.targetThreadId,
          ...(runId === undefined ? {} : { sourceRunId: runId }),
          ...(citation === undefined ? {} : { sourceMessageId: citation.messageId }),
          ...(excerpt && excerpt.length > 0 ? { excerpt, task: excerpt } : {}),
          ...(options?.title === undefined ? {} : { title: options.title }),
        },
      });
      if (created._tag === "Failure") {
        reportFailure(created, "Could not escalate subtask to root.");
        return false;
      }
      const targetThreadId = created.value.childThreadId;
      const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
      if (modelSelection !== undefined) {
        useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
      }
      if (citation !== undefined) {
        appendCitationDraft(targetRef, citation);
      }
      if (!(await waitForThreadShell(targetRef))) {
        input.onError(
          "The escalated L1 subtask was created, but its thread data did not reach this client yet. Reconnect or retry to open it.",
        );
        return false;
      }
      const escalatedShell = readThreadShell(targetRef);
      if (escalatedShell !== null && runtimeMode !== escalatedShell.runtimeMode) {
        await setThreadRuntimeMode({
          environmentId: threadRef.environmentId,
          input: {
            threadId: targetThreadId,
            runtimeMode,
            createdAt: new Date().toISOString(),
          },
        });
      }
      pendingEscalationIntentRef.current = null;
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
  const escalateStable = useStableCallback(escalate);
  const escalateFromCitation = useStableCallback((citation: AssistantCitation) =>
    escalate({ citation }),
  );

  return {
    available: input.threadRef !== null,
    split: splitStable,
    splitFromCitation,
    escalate: escalateStable,
    escalateFromCitation,
  };
}

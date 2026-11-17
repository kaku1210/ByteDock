import type {
  AssistantCitation,
  ModelSelection,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { registerTemporaryChat } from "../../temporaryChats";

function appendCitation(threadRef: ScopedThreadRef, citation: AssistantCitation) {
  const drafts = useComposerDraftStore.getState();
  const prompt = drafts.getComposerDraft(threadRef)?.prompt ?? "";
  const separator = prompt && !/\s$/.test(prompt) ? " " : "";
  drafts.setPrompt(
    threadRef,
    `${prompt}${separator}${formatAssistantCitationForComposer(citation, citation.comment)}`,
  );
}

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, sends `prompt` there with `readSettings()`, the parent
 * composer's settings, and shows the tab. It resolves false when the side chat did not
 * start, or another one is still starting.
 */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
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
  const start = async (
    threadRef: ScopedThreadRef,
    prompt: string | undefined,
    temporary: boolean,
    citation?: AssistantCitation,
  ) => {
    const { runtimeMode, modelSelection } = input.readSettings();
    const targetThreadId = newThreadId();
    const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
    if (temporary && !(await registerTemporaryChat(targetRef))) return false;
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        targetThreadId,
        title: temporary ? "Temporary side chat" : "Side chat",
        ...(temporary ? { temporary: true } : {}),
      },
    });
    if (fork._tag === "Failure") {
      reportFailure(fork, "Could not start a side chat.");
      return false;
    }
    // Drops the empty side chat a failed start leaves behind; one that got its message stays.
    const discard = () =>
      void deleteThread({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, onlyIfUnused: true },
      });
    if (!(await waitForThreadShell(targetRef))) {
      input.onError("The side chat was created, but it did not reach this client.");
      discard();
      return false;
    }
    const sideChat = readThreadShell(targetRef);
    if (sideChat === null) {
      input.onError("The side chat is no longer available.");
      discard();
      return false;
    }
    if (runtimeMode !== sideChat.runtimeMode) {
      const mode = await setThreadRuntimeMode({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, runtimeMode, createdAt: new Date().toISOString() },
      });
      if (mode._tag === "Failure") {
        reportFailure(mode, "Could not set the side chat's permission mode.");
        discard();
        return false;
      }
    }
    const text = prompt?.trim();
    if (text) {
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          ...(modelSelection === undefined ? {} : { modelSelection }),
          titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure") {
        reportFailure(turn, "Could not send the side chat message.");
        discard();
        return false;
      }
    } else if (modelSelection !== undefined) {
      useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
    }
    if (citation) appendCitation(targetRef, citation);
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId, temporary);
    return true;
  };
  const open = async (prompt?: string, temporary = false, citation?: AssistantCitation) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    if (temporary && !prompt?.trim() && !citation) {
      const surface = selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      );
      if (surface?.kind === "side-chat") {
        const targetRef = scopeThreadRef(threadRef.environmentId, surface.threadId);
        const thread = readThreadShell(targetRef);
        if (
          thread?.lineage.temporary === true &&
          thread.lineage.parentThreadId === threadRef.threadId &&
          thread.latestRun === null &&
          thread.source.activeRunId === null &&
          thread.itemCount === 0 &&
          thread.source.status === "idle" &&
          !composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(targetRef))
        ) {
          return true;
        }
      }
    }
    if (citation) {
      const surface = selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      );
      if (surface?.kind === "side-chat") {
        const targetRef = scopeThreadRef(threadRef.environmentId, surface.threadId);
        if (readThreadShell(targetRef) !== null) {
          appendCitation(targetRef, citation);
          return true;
        }
      }
    }
    pendingRef.current = true;
    return start(threadRef, prompt, temporary, citation).finally(() => {
      pendingRef.current = false;
    });
  };
  const cite = (citation: AssistantCitation) => open(undefined, true, citation);
  return {
    available: input.threadRef !== null,
    open: useStableCallback(open),
    cite: useStableCallback(cite),
  };
}

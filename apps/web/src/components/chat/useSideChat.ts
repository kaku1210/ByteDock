import { msg } from "gt-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import type {
  AssistantCitation,
  ModelSelection,
  RuntimeMode,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

function appendCitation(threadRef: ScopedThreadRef, citation: AssistantCitation) {
  const drafts = useComposerDraftStore.getState();
  const prompt = drafts.getComposerDraft(threadRef)?.prompt ?? "";
  const separator = prompt && !/\s$/.test(prompt) ? " " : "";
  drafts.setPrompt(
    threadRef,
    `${prompt}${separator}${formatAssistantCitationForComposer(citation, citation.comment)}`,
  );
}

export type SideChatMessage = Pick<
  StartThreadTurnInput["message"],
  "text" | "attachments" | "context"
> & { readonly titleSeed: string };

export interface StartSideChatDeps {
  readonly forkSideChat: (input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: {
      readonly sourceThreadId: ScopedThreadRef["threadId"];
      readonly targetThreadId: ScopedThreadRef["threadId"];
      readonly title: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly deleteThread: (input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: {
      readonly threadId: ScopedThreadRef["threadId"];
      readonly onlyIfUnused: boolean;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly setThreadRuntimeMode: (input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: {
      readonly threadId: ScopedThreadRef["threadId"];
      readonly runtimeMode: RuntimeMode;
      readonly createdAt: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly startThreadTurn: (input: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: {
      readonly threadId: ScopedThreadRef["threadId"];
      readonly message: StartThreadTurnInput["message"];
      readonly modelSelection?: ModelSelection;
      readonly titleSeed: string;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: "default";
      readonly createdAt: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly waitForThreadShell: (ref: ScopedThreadRef) => Promise<boolean>;
  readonly readThreadShell: (ref: ScopedThreadRef) => { readonly runtimeMode: RuntimeMode } | null;
  readonly setModelSelection: (ref: ScopedThreadRef, modelSelection: ModelSelection) => void;
  readonly appendCitation: (ref: ScopedThreadRef, citation: AssistantCitation) => void;
  readonly openThread: (
    parentRef: ScopedThreadRef,
    targetThreadId: ScopedThreadRef["threadId"],
  ) => void;
  readonly newThreadId: () => ScopedThreadRef["threadId"];
  readonly newMessageId: () => StartThreadTurnInput["message"]["messageId"];
  readonly nowIso: () => string;
}

export async function startSideChatFlow(input: {
  readonly threadRef: ScopedThreadRef;
  readonly message: SideChatMessage | undefined;
  readonly citation?: AssistantCitation;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
  readonly deps: StartSideChatDeps;
}): Promise<boolean> {
  const { deps, threadRef, message, citation } = input;
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(thrownErrorMessage(error, m) ?? fallback);
  };

  const { runtimeMode, modelSelection } = input.readSettings();
  const targetThreadId = deps.newThreadId();
  const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
  const fork = await deps.forkSideChat({
    environmentId: threadRef.environmentId,
    // oxlint-disable-next-line t3code/no-untranslated-copy -- stored on the server as the thread title, shared by every viewer
    input: { sourceThreadId: threadRef.threadId, targetThreadId, title: "Side chat" },
  });
  if (fork._tag === "Failure") {
    reportFailure(fork, m(msg("Could not start a side chat.")));
    return false;
  }
  // Drops the empty side chat when a post-creation command explicitly fails; never delete on
  // local shell sync timeout because the side chat already exists on the server.
  const discard = () =>
    void deps.deleteThread({
      environmentId: threadRef.environmentId,
      input: { threadId: targetThreadId, onlyIfUnused: true },
    });
  if (!(await deps.waitForThreadShell(targetRef))) {
    input.onError(m(msg("The side chat was created, but it did not reach this client.")));
    return false;
  }
  const sideChat = deps.readThreadShell(targetRef);
  if (sideChat === null) {
    input.onError(m(msg("The side chat is no longer available.")));
    return false;
  }
  if (runtimeMode !== sideChat.runtimeMode) {
    const mode = await deps.setThreadRuntimeMode({
      environmentId: threadRef.environmentId,
      input: { threadId: targetThreadId, runtimeMode, createdAt: deps.nowIso() },
    });
    if (mode._tag === "Failure") {
      reportFailure(mode, m(msg("Could not set the side chat's permission mode.")));
      discard();
      return false;
    }
  }
  // Send before showing the tab: closing a tab whose side chat has no run deletes it.
  if (message) {
    const { titleSeed, ...content } = message;
    const turn = await deps.startThreadTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: targetThreadId,
        message: { messageId: deps.newMessageId(), role: "user", ...content },
        ...(modelSelection === undefined ? {} : { modelSelection }),
        titleSeed,
        runtimeMode,
        interactionMode: "default",
        createdAt: deps.nowIso(),
      },
    });
    if (turn._tag === "Failure") {
      reportFailure(turn, m(msg("Could not send the side chat message.")));
      discard();
      return false;
    }
  } else if (modelSelection !== undefined) {
    deps.setModelSelection(targetRef, modelSelection);
  }
  if (citation) deps.appendCitation(targetRef, citation);
  deps.openThread(threadRef, targetThreadId);
  return true;
}

/**
 * Starts side chats from `threadRef`, or offers none when it is null. `open` forks the
 * thread's latest stable point, sends `message` there with `readSettings()`, the parent
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
  const start = async (
    threadRef: ScopedThreadRef,
    message: SideChatMessage | undefined,
    citation?: AssistantCitation,
  ) =>
    startSideChatFlow({
      threadRef,
      message,
      ...(citation === undefined ? {} : { citation }),
      readSettings: input.readSettings,
      onError: input.onError,
      deps: {
        forkSideChat,
        deleteThread,
        setThreadRuntimeMode,
        startThreadTurn,
        waitForThreadShell,
        readThreadShell,
        setModelSelection: (targetRef, modelSelection) => {
          useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
        },
        appendCitation,
        openThread: (parentRef, targetThreadId) => {
          useRightPanelStore.getState().openThread(parentRef, targetThreadId);
        },
        newThreadId,
        newMessageId,
        nowIso: () => new Date().toISOString(),
      },
    });
  const open = async (message?: SideChatMessage) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, message).finally(() => {
      pendingRef.current = false;
    });
  };
  const cite = async (citation: AssistantCitation) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    const surface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    if (surface?.kind === "thread") {
      const targetRef = scopeThreadRef(threadRef.environmentId, surface.threadId);
      if (readThreadShell(targetRef)?.lineage.sideChat === true) {
        appendCitation(targetRef, citation);
        return true;
      }
    }
    pendingRef.current = true;
    return start(threadRef, undefined, citation).finally(() => {
      pendingRef.current = false;
    });
  };
  return {
    available: input.threadRef !== null,
    open: useStableCallback(open),
    cite: useStableCallback(cite),
  };
}

import { useUiLanguage } from "../../i18n/useUiLanguage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import { clearThreadLocalData } from "../../lib/clearThreadLocalData";
import { forgetTemporaryChat } from "../../temporaryChats";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellHasSnapshot } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";
import { useOpenThreadFamily } from "../../hooks/useOpenThreadFamily";

/** A side chat tab: its title, Bring back, Delete and Close, over the side chat's own chat. */
export default function SideChatPane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { text: uiText } = useUiLanguage();
  const { parentRef, threadId } = props;
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  const shell = useQuietThreadShell(threadRef);
  const rootThreadId = shell?.lineage.parentThreadId ?? parentRef.threadId;
  const rootShell = useQuietThreadShell(scopeThreadRef(parentRef.environmentId, rootThreadId));
  const temporary = shell?.lineage.temporary === true;
  const snapshotLoaded = useEnvironmentShellHasSnapshot(parentRef.environmentId);
  useOpenThreadFamily(threadRef, snapshotLoaded && shell === null);
  const projection = useQuietThreadProjection(shell === null ? null : threadRef)?.projection;
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [bringingBack, setBringingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mergeRun = projection ? resolveLatestMergeBackRun(projection) : null;
  const bringBackBlockedReason = !canOperate
    ? "This connection cannot change threads."
    : temporary
      ? "Temporary side chats cannot be brought back to the main thread."
      : mergeRun === null
        ? "Available after a finished reply."
        : null;

  const bringBack = async () => {
    if (bringBackBlockedReason !== null || mergeRun === null || bringingBack) return;
    setBringingBack(true);
    const result = await mergeBack({
      environmentId: parentRef.environmentId,
      input: {
        sourceThreadId: threadId,
        targetThreadId: rootThreadId,
        runId: mergeRun.id,
      },
    });
    setBringingBack(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Brought back",
        description: rootShell?.title
          ? `"${rootShell.title}" gets this side chat with your next message there.`
          : "The main thread gets this side chat with your next message there.",
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not bring back the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (confirmThreadDelete && !temporary) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Delete side chat "${shell.title}"?`,
            "This permanently clears its conversation history.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    setDeleting(true);
    const result = await deleteThread({
      environmentId: parentRef.environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      clearThreadLocalData(threadRef);
      forgetTemporaryChat(threadRef);
      useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${threadId}`);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not delete the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <div data-side-chat-pane={threadId} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {shell?.title ?? "Side chat"}
        </span>
        {temporary ? (
          <span className="text-xs text-muted-foreground">{uiText("Temporary side chat")}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-disabled={bringBackBlockedReason !== null || bringingBack || undefined}
                  onClick={() => void bringBack()}
                >
                  {uiText("Bring back")}
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {bringBackBlockedReason ??
                (rootShell?.title
                  ? `Adds this side chat to "${rootShell.title}"'s next message.`
                  : "Adds this side chat to the main thread's next message.")}
            </TooltipPopup>
          </Tooltip>
        )}
        {!temporary ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={uiText("Delete side chat")}
            disabled={!canOperate || shell === null || deleting}
            onClick={() => void deleteSideChat()}
          >
            <Trash2Icon />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={uiText(temporary ? "Hide temporary side chat" : "Close side chat")}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {shell === null ? (
        snapshotLoaded ? (
          <p className="p-3 text-xs text-muted-foreground">
            {uiText("This side chat was deleted.")}
          </p>
        ) : null
      ) : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={parentRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}

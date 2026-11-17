import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { clearThreadLocalData } from "../../lib/clearThreadLocalData";
import { useRightPanelStore } from "../../rightPanelStore";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { forgetTemporaryChat } from "../../temporaryChats";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

export function CloseTemporarySideChat(props: {
  parentRef: ScopedThreadRef;
  threadId: ThreadId;
  title: string;
}) {
  const { text: uiText } = useUiLanguage();
  const allowed = useEnvironmentScope(props.parentRef.environmentId, AuthOrchestrationOperateScope);
  const remove = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const close = async () => {
    if (!allowed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const result = await remove({
      environmentId: props.parentRef.environmentId,
      input: { threadId: props.threadId },
    });
    pending.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : uiText("Could not delete temporary side chat"),
        );
      }
      return;
    }
    const ref = scopeThreadRef(props.parentRef.environmentId, props.threadId);
    clearThreadLocalData(ref);
    forgetTemporaryChat(ref);
    useRightPanelStore.getState().closeSurface(props.parentRef, `side-chat:${props.threadId}`);
    setOpen(false);
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              tone="destructive"
              aria-label={`${uiText("Close temporary side chat")}: ${props.title}`}
              disabled={!allowed}
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            />
          }
        >
          <XIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup>{uiText("Close temporary side chat")}</TooltipPopup>
      </Tooltip>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!pending.current) setOpen(value);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{uiText("Close temporary side chat?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {props.title}
              {": "}
              {uiText(
                "Closing stops this temporary chat and removes its draft and manual tasks. Hiding the pane keeps it available in thread details. Temporary chats are also cleaned up on app exit, or recovered for cleanup after an abnormal exit.",
              )}
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              {uiText("Cancel")}
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy || !allowed} onClick={() => void close()}>
              {uiText("Confirm close")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

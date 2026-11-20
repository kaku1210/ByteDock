import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";

import type { ToolCallDiffTarget } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatShellLocation {
  readonly cwd?: string | undefined;
  readonly worktreePath?: string | null | undefined;
}

export interface SideChatParentPanel {
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string, location?: SideChatShellLocation) => void;
}

/** Opens `thread` in its tab when it is a side chat of `parentRef` or its task-tree root; false otherwise. */
export function openSideChatTab(
  parentRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage"> | null,
  sideChatOwnerThreadId?: OrchestrationV2ThreadShell["id"] | null,
): boolean {
  const ownerThreadId = sideChatOwnerThreadId ?? parentRef.threadId;
  if (
    thread?.lineage.sideChat !== true ||
    (thread.lineage.parentThreadId !== parentRef.threadId &&
      thread.lineage.parentThreadId !== ownerThreadId)
  ) {
    return false;
  }
  useRightPanelStore.getState().openSideChat(parentRef, thread.id, thread.lineage.temporary);
  return true;
}

import { useEffect, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { finishTaskJump, useThreadTaskNavigation, type TaskJump } from "./threadTaskNavigation";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

export function useTaskJump(input: {
  jump: TaskJump | null;
  rowIndex: number;
  listRef: RefObject<LegendListRef | null>;
  container: HTMLElement | null;
  ready: boolean;
  navigate: () => void;
  history: MessagesTimelineHistoryControls | undefined;
}) {
  const { jump, rowIndex, listRef, container, ready, navigate, history } = input;
  const requestId = jump?.requestId;
  const entryId = jump?.match.entryId;
  const stepId = jump?.destination === "source" ? jump.stepId : undefined;
  const pending = jump?.status === "pending";
  const located = jump?.status === "located";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes the temporary navigation highlight after the user has seen the destination
  useEffect(() => {
    if (!located) return;
    const timer = setTimeout(
      () =>
        useThreadTaskNavigation.setState((state) =>
          state.jump?.requestId === requestId ? { jump: null } : state,
        ),
      1800,
    );
    return () => clearTimeout(timer);
  }, [located, requestId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- materializes a requested virtual row and observes its mounted target before reporting navigation success
  useEffect(() => {
    if (!pending || requestId === undefined || !entryId || !ready || !container) return;
    if (rowIndex < 0) {
      if (history?.loading) return;
      if (history?.error || !history?.hasMoreHistory) finishTaskJump(requestId, "missing");
      else history.onLoadEarlier(entryId);
      return;
    }
    navigate();
    let cancelled = false;
    let completed = false;
    const reveal = () => {
      if (cancelled || completed) return;
      const row = container.querySelector<HTMLElement>(
        `[data-work-entry-id="${CSS.escape(entryId)}"], [data-timeline-row-id="${CSS.escape(entryId)}"]`,
      );
      const target = stepId
        ? row?.querySelector<HTMLElement>(`[data-task-step-id="${CSS.escape(stepId)}"]`)
        : row;
      if (!target || target.getBoundingClientRect().height === 0) return;
      const scrollNode = listRef.current?.getScrollableNode();
      if (!scrollNode) return;
      const top = target.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top;
      void listRef.current?.scrollToOffset({
        offset: Math.max(0, scrollNode.scrollTop + top - 80),
        animated: false,
      });
      completed = true;
      finishTaskJump(requestId, "located");
    };
    const observer = new MutationObserver(reveal);
    observer.observe(container, { childList: true, subtree: true });
    reveal();
    if (!completed) {
      void listRef.current
        ?.scrollToIndex({ index: rowIndex, animated: false, viewOffset: 80 })
        .then(reveal, () => {
          if (!cancelled && !completed) finishTaskJump(requestId, "missing");
        });
    }
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [requestId, entryId, stepId, pending, rowIndex, ready, container, history, listRef, navigate]);
}

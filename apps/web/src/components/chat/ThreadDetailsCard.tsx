import { PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useThreadDetailsPreferences } from "./threadDetailsPreferences";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  useLayoutEffect,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  THREAD_DETAILS_CARD_GAP,
  resolveThreadDetailsCardDensity,
} from "./threadDetailsCardLayout";
import { observeResize } from "../../lib/observeResize";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";

export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  contentKey,
  onContextMenu,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  /** Changes when the set of rendered items changes, so cached heights are measured again. */
  contentKey: string;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}) {
  const { text } = useUiLanguage();
  const preferences = useThreadDetailsPreferences();
  const detailsArea = workspaceAreaProps("details", 3, "Thread details");
  const canvas = useChatCanvas();
  const preferredPlacement = canvas?.preferredDetailsCard ?? null;
  const placement = preferences.pinned
    ? {
        right: 12,
        y: 12,
        width: Math.min(preferences.width, Math.max(240, (canvas?.container.width ?? 400) - 24)),
        height: Math.max(160, (canvas?.container.height ?? 600) - 24),
      }
    : (canvas?.detailsCardPlacement ?? null);
  const mode = placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const measurementKey = `${threadRef.environmentId}:${threadRef.threadId}:${preferredPlacement?.width ?? "popup"}:${contentKey}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
  });
  const contentHeights =
    measurements.key === measurementKey ? measurements.heights : { full: 0, compact: 0 };
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const density = preferences.pinned
    ? "full"
    : resolveThreadDetailsCardDensity(height, contentHeights);
  const measureDetailsCard = canvas?.measureDetailsCard;
  const cardWidth = preferredPlacement?.width;
  // The mode derives from canvas measurements, the preview frame and the
  // inline flag, which live in three stores, so no single write site sees the
  // card leave popover mode. A flag left set would reopen the popover unasked
  // when the card returns to popover mode.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover flag in the right panel store when the derived mode turns inline
  useLayoutEffect(() => {
    if (mode === "inline" && popoverOpen)
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
  }, [mode, popoverOpen, threadRef]);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const { environmentId, threadId } = threadRef;
  // Re-measures when the density or measurement key changes, so each density's
  // height is measured once it renders.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the card's DOM height via ResizeObserver and reports it to the canvas
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // PR lists, servers, lineage, side chats and automations scroll as they grow. Counting them
      // toward density would hide the section and workspace controls when the user asks to see more.
      const lists = element.querySelectorAll<HTMLElement>(
        "[data-thread-relationships-panel], [data-thread-side-chats-panel], [data-thread-details-pr-list], [data-thread-automations-panel], [data-thread-details-server-overflow]",
      );
      const fittingHeight =
        next - Array.from(lists).reduce((sum, list) => sum + list.offsetHeight, 0);
      setMeasurements((current) => {
        const heights = current.key === measurementKey ? current.heights : { full: 0, compact: 0 };
        return current.key === measurementKey && heights[density] === fittingHeight
          ? current
          : { key: measurementKey, heights: { ...heights, [density]: fittingHeight } };
      });
      // Only the laid-out DOM knows the full card height, and the canvas keeps preview
      // frames clear of it, so it is reported from this measure effect.
      if (!preferences.pinned && density === "full" && cardWidth !== undefined) {
        measureDetailsCard?.({
          threadRef: { environmentId, threadId },
          width: cardWidth,
          fullContentHeight: next,
        });
      }
    };
    measure();
    return observeResize(element, measure);
  }, [
    contentElement,
    density,
    measurementKey,
    cardWidth,
    measureDetailsCard,
    environmentId,
    threadId,
    preferences.pinned,
  ]);
  const card = (
    <div
      className={cn(
        "dropdown-glass isolate contain-paint grid max-h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl",
        mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      style={placement ? { maxHeight: height } : undefined}
      onContextMenu={onContextMenu}
      data-thread-details-card
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-medium">{text("Thread details")}</span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={text(preferences.pinned ? "Unpin details panel" : "Pin details panel")}
            aria-pressed={preferences.pinned}
            onClick={() => preferences.setPinned(!preferences.pinned)}
          >
            {preferences.pinned ? <PinOffIcon /> : <PinIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={text("Close details panel")}
            onClick={() => {
              preferences.setOpen(false);
              useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", false);
              useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
            }}
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <ScrollArea scrollFade className="min-h-0">
        <div ref={setContentElement}>{children(density)}</div>
      </ScrollArea>
    </div>
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open, details) => {
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent).relatedTarget
            : details.reason === "outside-press"
              ? details.event.target
              : null;
        if (!open && target instanceof Element && target.closest("[data-thread-find-bar]")) {
          details.cancel();
          return;
        }
        useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open);
      }}
    >
      {placement && (preferences.pinned ? preferences.open : inlineOpen) ? (
        <aside
          {...detailsArea}
          data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
          // Skip the return transition to avoid overlapping the rising preview.
          className={cn(
            "absolute z-20",
            topInset > 0 && "transition-[top] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{
            right: placement.right,
            top: placement.y,
            width: placement.width,
            maxHeight: height,
          }}
          data-density={density}
          data-thread-details-panel={preferences.pinned ? "pinned" : "inline"}
        >
          {preferences.pinned ? (
            <div
              role="separator"
              aria-label={text("Resize details panel")}
              aria-orientation="vertical"
              aria-valuenow={preferences.width}
              aria-valuemin={280}
              aria-valuemax={640}
              tabIndex={0}
              className="absolute -left-1 bottom-0 top-0 z-10 w-2 cursor-ew-resize touch-none"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  preferences.setWidth(preferences.width + (event.key === "ArrowLeft" ? 20 : -20));
                }
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const panel = event.currentTarget.parentElement!;
                const width = Math.max(
                  280,
                  Math.min(640, panel.getBoundingClientRect().right - event.clientX),
                );
                panel.style.width = `${width}px`;
              }}
              onPointerUp={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                preferences.setWidth(
                  event.currentTarget.parentElement!.getBoundingClientRect().width,
                );
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
            />
          ) : null}
          {card}
        </aside>
      ) : null}
      {/* Rendered in both modes: base-ui keeps a popup that unmounts mid-open
          mounted, because its exit animation never finishes. Staying in the tree
          lets it close cleanly when the card switches inline. */}
      <PopoverPopup
        {...(mode === "popover" ? detailsArea : {})}
        role="dialog"
        data-workspace-focus-key={`details:${threadRef.environmentId}:${threadRef.threadId}`}
        initialFocus={() => {
          requestWorkspaceFocus({ area: "details" });
          return false;
        }}
        anchor={anchor}
        align="end"
        // Account for the find panel's 8px card padding.
        alignOffset={THREAD_DETAILS_CARD_GAP - 8}
        collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
        side="bottom"
        sideOffset={topInset}
        variant="panel"
        padding="none"
      >
        {mode === "popover" ? (
          <div data-density={density} data-thread-details-panel="popover">
            {card}
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

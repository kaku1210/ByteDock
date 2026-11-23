import { useGT } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PinIcon,
  PinOffIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { useThreadDetailsPreferences } from "./threadDetailsPreferences";
import { requestWorkspaceFocus, workspaceAreaProps } from "../../lib/workspaceFocus";
import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
  resolveThreadDetailsCardDensity,
} from "./threadDetailsCardLayout";
import { observeResize } from "../../lib/observeResize";

type MenuAnchor = "trigger" | { x: number; y: number };

export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  contentKey,
  getToggle,
  menuItems,
  children,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  /** Changes when the set of rendered items changes, so cached heights are measured again. */
  contentKey: string;
  getToggle?: (() => HTMLElement | null) | undefined;
  menuItems?: ReactNode;
  children: (density: "full" | "compact" | "essential") => ReactNode;
}) {
  const gt = useGT();
  const preferences = useThreadDetailsPreferences();
  const detailsArea = workspaceAreaProps("details", 3, gt("Thread details"));
  const canvas = useChatCanvas();
  const preferredPlacement = canvas?.preferredDetailsCard ?? null;
  const placement = canvas?.detailsCardPlacement ?? null;
  const mode = placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const showInline = mode === "inline" && (preferences.pinned ? preferences.open : inlineOpen);
  const { environmentId, threadId } = threadRef;
  const menuScope = `${environmentId}:${threadId}:${mode}:${showInline || popoverOpen}`;
  const [menuState, setMenuState] = useState<{ scope: string; anchor: MenuAnchor } | null>(null);
  const menu = menuState?.scope === menuScope ? menuState.anchor : null;
  if (menuState && !menu) setMenuState(null);
  const setMenu = (anchor: MenuAnchor | null) =>
    setMenuState(anchor === null ? null : { scope: menuScope, anchor });
  const measurementKey = `${environmentId}:${threadId}:${preferredPlacement?.width ?? "popup"}:${contentKey}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
  });
  const contentHeights =
    measurements.key === measurementKey ? measurements.heights : { full: 0, compact: 0 };
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - topInset - 16);
  const density = preferences.pinned
    ? "full"
    : resolveThreadDetailsCardDensity(height, contentHeights);
  const measureDetailsCard = canvas?.measureDetailsCard;
  const resizeDetailsCard = canvas?.resizeDetailsCard;
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the transient drag width if the resize handle unmounts during a drag
  useLayoutEffect(() => {
    if (mode !== "inline" || !preferences.pinned || !preferences.open) return;
    return () => resizeDetailsCard?.(null);
  }, [mode, preferences.pinned, preferences.open, resizeDetailsCard]);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  // Re-measures when the density or measurement key changes, so each density's
  // height is measured once it renders.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the card's DOM height via ResizeObserver and reports it to the canvas
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || preferences.pinned || density === "essential") return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // Expanded lists and the note editor can scroll instead of hiding workspace controls.
      const lists = element.querySelectorAll<HTMLElement>(
        "[data-thread-relationships-panel], [data-thread-side-chats-panel], [data-thread-details-pr-list], [data-thread-automations-panel], [data-thread-details-server-overflow], [data-thread-task-list-scroll], [data-thread-details-note-editor]",
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
      if (density === "full" && cardWidth !== undefined) {
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
      onContextMenu={(event) => {
        if (!menuItems) return;
        const target = event.target;
        const selection = window.getSelection();
        if (
          !(target instanceof Element) ||
          !event.currentTarget.contains(target) ||
          target.closest("input, textarea, [contenteditable], a[href]") ||
          (selection &&
            !selection.isCollapsed &&
            (event.currentTarget.contains(selection.anchorNode) ||
              event.currentTarget.contains(selection.focusNode)))
        )
          return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      data-thread-details-card
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={!preferences.detailsCollapsed}
          onClick={() => preferences.setDetailsCollapsed(!preferences.detailsCollapsed)}
        >
          {preferences.detailsCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          {gt("Thread details")}
        </Button>
        <div className="flex gap-1">
          {menuItems ? (
            <Menu open={menu !== null} onOpenChange={(open) => setMenu(open ? "trigger" : null)}>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={gt("Choose what to show")}
                    title={gt("Choose what to show")}
                  />
                }
              >
                <SlidersHorizontalIcon />
              </MenuTrigger>
              <MenuPopup
                anchor={
                  menu && menu !== "trigger"
                    ? { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) }
                    : undefined
                }
                align={menu === "trigger" ? "end" : "start"}
              >
                {menuItems}
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={preferences.pinned ? gt("Unpin details panel") : gt("Pin details panel")}
            aria-pressed={preferences.pinned}
            onClick={() => preferences.setPinned(!preferences.pinned)}
          >
            {preferences.pinned ? <PinOffIcon /> : <PinIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={gt("Close details panel")}
            onClick={() => {
              if (preferences.pinned) preferences.setOpen(false);
              const store = useRightPanelStore.getState();
              store.setThreadPanelOpen(threadRef, "inline", false);
              store.setThreadPanelOpen(threadRef, "popover", false);
              getToggle?.()?.focus({ preventScroll: true });
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
      {placement && showInline ? (
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
              aria-label={gt("Resize details panel")}
              aria-orientation="vertical"
              aria-valuenow={placement.width}
              aria-valuemin={THREAD_DETAILS_CARD_WIDTH}
              aria-valuemax={placement.maxWidth}
              tabIndex={0}
              className="absolute -left-1 bottom-0 top-0 z-10 w-2 cursor-ew-resize touch-none"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const width = Math.max(
                    THREAD_DETAILS_CARD_WIDTH,
                    Math.min(
                      placement.maxWidth,
                      placement.width + (event.key === "ArrowLeft" ? 20 : -20),
                    ),
                  );
                  if (width !== placement.width) preferences.setWidth(width);
                }
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const right = event.currentTarget.parentElement!.getBoundingClientRect().right;
                resizeDetailsCard?.(
                  Math.max(
                    THREAD_DETAILS_CARD_WIDTH,
                    Math.min(placement.maxWidth, right - event.clientX),
                  ),
                );
              }}
              onPointerUp={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                if (placement.width !== Math.min(preferences.width, placement.maxWidth)) {
                  preferences.setWidth(placement.width);
                }
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onLostPointerCapture={() => resizeDetailsCard?.(null)}
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
        finalFocus={(interaction) => (interaction === "keyboard" ? (getToggle?.() ?? true) : true)}
        anchor={anchor}
        align="end"
        // Account for the find panel's 8px card padding.
        alignOffset={THREAD_DETAILS_CARD_GAP - 8}
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
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

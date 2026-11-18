import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { create } from "zustand";
import { subscribeLocalStorageKey } from "../../hooks/useLocalStorage";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Textarea } from "../ui/textarea";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

interface NoteDraft {
  text: string;
  failed: boolean;
}

const useNoteDrafts = create<ReadonlyMap<string, NoteDraft>>(() => new Map());

function setNoteDraft(key: string, draft: NoteDraft | null) {
  useNoteDrafts.setState((drafts) => {
    const next = new Map(drafts);
    if (draft) next.set(key, draft);
    else next.delete(key);
    return next;
  }, true);
}

function saveNote(key: string) {
  const draft = useNoteDrafts.getState().get(key);
  if (!draft) return;
  try {
    if (draft.text === "") window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, draft.text);
  } catch {
    if (!draft.failed) setNoteDraft(key, { ...draft, failed: true });
    return;
  }
  setNoteDraft(key, null);
}

function focusEditor(element: HTMLTextAreaElement | null) {
  element?.focus();
}

export function ThreadDetailsNote({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { text } = useUiLanguage();
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const key = `t3code:thread-note:v1:${scopedThreadKey(threadRef)}`;
  const draft = useNoteDrafts((drafts) => drafts.get(key));
  const subscribe = (onChange: () => void) => subscribeLocalStorageKey(key, onChange);
  const read = () => {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  };
  const saved = useSyncExternalStore(subscribe, read, () => "");
  const value = draft?.text ?? saved;
  const timer = useRef<number | undefined>(undefined);
  const flush = useStableCallback(() => {
    window.clearTimeout(timer.current);
    saveNote(key);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes pending text when the page hides or the editor unmounts
  useLayoutEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [flush]);

  const title = text("Thread note");
  const preview = expanded ? "" : value.trim();
  const contentId = `${headingId}-content`;
  const statusId = `${headingId}-status`;

  return (
    <section aria-labelledby={headingId} className="border-t border-border/65 px-2 py-1">
      <h3 className="flex min-w-0">
        <ThreadDetailsControl
          part="meta"
          className="max-w-full"
          aria-label={title}
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-describedby={preview ? `${headingId}-preview` : undefined}
          onClick={() => {
            if (expanded) flush();
            setExpanded(!expanded);
          }}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" aria-hidden />
          ) : (
            <ChevronRightIcon className="size-3" aria-hidden />
          )}
          <span id={headingId} className="shrink-0">
            {title}
          </span>
          {preview ? (
            <span
              id={`${headingId}-preview`}
              className="truncate font-normal text-muted-foreground/80"
            >
              {preview}
            </span>
          ) : null}
        </ThreadDetailsControl>
      </h3>
      <div
        id={contentId}
        hidden={!expanded}
        className="px-1.5 pt-0.5 [&_[data-slot=textarea]]:max-h-24"
        data-thread-details-note-editor
      >
        {expanded ? (
          <Textarea
            ref={focusEditor}
            size="sm"
            rows={2}
            aria-label={title}
            aria-describedby={draft?.failed ? statusId : undefined}
            placeholder={text("Write a note…")}
            value={value}
            onChange={(event) => {
              setNoteDraft(key, { text: event.currentTarget.value, failed: false });
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(flush, 300);
            }}
            onBlur={flush}
          />
        ) : null}
      </div>
      <p
        id={statusId}
        role="status"
        className={draft?.failed ? "px-1.5 pt-1 text-xs text-destructive" : "sr-only"}
      >
        {draft?.failed
          ? text("Could not save the note. Your text is still here.")
          : draft
            ? text("Saving note…")
            : ""}
      </p>
    </section>
  );
}

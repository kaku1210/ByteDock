import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

const PREFIX = "t3code:temporary-chat-cleanup:v1:";

interface Journal {
  refs: string[];
  pending: boolean;
}

/** Each document holds its journal lock until unload; recovery skips other live windows. */
export function createTemporaryChatCleanup(input: {
  owner: string;
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;
  acquire: (name: string) => Promise<(() => void) | null>;
  canRecoverActive: boolean;
  remove: (ref: ScopedThreadRef) => Promise<boolean>;
  clearLocal: (ref: ScopedThreadRef) => void;
}) {
  const ownKey = PREFIX + input.owner;
  let exiting = false;
  let recovery: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const cleaning = new Map<string, Promise<void>>();
  const ready = input.acquire(ownKey);
  const read = (key: string): Journal => {
    try {
      const value: unknown = JSON.parse(input.storage.getItem(key) ?? "null");
      if (value && typeof value === "object" && "refs" in value && Array.isArray(value.refs)) {
        return {
          refs: value.refs.filter(
            (ref): ref is string => typeof ref === "string" && parseScopedThreadKey(ref) !== null,
          ),
          pending: "pending" in value && value.pending === true,
        };
      }
    } catch {
      /* Ignore a damaged journal, never guess a thread to delete. */
    }
    return { refs: [], pending: false };
  };
  const write = (key: string, journal: Journal) => {
    if (journal.refs.length === 0) input.storage.removeItem(key);
    else input.storage.setItem(key, JSON.stringify(journal));
  };
  const clean = (key: string) => {
    const existing = cleaning.get(key);
    if (existing) return existing;
    const work = Promise.all(
      read(key).refs.map(async (threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        if (!ref) return;
        input.clearLocal(ref);
        let removed = false;
        try {
          removed = await input.remove(ref);
        } catch {
          /* Keep the journal for reconnect. */
        }
        if (removed) {
          const latest = read(key);
          write(key, { ...latest, refs: latest.refs.filter((entry) => entry !== threadKey) });
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        cleaning.delete(key);
      });
    cleaning.set(key, work);
    return work;
  };
  const recover = () => {
    recovery ??= (async () => {
      await ready;
      const keys = Array.from({ length: input.storage.length }, (_, index) =>
        input.storage.key(index),
      );
      await Promise.all(
        keys.map(async (key) => {
          if (!key?.startsWith(PREFIX) || key === ownKey) return;
          if (!input.canRecoverActive && !read(key).pending) return;
          const release = await input.acquire(key);
          if (!release) return;
          try {
            await clean(key);
          } finally {
            release();
          }
        }),
      );
      if (exiting) await clean(ownKey);
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  return {
    async register(ref: ScopedThreadRef, restored = false) {
      await ready;
      if (exiting) return false;
      if (restored) {
        for (let index = 0; index < input.storage.length; index++) {
          const key = input.storage.key(index);
          if (key?.startsWith(PREFIX) && read(key).refs.includes(scopedThreadKey(ref))) return true;
        }
      }
      const journal = read(ownKey);
      write(ownKey, {
        pending: false,
        refs: [...new Set([...journal.refs, scopedThreadKey(ref)])],
      });
      return true;
    },
    forget(ref: ScopedThreadRef) {
      const journal = read(ownKey);
      write(ownKey, {
        ...journal,
        refs: journal.refs.filter((entry) => entry !== scopedThreadKey(ref)),
      });
    },
    recover,
    close() {
      exiting = true;
      const journal = read(ownKey);
      write(ownKey, { ...journal, pending: true });
      // Local content is cleared synchronously even when the browser cannot await RPCs.
      for (const key of journal.refs) {
        const ref = parseScopedThreadKey(key);
        if (ref) input.clearLocal(ref);
      }
      closing ??= clean(ownKey).finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}

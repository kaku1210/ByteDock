import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type RawShellStateSlice,
  type ThreadFamilyFallbackSource,
  waitForThreadShellWithFallback,
} from "./waitForThreadShell";

const environmentId = EnvironmentId.make("env-1");
const rootThreadId = ThreadId.make("thread-root");
const sideChatId = ThreadId.make("thread-side-chat");
const sideChatRef = scopeThreadRef(environmentId, sideChatId);

function makeThreadShell(id: ThreadId): OrchestrationV2ThreadShell {
  return {
    id,
    projectId: ProjectId.make("project-1"),
    title: id === sideChatId ? "Side chat" : "Root thread",
  } as unknown as OrchestrationV2ThreadShell;
}

function makeSnapshot(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  snapshotSequence = 1,
): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence,
    projects: [],
    threads,
  } as unknown as OrchestrationV2ShellSnapshot;
}

function makeHarness(initial?: {
  readonly rawThreads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly generation?: number;
  readonly initialFamily?: AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>;
}) {
  const registry = AtomRegistry.make();
  const rawShellAtom = Atom.make<RawShellStateSlice>({
    generation: initial?.generation ?? 1,
    snapshot: Option.some(makeSnapshot(initial?.rawThreads ?? [makeThreadShell(rootThreadId)])),
    removedAt: new Map(),
  }).pipe(Atom.keepAlive);
  const mountedCountAtom = Atom.make(0).pipe(Atom.keepAlive);
  const familyResultAtom = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>>(
    initial?.initialFamily ?? AsyncResult.initial(true),
  ).pipe(Atom.keepAlive);

  // Merged thread shell mirrors threadFamilies.snapshotAtom: raw shell wins, fallback fills gaps while mounted.
  const mergedThreadShellAtom = Atom.make((get): OrchestrationV2ThreadShell | null => {
    const raw = get(rawShellAtom);
    const fromRaw = Option.match(raw.snapshot, {
      onNone: () => undefined,
      onSome: (snapshot) => snapshot.threads.find((thread) => thread.id === sideChatId),
    });
    if (fromRaw !== undefined) return fromRaw;
    if (get(mountedCountAtom) === 0) return null;
    const family = Option.getOrUndefined(AsyncResult.value(get(familyResultAtom)));
    return family?.threads.find((thread) => thread.id === sideChatId) ?? null;
  });

  const mountSpy = vi.fn();
  const releaseSpy = vi.fn();
  const refreshSpy = vi.fn();

  const threadFamilies: ThreadFamilyFallbackSource = {
    mount: (_registry, envId, threadId) => {
      mountSpy(envId, threadId);
      registry.update(mountedCountAtom, (count) => count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseSpy(envId, threadId);
        registry.update(mountedCountAtom, (count) => Math.max(0, count - 1));
      };
    },
    refresh: (_registry, envId, threadId) => {
      refreshSpy(envId, threadId);
    },
    familyAtom: () => familyResultAtom,
  };

  return {
    registry,
    rawShellAtom,
    mountedCountAtom,
    familyResultAtom,
    mergedThreadShellAtom,
    threadFamilies,
    mountSpy,
    releaseSpy,
    refreshSpy,
  };
}

describe("waitForThreadShellWithFallback", () => {
  it("resolves via passive shell push without mounting threadFamilies", async () => {
    const harness = makeHarness();
    try {
      const waitPromise = waitForThreadShellWithFallback({
        registry: harness.registry,
        ref: sideChatRef,
        threadShellAtom: () => harness.mergedThreadShellAtom,
        rawShellStateAtom: () => harness.rawShellAtom,
        threadFamilies: harness.threadFamilies,
        timeoutMs: 200,
        passiveWaitMs: 60,
      });

      setTimeout(() => {
        harness.registry.set(harness.rawShellAtom, {
          generation: 1,
          snapshot: Option.some(
            makeSnapshot([makeThreadShell(rootThreadId), makeThreadShell(sideChatId)], 2),
          ),
          removedAt: new Map(),
        });
      }, 10);

      expect(await waitPromise).toBe(true);
      expect(harness.mountSpy).not.toHaveBeenCalled();
      expect(harness.refreshSpy).not.toHaveBeenCalled();
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(0);
    } finally {
      harness.registry.dispose();
    }
  });

  it("falls back to active threadFamilies pull after passive wait and auto-releases when raw shell catches up", async () => {
    const harness = makeHarness();
    try {
      harness.mountSpy.mockImplementation(() => {
        setTimeout(() => {
          harness.registry.set(
            harness.familyResultAtom,
            AsyncResult.success({
              snapshotSequence: 2,
              threads: [makeThreadShell(rootThreadId), makeThreadShell(sideChatId)],
            }),
          );
        }, 10);
      });

      const arrived = await waitForThreadShellWithFallback({
        registry: harness.registry,
        ref: sideChatRef,
        threadShellAtom: () => harness.mergedThreadShellAtom,
        rawShellStateAtom: () => harness.rawShellAtom,
        threadFamilies: harness.threadFamilies,
        timeoutMs: 300,
        passiveWaitMs: 25,
        fallbackHoldTtlMs: 5_000,
      });

      expect(arrived).toBe(true);
      expect(harness.mountSpy).toHaveBeenCalledTimes(1);
      expect(harness.releaseSpy).not.toHaveBeenCalled();
      // Side chat remains readable via fallback while raw shell has not caught up yet.
      expect(harness.registry.get(harness.mergedThreadShellAtom)?.id).toBe(sideChatId);
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(1);

      // Once raw shell stream catches up, fallback mount releases automatically.
      harness.registry.set(harness.rawShellAtom, {
        generation: 1,
        snapshot: Option.some(
          makeSnapshot([makeThreadShell(rootThreadId), makeThreadShell(sideChatId)], 2),
        ),
        removedAt: new Map(),
      });

      expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(0);
      expect(harness.registry.get(harness.mergedThreadShellAtom)?.id).toBe(sideChatId);
    } finally {
      harness.registry.dispose();
    }
  });

  it("refreshes a cached settled family that predates the new thread and releases on generation bump", async () => {
    const harness = makeHarness({
      initialFamily: AsyncResult.success({
        snapshotSequence: 1,
        threads: [makeThreadShell(rootThreadId)],
      }),
    });
    try {
      harness.refreshSpy.mockImplementation(() => {
        setTimeout(() => {
          harness.registry.set(
            harness.familyResultAtom,
            AsyncResult.success({
              snapshotSequence: 2,
              threads: [makeThreadShell(rootThreadId), makeThreadShell(sideChatId)],
            }),
          );
        }, 10);
      });

      const arrived = await waitForThreadShellWithFallback({
        registry: harness.registry,
        ref: sideChatRef,
        threadShellAtom: () => harness.mergedThreadShellAtom,
        rawShellStateAtom: () => harness.rawShellAtom,
        threadFamilies: harness.threadFamilies,
        timeoutMs: 300,
        passiveWaitMs: 20,
        fallbackHoldTtlMs: 5_000,
      });

      expect(arrived).toBe(true);
      expect(harness.mountSpy).toHaveBeenCalledTimes(1);
      expect(harness.refreshSpy).toHaveBeenCalledTimes(1);
      expect(harness.releaseSpy).not.toHaveBeenCalled();

      // Reconnect / fresh authoritative snapshot bumps generation -> releases fallback hold.
      harness.registry.set(harness.rawShellAtom, {
        generation: 2,
        snapshot: Option.some(makeSnapshot([makeThreadShell(rootThreadId)], 3)),
        removedAt: new Map(),
      });

      expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(0);
    } finally {
      harness.registry.dispose();
    }
  });

  it("releases the fallback hold after the safety TTL if raw shell never catches up", async () => {
    const harness = makeHarness();
    try {
      harness.mountSpy.mockImplementation(() => {
        harness.registry.set(
          harness.familyResultAtom,
          AsyncResult.success({
            snapshotSequence: 2,
            threads: [makeThreadShell(rootThreadId), makeThreadShell(sideChatId)],
          }),
        );
      });

      const arrived = await waitForThreadShellWithFallback({
        registry: harness.registry,
        ref: sideChatRef,
        threadShellAtom: () => harness.mergedThreadShellAtom,
        rawShellStateAtom: () => harness.rawShellAtom,
        threadFamilies: harness.threadFamilies,
        timeoutMs: 200,
        passiveWaitMs: 15,
        fallbackHoldTtlMs: 30,
      });

      expect(arrived).toBe(true);
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(1);

      await vi.waitFor(() => {
        expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
      });
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(0);
    } finally {
      harness.registry.dispose();
    }
  });

  it("returns false and immediately releases the fallback mount when both passive push and fallback pull time out", async () => {
    const harness = makeHarness();
    try {
      const arrived = await waitForThreadShellWithFallback({
        registry: harness.registry,
        ref: sideChatRef,
        threadShellAtom: () => harness.mergedThreadShellAtom,
        rawShellStateAtom: () => harness.rawShellAtom,
        threadFamilies: harness.threadFamilies,
        timeoutMs: 60,
        passiveWaitMs: 20,
      });

      expect(arrived).toBe(false);
      expect(harness.mountSpy).toHaveBeenCalledTimes(1);
      expect(harness.releaseSpy).toHaveBeenCalledTimes(1);
      expect(harness.registry.get(harness.mountedCountAtom)).toBe(0);
    } finally {
      harness.registry.dispose();
    }
  });
});

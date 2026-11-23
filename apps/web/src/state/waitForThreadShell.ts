import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationV2ThreadFamily,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import { waitForAtomValue } from "./waitForAtomValue";

export const DEFAULT_WAIT_FOR_THREAD_SHELL_TIMEOUT_MS = 12_000;
const PASSIVE_THREAD_SHELL_WAIT_MS = 1_500;
const FALLBACK_FAMILY_HOLD_TTL_MS = 60_000;

export type RawShellStateSlice = Pick<
  EnvironmentShellState,
  "generation" | "snapshot" | "removedAt"
>;

export interface ThreadFamilyFallbackSource {
  readonly mount: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => () => void;
  readonly refresh: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => void;
  readonly familyAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>>;
}

function isRawShellSettledForThread(
  shellState: RawShellStateSlice,
  threadId: ThreadId,
  settledGeneration: number,
): boolean {
  if (shellState.generation !== settledGeneration) {
    return true;
  }
  if (shellState.removedAt.has(threadId)) {
    return true;
  }
  return Option.exists(shellState.snapshot, (snapshot) =>
    snapshot.threads.some((thread) => thread.id === threadId),
  );
}

function holdFallbackUntilRawShellSettles(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly rawShellAtom: Atom.Atom<RawShellStateSlice>;
  readonly threadId: ThreadId;
  readonly settledGeneration: number;
  readonly releaseMount: () => void;
  readonly holdTtlMs: number;
}): void {
  let released = false;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeWhenReady = false;

  const cleanup = () => {
    if (released) return;
    released = true;
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (unsubscribe === null) {
      unsubscribeWhenReady = true;
    } else {
      unsubscribe();
      unsubscribe = null;
    }
    input.releaseMount();
  };

  unsubscribe = input.registry.subscribe(input.rawShellAtom, (shellState) => {
    if (isRawShellSettledForThread(shellState, input.threadId, input.settledGeneration)) {
      cleanup();
    }
  });
  if (unsubscribeWhenReady) {
    unsubscribe();
    unsubscribe = null;
    return;
  }

  // Close the gap between the check before subscribing and subscription registration.
  if (
    isRawShellSettledForThread(
      input.registry.get(input.rawShellAtom),
      input.threadId,
      input.settledGeneration,
    )
  ) {
    cleanup();
    return;
  }

  timeoutId = globalThis.setTimeout(cleanup, input.holdTtlMs);
}

/**
 * Waits for a thread shell via passive push first, then falls back to mounting `threadFamilies`
 * (`getThreadFamily`) and releases the fallback mount once raw shell catches up or times out.
 */
export async function waitForThreadShellWithFallback<T>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly ref: ScopedThreadRef;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<T | null>;
  readonly rawShellStateAtom: (environmentId: EnvironmentId) => Atom.Atom<RawShellStateSlice>;
  readonly threadFamilies: ThreadFamilyFallbackSource;
  readonly timeoutMs?: number;
  readonly passiveWaitMs?: number;
  readonly fallbackHoldTtlMs?: number;
}): Promise<boolean> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_FOR_THREAD_SHELL_TIMEOUT_MS;
  const shellAtom = input.threadShellAtom(input.ref);
  if (input.registry.get(shellAtom) !== null) {
    return true;
  }

  const startedAt = Date.now();
  const passiveBudgetMs = Math.max(
    0,
    Math.min(
      input.passiveWaitMs ?? PASSIVE_THREAD_SHELL_WAIT_MS,
      timeoutMs,
      Math.floor(timeoutMs / 2),
    ),
  );

  if (passiveBudgetMs > 0) {
    const arrivedPassively = await waitForAtomValue({
      registry: input.registry,
      atom: shellAtom,
      predicate: (thread) => thread !== null,
      timeoutMs: passiveBudgetMs,
    });
    if (arrivedPassively) {
      return true;
    }
  }

  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
  if (remainingMs <= 0) {
    return input.registry.get(shellAtom) !== null;
  }

  const releaseMount = input.threadFamilies.mount(
    input.registry,
    input.ref.environmentId,
    input.ref.threadId,
  );

  const familyResult = input.registry.get(
    input.threadFamilies.familyAtom(input.ref.environmentId, input.ref.threadId),
  );
  if (
    threadFamilyRead(familyResult) === "settled" &&
    !Option.exists(AsyncResult.value(familyResult), (family) =>
      family.threads.some((thread) => thread.id === input.ref.threadId),
    )
  ) {
    input.threadFamilies.refresh(input.registry, input.ref.environmentId, input.ref.threadId);
  }

  const arrived = await waitForAtomValue({
    registry: input.registry,
    atom: shellAtom,
    predicate: (thread) => thread !== null,
    timeoutMs: remainingMs,
  });

  if (!arrived) {
    releaseMount();
    return false;
  }

  const rawShellAtom = input.rawShellStateAtom(input.ref.environmentId);
  const settledGeneration = input.registry.get(rawShellAtom).generation;
  if (
    isRawShellSettledForThread(
      input.registry.get(rawShellAtom),
      input.ref.threadId,
      settledGeneration,
    )
  ) {
    releaseMount();
    return true;
  }

  holdFallbackUntilRawShellSettles({
    registry: input.registry,
    rawShellAtom,
    threadId: input.ref.threadId,
    settledGeneration,
    releaseMount,
    holdTtlMs: input.fallbackHoldTtlMs ?? FALLBACK_FAMILY_HOLD_TTL_MS,
  });
  return true;
}

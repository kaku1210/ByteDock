import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

/**
 * Per-thread serial gate (R3 Target 1.2):
 * Ensures openSession / runTurn / reOpen / unpin on the same threadId execute strictly
 * in critical section so idle-detach and concurrent new turns can never tear open.before.
 */
export interface ThreadSessionGateService {
  readonly withGate: <A, E, R>(
    threadId: string,
    effect: () => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly deleteGate: (threadId: string) => Effect.Effect<void>;
}

export class ThreadSessionGate extends Context.Service<
  ThreadSessionGate,
  ThreadSessionGateService
>()("@bytedock/plugin-kernel/sessionGate/ThreadSessionGate") {}

export const makeThreadSessionGate = Effect.fn("pluginKernel.makeThreadSessionGate")(function* () {
  const gatesRef = yield* Ref.make(new Map<string, Semaphore.Semaphore>());

  const getOrCreateSemaphore = Effect.fn("ThreadSessionGate.getOrCreateSemaphore")(function* (
    threadId: string,
  ) {
    const existing = (yield* Ref.get(gatesRef)).get(threadId);
    if (existing) return existing;
    const fresh = yield* Semaphore.make(1);
    return yield* Ref.modify(gatesRef, (map) => {
      const raced = map.get(threadId);
      if (raced) return [raced, map] as const;
      const next = new Map(map);
      next.set(threadId, fresh);
      return [fresh, next] as const;
    });
  });

  return {
    withGate: (threadId, effect) =>
      getOrCreateSemaphore(threadId).pipe(Effect.flatMap((sem) => sem.withPermits(1)(effect()))),
    deleteGate: (threadId) =>
      Ref.update(gatesRef, (map) => {
        if (!map.has(threadId)) return map;
        const next = new Map(map);
        next.delete(threadId);
        return next;
      }),
  } satisfies ThreadSessionGateService;
});

export const ThreadSessionGateLive = Layer.effect(ThreadSessionGate, makeThreadSessionGate());

import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { clearThreadLocalData } from "./lib/clearThreadLocalData";
import { createTemporaryChatCleanup } from "./lib/temporaryChatCleanup";
import { randomUUID } from "./lib/utils";
import { useRightPanelStore } from "./rightPanelStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./state/session";
import { liveShellEnvironmentIdsAtom } from "./state/shell";
import { threadEnvironment } from "./state/threads";

let cleanup: ReturnType<typeof createTemporaryChatCleanup> | undefined;

export async function registerTemporaryChat(ref: ScopedThreadRef) {
  return cleanup ? cleanup.register(ref) : true;
}

export function forgetTemporaryChat(ref: ScopedThreadRef) {
  cleanup?.forget(ref);
}

export function startTemporaryChatCleanup() {
  if (cleanup) return;
  const acquire = (name: string): Promise<(() => void) | null> => {
    if (!navigator.locks) return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      void navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          return new Promise<void>((release) => {
            resolve(release);
          });
        })
        .catch(reject);
    });
  };
  cleanup = createTemporaryChatCleanup({
    owner: randomUUID(),
    storage: window.localStorage,
    acquire,
    canRecoverActive: Boolean(navigator.locks),
    remove: async (ref) => {
      if (!readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)) return false;
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.delete,
        {
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        },
        { reportFailure: false },
      );
      return result._tag === "Success";
    },
    clearLocal: (ref) => {
      clearThreadLocalData(ref);
      const store = useRightPanelStore.getState();
      for (const [key, state] of Object.entries(store.byThreadKey)) {
        const parent = parseScopedThreadKey(key);
        if (parent?.environmentId !== ref.environmentId) continue;
        for (const surface of state.surfaces) {
          if (surface.kind === "side-chat" && surface.threadId === ref.threadId) {
            store.closeSurface(parent, surface.id);
          }
        }
      }
    },
  });
  const service = cleanup;
  appAtomRegistry.subscribe(
    Atom.make((get) =>
      [...get(liveShellEnvironmentIdsAtom)].filter((environmentId) =>
        sessionHasScope(
          get(environmentSession.sessionStateAtom(environmentId)),
          AuthOrchestrationOperateScope,
        ),
      ),
    ),
    () => {
      void service.recover();
    },
    { immediate: true },
  );
  window.addEventListener("pagehide", () => {
    void service.close();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  window.addEventListener("t3:prepare-exit", (event) => {
    event.preventDefault();
    const complete = (event as CustomEvent<() => void>).detail;
    void service.close().finally(complete);
  });
  // Panels written before the cleanup journal existed still need an exit owner.
  for (const [key, state] of Object.entries(useRightPanelStore.getState().byThreadKey)) {
    const parent = parseScopedThreadKey(key);
    if (!parent) continue;
    for (const surface of state.surfaces) {
      if (surface.kind === "side-chat" && surface.temporary) {
        void service.register(scopeThreadRef(parent.environmentId, surface.threadId), true);
      }
    }
  }
}

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadFamilies } from "../state/threads";

export function useOpenThreadFamily(threadRef: ScopedThreadRef | null, missing: boolean) {
  const key = threadRef === null ? null : scopedThreadKey(threadRef);
  // Keep the family mounted after its missing shell arrives, until the view leaves this thread.
  const [mountedKey, setMountedKey] = useState<string | null>(null);
  const nextKey = missing || mountedKey === key ? key : null;
  if (nextKey !== mountedKey) setMountedKey(nextKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the open thread's family in the registry for the lifetime of its view
  useEffect(() => {
    const ref = mountedKey === null ? null : parseScopedThreadKey(mountedKey);
    if (ref === null) return;
    return threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId);
  }, [mountedKey]);
}

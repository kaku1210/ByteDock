import type { DesktopBridge, DesktopWindowsDefenderExclusionsState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type DesktopWindowsDefenderExclusionsBridge = NonNullable<
  DesktopBridge["windowsDefenderExclusions"]
>;

class DesktopWindowsDefenderExclusionsUnavailableError extends Schema.TaggedError<DesktopWindowsDefenderExclusionsUnavailableError>()(
  "DesktopWindowsDefenderExclusionsUnavailableError",
  {},
) {
  override get message(): string {
    return "Windows Defender exclusions helper is unavailable.";
  }
}

class DesktopWindowsDefenderExclusionsLoadError extends Schema.TaggedError<DesktopWindowsDefenderExclusionsLoadError>()(
  "DesktopWindowsDefenderExclusionsLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load Windows Defender exclusions state.";
  }
}

export function getDesktopWindowsDefenderExclusionsBridge():
  | DesktopWindowsDefenderExclusionsBridge
  | undefined {
  return typeof window === "undefined"
    ? undefined
    : window.desktopBridge?.windowsDefenderExclusions;
}

const loadDesktopWindowsDefenderExclusionsState = Effect.fn(
  "loadDesktopWindowsDefenderExclusionsState",
)(function* () {
  const bridge = getDesktopWindowsDefenderExclusionsBridge();
  if (!bridge) {
    return yield* new DesktopWindowsDefenderExclusionsUnavailableError();
  }
  return yield* Effect.tryPromise({
    try: (): Promise<DesktopWindowsDefenderExclusionsState> => bridge.getState(),
    catch: (cause) => new DesktopWindowsDefenderExclusionsLoadError({ cause }),
  });
});

export const desktopWindowsDefenderExclusionsStateAtom = Atom.make(
  loadDesktopWindowsDefenderExclusionsState(),
).pipe(
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("desktop:windows-defender-exclusions:load"),
);

export function refreshDesktopWindowsDefenderExclusionsState(): void {
  appAtomRegistry.refresh(desktopWindowsDefenderExclusionsStateAtom);
}

import { useAtomValue } from "@effect/atom-react";
import type { RunId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

type Preference = { readonly runId: RunId | null; readonly text: string; readonly applied: string };
const preferences = Atom.make<Readonly<Record<string, Preference>>>({}).pipe(Atom.keepAlive);

export function usePromptSuggestionPreference(threadKey: string, runId: RunId | null) {
  const entry = useAtomValue(preferences)[threadKey];
  return entry?.runId === runId ? entry : undefined;
}

export function readPromptSuggestionPreference(threadKey: string) {
  return appAtomRegistry.get(preferences)[threadKey];
}

export function editPromptSuggestionPreference(
  threadKey: string,
  runId: RunId | null,
  text: string,
) {
  const current = appAtomRegistry.get(preferences);
  const previous = current[threadKey];
  appAtomRegistry.set(preferences, {
    ...current,
    [threadKey]: { runId, text, applied: previous?.runId === runId ? previous.applied : "" },
  });
}

export function applyPromptSuggestionPreference(threadKey: string) {
  const current = appAtomRegistry.get(preferences);
  const entry = current[threadKey];
  if (!entry || entry.applied === entry.text.trim()) return;
  appAtomRegistry.set(preferences, {
    ...current,
    [threadKey]: { ...entry, applied: entry.text.trim() },
  });
}

export function clearPromptSuggestionPreference(threadKey: string, expected?: Preference) {
  const current = appAtomRegistry.get(preferences);
  if (!current[threadKey] || (expected && current[threadKey] !== expected)) return;
  const { [threadKey]: _removed, ...rest } = current;
  appAtomRegistry.set(preferences, rest);
}

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { flushComposerDraftStorage, useComposerDraftStore } from "../composerDraftStore";
import { useManualThreadTasks } from "../components/chat/manualThreadTasks";
import { releaseComposerDraftUploads } from "./composerDraftUploads";
import { clearPromptSuggestionPreference } from "../components/chat/promptSuggestionPreferences";

export function clearThreadLocalData(ref: ScopedThreadRef) {
  releaseComposerDraftUploads(ref);
  useComposerDraftStore.getState().clearDraftThread(ref);
  flushComposerDraftStorage();
  useManualThreadTasks.getState().removeThread(scopedThreadKey(ref));
  clearPromptSuggestionPreference(scopedThreadKey(ref));
}

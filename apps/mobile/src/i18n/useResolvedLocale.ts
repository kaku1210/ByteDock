import { resolveLocale } from "@t3tools/client-runtime/locales";
import { resolveLanguagePreference } from "@t3tools/shared/uiLanguage";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { AppState, Platform, TurboModuleRegistry, type TurboModule } from "react-native";
import { mobilePreferencesAtom } from "../state/preferences";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

// Read the device languages from gt-react-native's own native module: GT's getLocale() prefers
// the last locale passed to GTProvider, which it persists, so it can't express "system".
function readSystemLocales(): ReadonlyArray<string> {
  try {
    const locales =
      TurboModuleRegistry.get<{ getNativeLocales(): string[] } & TurboModule>(
        "GtReactNative",
      )?.getNativeLocales() ?? [];
    // On iOS the first entry is NSLocale.currentLocale, whose language is the app's bundle
    // localization (English only), not the user's; preferredLanguages follow it.
    return Platform.OS === "ios" ? locales.slice(1) : locales;
  } catch {
    return [];
  }
}

export function useLanguagePreference(): string {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? resolveLanguagePreference(preferences.value)
    : "system";
}

function subscribeSystemLanguages(refresh: () => void) {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh();
  });
  return () => subscription.remove();
}

const systemLanguagesSnapshot = () => readSystemLocales().join(",");

export function useResolvedLocale(): string {
  const languages = useSyncExternalStore(subscribeSystemLanguages, systemLanguagesSnapshot);
  return resolveLocale(
    useLanguagePreference(),
    languages.split(","),
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  );
}

import {
  plusLanguagePreference,
  resolveLanguagePreference,
  resolveUiLanguage,
} from "@t3tools/shared/uiLanguage";
import { type ReactNode, useSyncExternalStore } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { UiLanguageContext } from "./useUiLanguage";

function readSystemLocale(): string {
  return window.desktopBridge?.getSystemLocale?.() ?? navigator.language;
}

function subscribeToSystemLocale(refresh: () => void) {
  window.addEventListener("languagechange", refresh);
  window.addEventListener("focus", refresh);
  return () => {
    window.removeEventListener("languagechange", refresh);
    window.removeEventListener("focus", refresh);
  };
}

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  const preference = useClientSettings((settings) =>
    plusLanguagePreference(resolveLanguagePreference(settings)),
  );
  const systemLocale = useSyncExternalStore(subscribeToSystemLocale, readSystemLocale);
  const language = resolveUiLanguage(preference, systemLocale);

  return <UiLanguageContext value={language}>{children}</UiLanguageContext>;
}

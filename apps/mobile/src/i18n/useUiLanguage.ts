import { createContext, useContext, useMemo } from "react";
import { useLocale } from "gt-react-native";
import {
  translate,
  translateUiText,
  type MessageKey,
  type MessageValues,
} from "@t3tools/shared/i18n/messages";
import type { UiLanguage } from "@t3tools/shared/uiLanguage";

export const UiLanguageContext = createContext<UiLanguage | null>(null);

/** Translates Plus-only interface copy in sync with the active GT locale. */
export function useUiLanguage() {
  const override = useContext(UiLanguageContext);
  const gtLocale = useLocale();
  const language: UiLanguage = override ?? (gtLocale?.startsWith("zh") ? "zh-CN" : "en");
  return useMemo(
    () => ({
      language,
      t: (key: MessageKey, values?: MessageValues) => translate(language, key, values),
      text: (source: string) => translateUiText(language, source),
    }),
    [language],
  );
}

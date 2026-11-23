import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import { createContext, useContext } from "react";

import {
  translate,
  translateUiText,
  type MessageKey,
  type MessageValues,
} from "@t3tools/shared/i18n/messages";

import sourceMessages from "./translations/en.json";

import chineseMessages from "./translations/zh.json";

const chineseRecord: Readonly<Record<string, unknown>> = chineseMessages;
const upstreamChinese = new Map<string, string>(
  Object.entries(sourceMessages).flatMap(([key, source]) => {
    const translated = chineseRecord[key];
    return typeof source === "string" && typeof translated === "string" && translated !== source
      ? [[source, translated] as const]
      : [];
  }),
);

export const UiLanguageContext = createContext<UiLanguage>("en");

export function useUiLanguage() {
  const language = useContext(UiLanguageContext);
  const upstreamText = (source: string) =>
    language === "zh-CN" ? (upstreamChinese.get(source) ?? source) : source;
  return {
    language,
    t: (key: MessageKey, values?: MessageValues) => translate(language, key, values, upstreamText),
    text: (source: string, values?: MessageValues) =>
      translateUiText(language, source, values, upstreamText),
  };
}

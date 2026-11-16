import type { UiLanguage } from "@t3tools/shared/uiLanguage";
import { translateUiText } from "@t3tools/shared/i18n/messages";
import en from "./translations/en.json";
import zh from "./translations/zh.json";

const upstreamChinese = new Map<string, string>(
  Object.entries(en).flatMap(([key, source]) => {
    const translated = (zh as Readonly<Record<string, string>>)[key];
    return translated && translated !== source ? [[source, translated] as const] : [];
  }),
);

export function translateMobileText(language: UiLanguage, source: string): string {
  return language === "zh-CN"
    ? (upstreamChinese.get(source) ?? translateUiText(language, source))
    : source;
}

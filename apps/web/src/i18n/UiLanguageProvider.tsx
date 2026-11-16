import { resolveUiLanguage } from "@t3tools/shared/uiLanguage";
import { useLocale } from "gt-react";
import type { ReactNode } from "react";
import { UiLanguageContext } from "./useUiLanguage";

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return (
    <UiLanguageContext value={resolveUiLanguage("system", locale)}>{children}</UiLanguageContext>
  );
}

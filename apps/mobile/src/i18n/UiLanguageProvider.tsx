import { resolveUiLanguage } from "@t3tools/shared/uiLanguage";
import type { ReactNode } from "react";
import { useResolvedLocale } from "./useResolvedLocale";
import { UiLanguageContext } from "./useUiLanguage";

export function UiLanguageProvider({ children }: { readonly children: ReactNode }) {
  const locale = useResolvedLocale();
  return (
    <UiLanguageContext value={resolveUiLanguage("system", locale)}>{children}</UiLanguageContext>
  );
}

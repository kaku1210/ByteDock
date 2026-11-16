import gtConfig from "../../gt.config.json";

export const DEFAULT_LOCALE = gtConfig.defaultLocale;
export const SUPPORTED_LOCALES: ReadonlyArray<string> = [DEFAULT_LOCALE, ...gtConfig.locales];

export function systemUiLocales(
  browserLanguages: readonly string[],
  desktopLanguages?: readonly string[],
): readonly string[] {
  return desktopLanguages?.length ? desktopLanguages : browserLanguages;
}

import { expect, it } from "vite-plus/test";
import { resolveLocale } from "@t3tools/client-runtime/locales";
import { systemUiLocales, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locales";

it("uses desktop UI preferences instead of Chromium's packaged English locale", () => {
  const system = systemUiLocales(["en-US"], ["zh-CN", "en-US"]);
  expect(resolveLocale("system", system, SUPPORTED_LOCALES, DEFAULT_LOCALE)).toBe("zh");
  expect(resolveLocale("en", system, SUPPORTED_LOCALES, DEFAULT_LOCALE)).toBe("en");
  expect(systemUiLocales(["zh-CN"], [])).toEqual(["zh-CN"]);
  expect(systemUiLocales(["ja-JP"])).toEqual(["ja-JP"]);
});

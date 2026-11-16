import { GTProvider, T } from "gt-react";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { initializeI18n } from "./initializeI18n";
import { UiLanguageProvider } from "./UiLanguageProvider";
import { useUiLanguage } from "./useUiLanguage";
import zh from "./translations/zh.json";

function LanguageProbe() {
  const { text, t } = useUiLanguage();
  return (
    <>
      <p data-testid="upstream">
        <T>System default follows your browser or OS language.</T>
      </p>
      <p data-testid="plus">{t("settings.projectSort.updated")}</p>
      <p data-testid="supplement">{text("Screen reader")}</p>
      <p data-testid="project">{text("Remove {value0}", { value0: "English project" })}</p>
    </>
  );
}

function LanguageFixture() {
  const [locale, setLocale] = useState("zh");
  return (
    <GTProvider locale={locale} translations={{ en: {}, zh }}>
      <UiLanguageProvider>
        <button onClick={() => setLocale("en")}>English</button>
        <button onClick={() => setLocale("zh")}>中文</button>
        <LanguageProbe />
      </UiLanguageProvider>
    </GTProvider>
  );
}

it("switches upstream and Plus together, preferring upstream Chinese and preserving project names", async () => {
  initializeI18n(() => undefined);
  await using screen = await render(<LanguageFixture />);
  await expect
    .element(screen.getByTestId("upstream"))
    .toHaveTextContent("系统默认跟随浏览器或操作系统的语言。");
  await expect.element(screen.getByTestId("plus")).toHaveTextContent("最近一条用户消息");
  await expect.element(screen.getByTestId("supplement")).toHaveTextContent("屏幕阅读器");
  await expect.element(screen.getByTestId("project")).toHaveTextContent("移除 English project");
  await screen.getByRole("button", { name: "English", exact: true }).click();
  await expect
    .element(screen.getByTestId("upstream"))
    .toHaveTextContent("System default follows your browser or OS language.");
  await expect.element(screen.getByTestId("plus")).toHaveTextContent("Last user message");
  await expect.element(screen.getByTestId("supplement")).toHaveTextContent("Screen reader");
  await screen.getByRole("button", { name: "中文", exact: true }).click();
  await expect
    .element(screen.getByTestId("upstream"))
    .toHaveTextContent("系统默认跟随浏览器或操作系统的语言。");
  await expect.element(screen.getByTestId("supplement")).toHaveTextContent("屏幕阅读器");
});

import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { UiLanguageContext } from "~/i18n/useUiLanguage";
import { render } from "../../../test/render";
import { ThreadDetailsContext } from "./ThreadDetailsUsage";

it("distinguishes missing context data and limits from a measured percentage", async () => {
  const usage = deriveLatestContextWindowSnapshot([], {
    usedTokens: 74_240,
    maxTokens: 200_000,
    updatedAt: "2026-11-10T08:00:00.000Z",
  });
  await using screen = await render(
    <UiLanguageContext value="zh-CN">
      <ThreadDetailsContext usage={null} />
    </UiLanguageContext>,
    // The context popover does not use navigation.
    { router: false },
  );
  const control = screen.getByRole("button", { name: "上下文已用 —%", exact: true });
  await expect.element(control).toBeVisible();
  await control.click();
  await expect
    .element(page.getByText("服务商暂未上报上下文用量，未知不等于零。", { exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    <UiLanguageContext value="zh-CN">
      <ThreadDetailsContext
        usage={usage}
        modelDisplayName="Test model"
        onCompact={() => {}}
        compactDisabled
      />
    </UiLanguageContext>,
  );
  const measured = screen.getByRole("button", { name: "上下文已用 37%", exact: true });
  await expect.element(measured).toBeVisible();
  await measured.click();
  await expect.element(page.getByText("74,240 / 200,000 词元", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Test model", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "立即压缩" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    <UiLanguageContext value="zh-CN">
      <ThreadDetailsContext
        usage={usage ? { ...usage, maxTokens: null, usedPercentage: null } : null}
      />
    </UiLanguageContext>,
  );
  await expect.element(control).toBeVisible();
  await control.click();
  await expect.element(page.getByText("74,240 / — 词元", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "立即压缩" })).not.toBeInTheDocument();
  await expect
    .element(page.getByText("服务商未上报上下文上限，暂时无法计算百分比。", { exact: true }))
    .toBeVisible();
});

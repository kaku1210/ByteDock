import { expect, it } from "vite-plus/test";
import { translate, translateUiText } from "./messages.ts";

it("prefers upstream copy, falls back to Plus, and interpolates values without translating them", () => {
  const upstream = (source: string) => (source === "Settings" ? "原版设置" : source);
  expect(translate("zh-CN", "navigation.settings", undefined, upstream)).toBe("原版设置");
  expect(translate("zh-CN", "common.cancel", undefined, upstream)).toBe("取消");
  expect(translateUiText("zh-CN", " Settings ", undefined, upstream)).toBe(" 原版设置 ");
  expect(translateUiText("zh-CN", "Remove {value0}", { value0: "My English project $&" })).toBe(
    "移除 My English project $&",
  );
  expect(translateUiText("en", "Remove {value0}", { value0: "My English project $&" })).toBe(
    "Remove My English project $&",
  );
});

/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { T3_HOME } from "../e2e.config.ts";

import { test, WEB, makeState, runPromise } from "./t3.ts";

test(
  "Chinese settings translate new controls and switch back to English",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get: () => ["zh-CN", "en-US"],
      });
      Object.defineProperty(navigator, "language", { configurable: true, get: () => "zh-CN" });
    });
    await t3.project("English project name");
    // Some dev runners don't print a startup pairing link; mint one for this isolated server.
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pairingPath = path.join(T3_HOME, "pairing-path");
        if (yield* fs.exists(pairingPath)) return;
        const result = yield* makeState(T3_HOME).cli(["pair"]);
        const pairingUrl = /Pairing URL:\s*(\S+)/.exec(result.stdout)?.[1];
        if (!pairingUrl) throw new Error("The scenario server did not return a pairing URL.");
        const { pathname, search, hash } = new URL(pairingUrl);
        yield* fs.writeFileString(pairingPath, `${pathname}${search}${hash}`);
      }),
    );
    await t3.open("/settings/chat");
    await expect(screen.getByRole("heading", "屏幕阅读器", { exact: true })).toBeVisible();
    await expect(screen.getByText("聊天中的工具调用", { exact: true })).toBeVisible();
    await app.screenshot("chinese-chat-settings");

    await app.open("/settings/general#language");
    await expect(screen.getByRole("combobox", "语言", { exact: true })).toBeVisible();
    await app.screenshot("chinese-general-settings");
    await screen.getByRole("combobox", "语言", { exact: true }).tap();
    await screen.getByRole("option", "English", { exact: true }).tap();
    await expect(screen.getByRole("combobox", "Language", { exact: true })).toBeVisible();
    await app.open("/settings/chat");
    await expect(screen.getByRole("heading", "Screen reader", { exact: true })).toBeVisible();
  },
);

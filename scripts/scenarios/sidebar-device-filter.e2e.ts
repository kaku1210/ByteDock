/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { T3_HOME } from "../e2e.config.ts";

import { test, WEB, makeState, runPromise } from "./t3.ts";

test(
  "Device filter hides threads and persists across reloads",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["en-US"] });
      Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
    });
    const project = await t3.project("Device filter project");
    const thread = await t3.thread({ project, title: "Device filter thread", messages: ["first"] });
    // A reused isolated server needs a fresh one-time pairing link for each browser.
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pairingPath = path.join(T3_HOME, "pairing-path");
        const result = yield* makeState(T3_HOME).cli(["pair"]);
        const pairingUrl = /Pairing URL:\s*(\S+)/.exec(result.stdout)?.[1];
        if (!pairingUrl) throw new Error("The scenario server did not return a pairing URL.");
        const { pathname, search, hash } = new URL(pairingUrl);
        yield* fs.writeFileString(pairingPath, `${pathname}${search}${hash}`);
      }),
    );
    await t3.open(thread);
    const row = screen.getByRole("button", "Device filter thread, Device filter project", {
      exact: true,
    });
    await expect(row).toBeVisible();
    await screen.getByRole("button", "Filter threads by device", { exact: true }).tap();
    await app.screenshot("device-filter-all-selected");
    await screen.getByRole("menuitemcheckbox", "All devices", { exact: true }).tap();
    await expect(row).toBeHidden();
    await app.screenshot("device-filter-hidden");
    await app.open("/");
    await screen.getByRole("button", "Filter threads by device", { exact: true }).tap();
    await expect(
      screen.getByRole("menuitemcheckbox", "All devices", { exact: true }),
    ).not.toBeChecked();
    await screen.getByRole("menuitemcheckbox", "All devices", { exact: true }).tap();
    await expect(row).toBeVisible();
    await app.screenshot("device-filter-restored");
  },
);

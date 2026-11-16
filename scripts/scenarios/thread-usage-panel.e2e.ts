/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { T3_HOME } from "../e2e.config.ts";

import { test, WEB, makeState, runPromise } from "./t3.ts";

test(
  "Thread usage stays pinned, persists and reopens",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await browser.addInitScript(() => {
      if (!localStorage.getItem("t3code:thread-details-preferences"))
        localStorage.setItem(
          "t3code:thread-details-preferences",
          JSON.stringify({ state: { pinned: true, open: false, width: 360 }, version: 0 }),
        );
      Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["en-US"] });
      Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
    });
    const project = await t3.project("Usage panel project");
    const thread = await t3.thread({ project, title: "Usage panel thread", messages: ["first"] });
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
    await screen.getByRole("button", "Toggle thread details panel", { exact: true }).tap();
    await expect(screen.getByText("Thread usage", { exact: true })).toBeVisible();
    await expect(screen.getByText("Running time", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", "Unpin details panel", { exact: true })).toBeVisible();
    await expect(
      screen.getByRole("separator", "Resize details panel", { exact: true }),
    ).toBeVisible();
    await app.screenshot("thread-usage-pinned");
    await screen.getByRole("button", "Entire thread", { exact: true }).tap();
    await expect(screen.getByRole("button", "This turn", { exact: true })).toBeVisible();
    await screen
      .getByRole("button", "Usage panel thread, Usage panel project", { exact: true })
      .tap();
    await expect(screen.getByRole("button", "Unpin details panel", { exact: true })).toBeVisible();
    await app.open("/");
    await screen
      .getByRole("button", "Usage panel thread, Usage panel project", { exact: true })
      .tap();
    await expect(screen.getByRole("button", "Unpin details panel", { exact: true })).toBeVisible();
    await expect(screen.getByText("API equivalent (estimated)", { exact: true })).toBeVisible();
    await screen.getByRole("button", "Close details panel", { exact: true }).tap();
    await expect(screen.getByRole("button", "Unpin details panel", { exact: true })).toBeHidden();
    await screen.getByRole("button", "Toggle thread details panel", { exact: true }).tap();
    await expect(screen.getByRole("button", "Unpin details panel", { exact: true })).toBeVisible();
    await app.screenshot("thread-usage-reopened");
  },
);

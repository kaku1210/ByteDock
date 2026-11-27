import { describe, expect, it } from "vite-plus/test";

import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
  latestCommandOutputLine,
} from "./commandOutput.ts";

describe("applyCommandOutputFrame", () => {
  it("continues an escape and a redraw split across appends", () => {
    let view = applyCommandOutputFrame(
      EMPTY_COMMAND_OUTPUT,
      {
        kind: "replace",
        text: "install\n12%\u001b[3",
        truncated: false,
        running: true,
      },
      1_000,
    );
    expect(view.output.text).toBe("install\n12%");
    expect(view.lastOutputAtMs).toBe(1_000);
    view = applyCommandOutputFrame(
      view,
      {
        kind: "append",
        text: "2m\r100%\u001b[0m\n",
        truncated: false,
        running: true,
      },
      2_500,
    );
    // The colour opened before the redraw survives it.
    expect(view.output.text).toBe("install\n\u001b[0;32m100%\u001b[0m\n");
    expect(view.running).toBe(true);
    expect(view.lastOutputAtMs).toBe(2_500);
  });

  it("tracks lastOutputAtMs only when frames carry new output", () => {
    let view = applyCommandOutputFrame(
      EMPTY_COMMAND_OUTPUT,
      { kind: "replace", text: "", truncated: false, running: true },
      1_000,
    );
    expect(view.lastOutputAtMs).toBeNull();

    view = applyCommandOutputFrame(
      view,
      { kind: "append", text: "building\n", truncated: false, running: true },
      2_000,
    );
    expect(view.lastOutputAtMs).toBe(2_000);

    // An unchanged resync replace keeps the previous output timestamp.
    view = applyCommandOutputFrame(
      view,
      { kind: "replace", text: "building\n", truncated: false, running: true },
      5_000,
    );
    expect(view.lastOutputAtMs).toBe(2_000);

    // A replace with new output advances the timestamp.
    view = applyCommandOutputFrame(
      view,
      { kind: "replace", text: "building\ndone\n", truncated: false, running: false },
      7_000,
    );
    expect(view.lastOutputAtMs).toBe(7_000);
  });
});

describe("latestCommandOutputLine", () => {
  it("returns the last non-empty line without ANSI escapes", () => {
    expect(latestCommandOutputLine("")).toBeNull();
    expect(latestCommandOutputLine("\n  \n\u001b[0m\n")).toBeNull();
    expect(
      latestCommandOutputLine(
        "step 1\n\u001b[0;32mCompiling\u001b[0m   module 4/10\n\u001b[0m\n   \n",
      ),
    ).toBe("Compiling module 4/10");
  });

  it("truncates long lines cleanly with an ellipsis", () => {
    expect(latestCommandOutputLine("abcdefghij", 6)).toBe("abcde…");
  });
});

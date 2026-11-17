import "~/index.css";
import { RunId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PromptSuggestionPreference } from "./PromptSuggestionPreference";

it("expands on focus without changing its toolbar slot and collapses after applying", async () => {
  await using screen = await render(
    <div className="flex h-40 items-end gap-1">
      <PromptSuggestionPreference
        threadKey="preference-layout"
        runId={RunId.make("run")}
        value=""
        onGenerate={null}
      />
      <button type="button">Next control</button>
    </div>,
  );
  const input = screen.getByRole("textbox");
  const next = screen.getByRole("button", { name: "Next control" });
  const initialInput = input.element().getBoundingClientRect();
  const initialNext = next.element().getBoundingClientRect();
  await userEvent.click(input);
  await expect.element(input).toHaveFocus();
  expect(input.element().getBoundingClientRect().width).toBeGreaterThan(initialInput.width);
  expect(input.element().getBoundingClientRect().height).toBeGreaterThan(initialInput.height);
  expect(next.element().getBoundingClientRect().x).toBe(initialNext.x);
  await userEvent.keyboard("{Enter}");
  await expect.element(input).not.toHaveFocus();
  expect(input.element().getBoundingClientRect().width).toBe(initialInput.width);
  expect(input.element().getBoundingClientRect().height).toBe(initialInput.height);
});

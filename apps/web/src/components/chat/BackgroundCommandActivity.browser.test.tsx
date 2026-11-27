import "~/index.css";
import {
  applyCommandOutputFrame,
  EMPTY_COMMAND_OUTPUT,
  type CommandOutputView,
} from "@t3tools/client-runtime/state/command-output";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";
import { BackgroundCommandActivity } from "./BackgroundCommandActivity";

function commandOutputSource(view: CommandOutputView) {
  const atom = Atom.make<AsyncResult.AsyncResult<CommandOutputView, unknown>>(
    AsyncResult.success(view),
  );
  return () => atom;
}

it("shows the latest output line and adds a ticking silence notice after 15s", async () => {
  using _timers = fakeTimers({ now: 100_000 });
  const initialView = applyCommandOutputFrame(
    EMPTY_COMMAND_OUTPUT,
    {
      kind: "replace",
      text: "step 1\n\u001b[0;32mRunning tests 3/10\u001b[0m\n",
      truncated: false,
      running: true,
    },
    100_000,
  );

  await using screen = await render(
    <BackgroundCommandActivity
      environmentId={EnvironmentId.make("env-1")}
      threadId={ThreadId.make("thread-1")}
      itemId={TurnItemId.make("item-1")}
      startedAtMs={95_000}
      source={commandOutputSource(initialView)}
    />,
  );

  expect(screen.container.textContent).toBe("Running tests 3/10");

  await vi.advanceTimersByTimeAsync(15_000);
  expect(screen.container.textContent).toBe("Running tests 3/10 · no new output for 15s");

  const nextView = applyCommandOutputFrame(
    initialView,
    {
      kind: "append",
      text: "Running tests 4/10\n",
      truncated: false,
      running: true,
    },
    115_000,
  );
  await screen.rerender(
    <BackgroundCommandActivity
      environmentId={EnvironmentId.make("env-1")}
      threadId={ThreadId.make("thread-1")}
      itemId={TurnItemId.make("item-1")}
      startedAtMs={95_000}
      source={commandOutputSource(nextView)}
    />,
  );
  expect(screen.container.textContent).toBe("Running tests 4/10");
});

it("shows a silence notice when a running command has produced no output for 15s", async () => {
  using _timers = fakeTimers({ now: 200_000 });
  const emptyRunning = applyCommandOutputFrame(
    EMPTY_COMMAND_OUTPUT,
    {
      kind: "replace",
      text: "",
      truncated: false,
      running: true,
    },
    200_000,
  );

  await using screen = await render(
    <BackgroundCommandActivity
      environmentId={EnvironmentId.make("env-1")}
      threadId={ThreadId.make("thread-1")}
      itemId={TurnItemId.make("item-2")}
      startedAtMs={200_000}
      source={commandOutputSource(emptyRunning)}
    />,
  );

  expect(screen.container.textContent).toBe("");

  await vi.advanceTimersByTimeAsync(16_000);
  expect(screen.container.textContent).toBe("No output for 16s");
});

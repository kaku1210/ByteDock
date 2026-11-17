import { expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";
import { deriveThreadTasks, type TaskTimelineItem } from "./threadTasks";

function item(id: string, at: number, steps?: TaskTimelineItem["steps"]): TaskTimelineItem {
  return {
    id,
    at,
    runId: RunId.make("run"),
    providerThreadId: "provider",
    type: steps ? "todo_list" : "dynamic_tool",
    ...(steps ? { steps } : {}),
  };
}

it("keeps the original source and bounds execution to the single running step's interval", () => {
  const steps = [
    { id: "1", text: "Implement", status: "pending" as const },
    { id: "2", text: "Verify", status: "pending" as const },
  ];
  const tasks = deriveThreadTasks([
    item("source", 0, steps),
    item("start", 10, [{ ...steps[0]!, status: "running" }, steps[1]!]),
    item("implementation", 11),
    { ...item("other-provider", 12), providerThreadId: "other" },
    item("next", 20, [
      { ...steps[0]!, status: "completed" },
      { ...steps[1]!, status: "running" },
    ]),
    item("verification", 21),
    item(
      "done",
      30,
      steps.map((step) => ({ ...step, status: "completed" })),
    ),
    item("unrelated", 31),
  ]);
  expect(tasks.map((task) => [task.text, task.sourceId, task.executionId])).toEqual([
    ["Implement", "source", "implementation"],
    ["Verify", "source", "verification"],
  ]);
});

it("does not invent execution for pending, legacy completed, or parallel tasks", () => {
  for (const status of ["pending", "completed", "running"] as const) {
    const steps = ["A", "B"].map((text) => ({ id: text, text, status }));
    expect(
      deriveThreadTasks([item("source", 0, steps), item("unrelated", 10)]).map(
        (task) => task.executionId,
      ),
    ).toEqual([null, null]);
  }
});

it("does not reuse positional IDs after renaming or leak execution across runs", () => {
  const tasks = deriveThreadTasks([
    item("old", 0, [{ id: "1", text: "Old", status: "running" }]),
    item("old-work", 1),
    item("new", 2, [{ id: "1", text: "New", status: "pending" }]),
    {
      ...item("other-run", 3, [{ id: "1", text: "New", status: "completed" }]),
      runId: RunId.make("other"),
    },
  ]);
  expect(tasks.map((task) => [task.sourceId, task.executionId])).toEqual([
    ["other-run", null],
    ["new", null],
  ]);
});

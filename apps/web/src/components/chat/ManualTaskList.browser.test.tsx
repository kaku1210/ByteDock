import { expect, it } from "vite-plus/test";
import {
  MessageId,
  ThreadId,
  RunId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, render } from "../../../test/render";
import { ManualTaskList } from "./ManualTaskList";
import { useManualThreadTasks } from "./manualThreadTasks";
import { useThreadTaskNavigation } from "./threadTaskNavigation";

it("saves selected message anchors, rehydrates, edits and deletes within the owning thread", async () => {
  useManualThreadTasks.setState({ tasks: [] });
  useThreadTaskNavigation.setState({ jump: null });
  using _state = {
    [Symbol.dispose]() {
      useManualThreadTasks.setState({ tasks: [] });
      useThreadTaskNavigation.setState({ jump: null });
    },
  };
  const messages: OrchestrationV2ConversationMessage[] = [
    "Original requirement",
    "Implementation result",
  ].map((text, index) => ({
    id: MessageId.make(`message-${index}`),
    threadId: ThreadId.make("thread"),
    runId: RunId.make("run"),
    nodeId: null,
    role: index === 0 ? "user" : "assistant",
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  }));
  await using screen = await render(
    <ManualTaskList threadKey="environment:thread" messages={messages} />,
  );
  await screen.getByRole("button", { name: "Add task manually" }).click();
  await expect.element(screen.getByRole("button", { name: "Save task" })).toBeDisabled();
  await screen.getByRole("textbox", { name: "Task name" }).fill("My task");
  await screen.getByRole("button", { name: /Original requirement/ }).click();
  await screen.getByRole("button", { name: "Execution location (optional)" }).click();
  await screen.getByRole("searchbox").fill("Implementation");
  await screen.getByRole("button", { name: /Implementation result/ }).click();
  await screen.getByRole("button", { name: "Save task" }).click();
  const saved = useManualThreadTasks.getState().tasks[0]!;
  expect(saved.source.messageId).toBe("message-0");
  expect(saved.execution?.messageId).toBe("message-1");
  const stored = localStorage.getItem("t3code:manual-thread-tasks:v1")!;
  await act(() => useManualThreadTasks.setState({ tasks: [] }));
  localStorage.setItem("t3code:manual-thread-tasks:v1", stored);
  await act(() => useManualThreadTasks.persist.rehydrate());
  expect(useManualThreadTasks.getState().tasks).toEqual([saved]);
  await screen.getByRole("button", { name: /My task/ }).click();
  expect(useThreadTaskNavigation.getState().jump?.messageId).toBe("message-0");
  await act(() =>
    useThreadTaskNavigation.setState((state) => ({ jump: { ...state.jump!, status: "located" } })),
  );
  await screen.getByRole("button", { name: /My task/ }).click();
  expect(useThreadTaskNavigation.getState().jump?.messageId).toBe("message-1");
  await screen.rerender(<ManualTaskList threadKey="other:thread" messages={messages} />);
  await expect.element(screen.getByRole("button", { name: /My task/ })).not.toBeInTheDocument();
  await screen.rerender(<ManualTaskList threadKey="environment:thread" messages={messages} />);
  await screen.getByRole("button", { name: "Edit", exact: true }).click();
  await screen.getByRole("textbox", { name: "Task name" }).fill("Updated task");
  await screen.getByRole("button", { name: "Clear execution location" }).click();
  await screen.getByRole("button", { name: /Implementation result/ }).click();
  await screen.getByRole("button", { name: "Save task" }).click();
  expect(useManualThreadTasks.getState().tasks[0]).toMatchObject({
    id: saved.id,
    title: "Updated task",
    execution: null,
    source: { messageId: "message-1" },
  });
  await screen.getByRole("button", { name: "Delete", exact: true }).click();
  expect(useManualThreadTasks.getState().tasks).toEqual([]);
});

import { useState } from "react";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  jumpToTaskMessage,
  useManualThreadTasks,
  type ManualThreadTask,
  type TaskMessageAnchor,
} from "./manualThreadTasks";
import { useThreadTaskNavigation } from "./threadTaskNavigation";

export function ManualTaskList({
  threadKey,
  messages,
  compact = false,
}: {
  threadKey: string;
  messages: readonly OrchestrationV2ConversationMessage[];
  compact?: boolean;
}) {
  const { text } = useUiLanguage();
  const tasks = useManualThreadTasks((state) => state.tasks);
  const [editing, setEditing] = useState<ManualThreadTask | "new" | null>(null);
  const jump = useThreadTaskNavigation((state) => state.jump);
  const [last, setLast] = useState<{ key: string; destination: "source" | "execution" } | null>(
    null,
  );
  if (
    jump?.threadKey === threadKey &&
    jump.status === "located" &&
    (last?.key !== jump.taskKey || last.destination !== jump.destination)
  ) {
    setLast({ key: jump.taskKey, destination: jump.destination });
  }
  return (
    <section
      aria-label={text("Manual tasks")}
      className={compact ? "space-y-2" : "space-y-2 border-b border-border pb-3 mb-2"}
    >
      <div className="flex items-center justify-between gap-2">
        {!compact ? <span className="text-xs font-medium">{text("Manual tasks")}</span> : null}
        <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
          {text("Add task manually")}
        </Button>
      </div>
      {!compact || editing !== null ? (
        <p className="text-xs text-muted-foreground">
          {text("Manual tasks are saved on this device only.")}
        </p>
      ) : null}
      {tasks
        .filter((task) => task.threadKey === threadKey)
        .map((task) => (
          <div key={task.id} className="flex items-start gap-1">
            <button
              type="button"
              className="min-w-0 flex-1 rounded-md px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                const destination =
                  task.execution && last?.key === task.id && last.destination === "source"
                    ? "execution"
                    : "source";
                jumpToTaskMessage(
                  threadKey,
                  task.id,
                  destination,
                  destination === "execution" ? task.execution! : task.source,
                );
              }}
            >
              <span className="block break-words">{task.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {task.source.preview}
              </span>
              <span className="block text-xs text-muted-foreground">
                {text(
                  task.execution && last?.key === task.id && last.destination === "source"
                    ? "Next: execution location"
                    : "Next: task source",
                )}
              </span>
            </button>
            <Button variant="ghost" size="xs" onClick={() => setEditing(task)}>
              {text("Edit")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => useManualThreadTasks.getState().remove(task.id, threadKey)}
            >
              {text("Delete")}
            </Button>
          </div>
        ))}
      {editing !== null ? (
        <ManualTaskEditor
          key={editing === "new" ? "new" : editing.id}
          threadKey={threadKey}
          messages={messages}
          task={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ManualTaskEditor({
  threadKey,
  messages,
  task,
  onClose,
}: {
  threadKey: string;
  messages: readonly OrchestrationV2ConversationMessage[];
  task: ManualThreadTask | null;
  onClose: () => void;
}) {
  const { text } = useUiLanguage();
  const [title, setTitle] = useState(task?.title ?? "");
  const [source, setSource] = useState<TaskMessageAnchor | null>(task?.source ?? null);
  const [execution, setExecution] = useState<TaskMessageAnchor | null>(task?.execution ?? null);
  const [picking, setPicking] = useState<"source" | "execution">("source");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const matches = messages
    .filter(
      (message) =>
        message.text.trim() && message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .toReversed();
  const candidates = matches.slice(0, limit);
  return (
    <form
      className="space-y-2 rounded-md border border-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || !source) return;
        useManualThreadTasks
          .getState()
          .save({ ...(task ? { id: task.id } : {}), threadKey, title, source, execution });
        onClose();
      }}
    >
      <Input
        aria-label={text("Task name")}
        placeholder={text("Task name")}
        value={title}
        maxLength={300}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="flex gap-1">
        <Button
          type="button"
          size="xs"
          variant={picking === "source" ? "secondary" : "ghost"}
          onClick={() => setPicking("source")}
        >
          {text("Task source (required)")}
        </Button>
        <Button
          type="button"
          size="xs"
          variant={picking === "execution" ? "secondary" : "ghost"}
          onClick={() => setPicking("execution")}
        >
          {text("Execution location (optional)")}
        </Button>
      </div>
      <p className="text-xs break-words">
        {text("Task source (required)")}: {source?.preview ?? text("Not selected")}
      </p>
      <p className="text-xs break-words">
        {text("Execution location (optional)")}: {execution?.preview ?? text("Not selected")}
      </p>
      {execution ? (
        <Button type="button" variant="ghost" size="xs" onClick={() => setExecution(null)}>
          {text("Clear execution location")}
        </Button>
      ) : null}
      <Input
        type="search"
        aria-label={text("Search conversation messages")}
        placeholder={text("Search conversation messages")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setLimit(50);
        }}
      />
      <p className="text-xs text-muted-foreground">
        {text("Select a message below. Use Load earlier tasks to include older messages.")}
      </p>
      <div className="max-h-40 overflow-y-auto" aria-label={text("Conversation locations")}>
        {candidates.map((message) => {
          const anchor = {
            messageId: message.id,
            runId: message.runId,
            preview: message.text.trim().slice(0, 160),
          };
          const selected = (picking === "source" ? source : execution)?.messageId === message.id;
          return (
            <div key={message.id} className="flex items-start gap-1">
              <button
                type="button"
                aria-pressed={selected}
                className="min-w-0 flex-1 rounded-md px-2 py-1 text-left text-xs hover:bg-accent aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => (picking === "source" ? setSource(anchor) : setExecution(anchor))}
              >
                <span className="block text-muted-foreground">
                  {text(
                    message.role === "user"
                      ? "You"
                      : message.role === "assistant"
                        ? "Assistant"
                        : "System",
                  )}
                </span>
                <span className="block text-muted-foreground">
                  {DateTime.toDateUtc(message.createdAt).toLocaleString()}
                </span>
                <span className="line-clamp-2 break-words">{anchor.preview}</span>
              </button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => jumpToTaskMessage(threadKey, "manual-task-preview", picking, anchor)}
              >
                {text("Preview location")}
              </Button>
            </div>
          );
        })}
        {candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground">{text("No matching messages loaded.")}</p>
        ) : null}
        {matches.length > limit ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => setLimit(limit + 50)}>
            {text("Show more messages")}
          </Button>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={!title.trim() || !source}>
          {text("Save task")}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          {text("Cancel")}
        </Button>
      </div>
    </form>
  );
}

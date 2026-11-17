import { useState } from "react";
import * as DateTime from "effect/DateTime";
import { ChevronDownIcon, ChevronRightIcon, ListTodoIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useQuietThreadProjection, useThreadHistory } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Button } from "../ui/button";
import { useThreadDetailsPreferences } from "./threadDetailsPreferences";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { deriveThreadTasks, type ThreadTask } from "./threadTasks";
import { useThreadTaskNavigation } from "./threadTaskNavigation";
import { closeThreadFind } from "./threadFindStore";
import { ManualTaskList } from "./ManualTaskList";
import { useManualThreadTasks } from "./manualThreadTasks";

export function ThreadTaskList({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { text } = useUiLanguage();
  const collapsed = useThreadDetailsPreferences((state) => state.tasksCollapsed);
  const hasManualTasks = useManualThreadTasks((state) =>
    state.tasks.some((task) => task.threadKey === scopedThreadKey(threadRef)),
  );
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const history = useThreadHistory(threadRef);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const jump = useThreadTaskNavigation((state) => state.jump);
  const threadKey = scopedThreadKey(threadRef);
  const tasks = (() => {
    const plans = new Map(projection?.plans.map((plan) => [plan.id, plan]));
    return deriveThreadTasks(
      (projection?.turnItems ?? []).map((item) => {
        const plan = item.type === "todo_list" ? plans.get(item.planId) : undefined;
        return {
          id: item.id,
          runId: item.runId,
          providerThreadId: item.providerThreadId ?? null,
          type: item.type,
          at: item.startedAt ? DateTime.toEpochMillis(item.startedAt) : Number.NaN,
          ...(item.type === "todo_list"
            ? {
                steps: item.steps.map((step) => {
                  const timed =
                    plan?.kind === "todo_list"
                      ? plan.steps.find(
                          (entry) =>
                            entry.id === step.id &&
                            entry.text === step.text &&
                            entry.status === step.status,
                        )
                      : undefined;
                  return timed ?? step;
                }),
              }
            : {}),
        };
      }),
    );
  })();
  const hasTasks = tasks.length > 0 || hasManualTasks;
  const groups = new Map<string, ThreadTask[]>();
  for (const task of tasks) {
    const id = task.runId ?? task.sourceId;
    const group = groups.get(id) ?? [];
    group.push(task);
    groups.set(id, group);
  }
  const [notice, setNotice] = useState("");
  const [last, setLast] = useState<{ key: string; destination: "source" | "execution" } | null>(
    null,
  );
  const active = jump?.threadKey === threadKey ? jump : null;
  const located =
    active?.status === "located" ? { key: active.taskKey, destination: active.destination } : last;
  if (
    active?.status === "located" &&
    (last?.key !== active.taskKey || last.destination !== active.destination)
  ) {
    setLast({ key: active.taskKey, destination: active.destination });
  }
  const select = (task: ThreadTask) => {
    const destination =
      located?.key === task.key && located.destination === "source" ? "execution" : "source";
    if (destination === "execution" && !task.executionId) {
      setNotice(
        text(
          task.status === "pending"
            ? "This task has not started."
            : "No linked execution record is available.",
        ),
      );
      return;
    }
    setNotice(
      destination === "execution"
        ? text(
            "Showing activity near this task's running interval; exact ownership is unavailable.",
          )
        : "",
    );
    const requestId = useThreadTaskNavigation.getState().requestId + 1;
    closeThreadFind();
    useThreadTaskNavigation.setState({
      requestId,
      jump: {
        threadKey,
        taskKey: task.key,
        stepId: task.stepId,
        destination,
        match: {
          entryId: destination === "source" ? task.sourceId : task.executionId!,
          runId: task.runId,
          occurrence: 0,
        },
        requestId,
        status: "pending",
      },
    });
  };
  return (
    <div className="border-t border-border px-2 py-1">
      {hasTasks ? (
        <ThreadDetailsControl
          part="row"
          panel
          aria-expanded={!collapsed}
          onClick={() => useThreadDetailsPreferences.getState().setTasksCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronRightIcon aria-hidden className="size-4" />
          ) : (
            <ChevronDownIcon aria-hidden className="size-4" />
          )}
          <ListTodoIcon aria-hidden className="size-4" />
          <span>{text("Task list")}</span>
        </ThreadDetailsControl>
      ) : null}
      <div hidden={hasTasks && collapsed}>
        <div
          data-thread-task-list-scroll
          className="max-h-[min(28rem,50dvh)] overflow-y-auto px-1 py-2"
        >
          <ManualTaskList
            threadKey={threadKey}
            messages={projection?.messages ?? []}
            compact={!hasTasks}
          />
          {tasks.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {text("Click a task to see its source. Click again to see execution nearby.")}
            </p>
          ) : null}
          {[...groups].map(([groupId, groupTasks], index) => (
            <details key={groupId} open={index === 0}>
              <summary className="cursor-pointer py-2 text-xs font-medium">
                {text(index === 0 ? "Latest plan" : "Earlier plan")} ({groupTasks.length})
              </summary>
              <ol className="space-y-1">
                {groupTasks.map((task) => (
                  <li key={task.key}>
                    <button
                      type="button"
                      className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => select(task)}
                    >
                      <span className="flex gap-2">
                        <span aria-hidden>
                          {task.status === "completed"
                            ? "✓"
                            : task.status === "running"
                              ? "◉"
                              : "○"}
                        </span>
                        <span className="min-w-0 break-words">{task.text}</span>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {text(
                          task.status === "completed"
                            ? "Completed"
                            : task.status === "running"
                              ? "Running"
                              : "Pending",
                        )}{" "}
                        ·{" "}
                        {text(
                          located?.key === task.key && located.destination === "source"
                            ? "Next: execution nearby"
                            : "Next: task source",
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          ))}
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {active?.status === "pending"
              ? text("Locating task…")
              : active?.status === "missing"
                ? text("The target could not be loaded. Click the task to retry.")
                : notice}
          </p>
          {history.error ? (
            <p role="alert" className="text-xs text-destructive">
              {history.error}
            </p>
          ) : null}
          {history.hasMoreHistory ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={history.loading}
              onClick={() =>
                void load({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId },
                })
              }
            >
              {text(history.loading ? "Loading…" : "Load earlier tasks")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

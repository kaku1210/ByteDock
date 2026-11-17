import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { MessageId, RunId } from "@t3tools/contracts";
import { resolveStorage } from "../../lib/storage";
import { randomUUID } from "../../lib/utils";
import { closeThreadFind } from "./threadFindStore";
import { useThreadTaskNavigation } from "./threadTaskNavigation";

export interface TaskMessageAnchor {
  messageId: MessageId;
  runId: RunId | null;
  preview: string;
}

export interface ManualThreadTask {
  id: string;
  threadKey: string;
  title: string;
  source: TaskMessageAnchor;
  execution: TaskMessageAnchor | null;
}

function isAnchor(value: unknown): value is TaskMessageAnchor {
  if (!value || typeof value !== "object") return false;
  return (
    "messageId" in value &&
    typeof value.messageId === "string" &&
    "runId" in value &&
    (value.runId === null || typeof value.runId === "string") &&
    "preview" in value &&
    typeof value.preview === "string"
  );
}

function readManualTasks(value: unknown): ManualThreadTask[] {
  if (!value || typeof value !== "object" || !("tasks" in value) || !Array.isArray(value.tasks))
    return [];
  return value.tasks.filter(
    (task): task is ManualThreadTask =>
      task &&
      typeof task === "object" &&
      typeof task.id === "string" &&
      typeof task.threadKey === "string" &&
      typeof task.title === "string" &&
      task.title.trim().length > 0 &&
      isAnchor(task.source) &&
      (task.execution === null || isAnchor(task.execution)),
  );
}

export const useManualThreadTasks = create<{
  tasks: ManualThreadTask[];
  save: (task: Omit<ManualThreadTask, "id"> & { id?: string }) => void;
  remove: (id: string, threadKey: string) => void;
  removeThread: (threadKey: string) => void;
}>()(
  persist(
    (set) => ({
      tasks: [],
      save: (task) => {
        const title = task.title.trim();
        if (!title) return;
        const entry = { ...task, title, id: task.id ?? randomUUID() };
        set((state) => ({
          tasks: [
            ...state.tasks.filter(
              (old) => old.id !== entry.id || old.threadKey !== entry.threadKey,
            ),
            entry,
          ],
        }));
      },
      remove: (id, threadKey) =>
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== id || task.threadKey !== threadKey),
        })),
      removeThread: (threadKey) =>
        set((state) => ({ tasks: state.tasks.filter((task) => task.threadKey !== threadKey) })),
    }),
    {
      name: "t3code:manual-thread-tasks:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ tasks }) => ({ tasks }),
      merge: (persisted, current) => ({ ...current, tasks: readManualTasks(persisted) }),
    },
  ),
);

export function jumpToTaskMessage(
  threadKey: string,
  taskKey: string,
  destination: "source" | "execution",
  anchor: TaskMessageAnchor,
) {
  closeThreadFind();
  const requestId = useThreadTaskNavigation.getState().requestId + 1;
  useThreadTaskNavigation.setState({
    requestId,
    jump: {
      threadKey,
      taskKey,
      destination,
      requestId,
      status: "pending",
      messageId: anchor.messageId,
      match: { entryId: anchor.messageId, runId: anchor.runId, occurrence: 0 },
    },
  });
}

import { create } from "zustand";
import type { ThreadFindMatch } from "./threadFind";
import type { MessageId } from "@t3tools/contracts";

export interface TaskJump {
  readonly threadKey: string;
  readonly taskKey: string;
  readonly stepId?: string;
  readonly messageId?: MessageId;
  readonly destination: "source" | "execution";
  readonly match: ThreadFindMatch;
  readonly requestId: number;
  readonly status: "pending" | "located" | "missing";
}

export const useThreadTaskNavigation = create<{ jump: TaskJump | null; requestId: number }>(() => ({
  jump: null,
  requestId: 0,
}));

export function finishTaskJump(requestId: number, status: "located" | "missing") {
  useThreadTaskNavigation.setState((state) =>
    state.jump?.requestId === requestId ? { jump: { ...state.jump, status } } : state,
  );
}

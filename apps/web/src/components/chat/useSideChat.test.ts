import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { startSideChatFlow, type StartSideChatDeps } from "./useSideChat";

const environmentId = EnvironmentId.make("env-1");
const parentThreadId = ThreadId.make("thread-parent");
const targetThreadId = ThreadId.make("thread-side-chat");
const parentRef = scopeThreadRef(environmentId, parentThreadId);

function makeDeps(overrides: Partial<StartSideChatDeps> = {}) {
  const forkSideChat = vi.fn(async () => AsyncResult.success(undefined));
  const deleteThread = vi.fn(async () => AsyncResult.success(undefined));
  const setThreadRuntimeMode = vi.fn(async () => AsyncResult.success(undefined));
  const startThreadTurn = vi.fn(async () => AsyncResult.success(undefined));
  const waitForThreadShell = vi.fn(async () => true);
  const readThreadShell = vi.fn(() => ({ runtimeMode: "full-access" as const }));
  const setModelSelection = vi.fn();
  const appendCitation = vi.fn();
  const openThread = vi.fn();

  const deps: StartSideChatDeps = {
    forkSideChat,
    deleteThread,
    setThreadRuntimeMode,
    startThreadTurn,
    waitForThreadShell,
    readThreadShell,
    setModelSelection,
    appendCitation,
    openThread,
    newThreadId: () => targetThreadId,
    newMessageId: () => MessageId.make("msg-1"),
    nowIso: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  };

  return {
    deps,
    forkSideChat,
    deleteThread,
    setThreadRuntimeMode,
    startThreadTurn,
    waitForThreadShell,
    readThreadShell,
    setModelSelection,
    appendCitation,
    openThread,
  };
}

describe("startSideChatFlow", () => {
  it("never deletes the created side chat when waitForThreadShell times out", async () => {
    const onError = vi.fn();
    const harness = makeDeps({
      waitForThreadShell: vi.fn(async () => false),
    });

    const ok = await startSideChatFlow({
      threadRef: parentRef,
      message: undefined,
      readSettings: () => ({ runtimeMode: "full-access", modelSelection: undefined }),
      onError,
      deps: harness.deps,
    });

    expect(ok).toBe(false);
    expect(harness.forkSideChat).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "The side chat was created, but it did not reach this client.",
    );
    expect(harness.deleteThread).not.toHaveBeenCalled();
    expect(harness.openThread).not.toHaveBeenCalled();
  });

  it("never deletes the created side chat when readThreadShell returns null after waiting", async () => {
    const onError = vi.fn();
    const harness = makeDeps({
      waitForThreadShell: vi.fn(async () => true),
      readThreadShell: vi.fn(() => null),
    });

    const ok = await startSideChatFlow({
      threadRef: parentRef,
      message: undefined,
      readSettings: () => ({ runtimeMode: "full-access", modelSelection: undefined }),
      onError,
      deps: harness.deps,
    });

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith("The side chat is no longer available.");
    expect(harness.deleteThread).not.toHaveBeenCalled();
    expect(harness.openThread).not.toHaveBeenCalled();
  });

  it("opens the right panel tab without deleting when fallback sync succeeds", async () => {
    const onError = vi.fn();
    const harness = makeDeps();

    const ok = await startSideChatFlow({
      threadRef: parentRef,
      message: undefined,
      readSettings: () => ({ runtimeMode: "full-access", modelSelection: undefined }),
      onError,
      deps: harness.deps,
    });

    expect(ok).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(harness.deleteThread).not.toHaveBeenCalled();
    expect(harness.openThread).toHaveBeenCalledWith(parentRef, targetThreadId);
  });

  it("still discards an unused side chat when an explicit post-creation command fails", async () => {
    const onError = vi.fn();
    const harness = makeDeps({
      startThreadTurn: vi.fn(async () =>
        AsyncResult.failure(Cause.fail(new Error("Turn failed to start"))),
      ),
    });

    const ok = await startSideChatFlow({
      threadRef: parentRef,
      message: { text: "Hello", attachments: [], titleSeed: "Hello" },
      readSettings: () => ({ runtimeMode: "full-access", modelSelection: undefined }),
      onError,
      deps: harness.deps,
    });

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith("Turn failed to start");
    expect(harness.deleteThread).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: targetThreadId, onlyIfUnused: true },
    });
    expect(harness.openThread).not.toHaveBeenCalled();
  });
});

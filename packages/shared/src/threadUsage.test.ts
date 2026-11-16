import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderThreadId,
  ProviderDriverKind,
  NodeId,
} from "@t3tools/contracts";
import { intervalDuration, threadUsageScope } from "./threadUsage.ts";

describe("thread usage", () => {
  it("merges overlapping execution intervals without adding idle gaps", () => {
    expect(
      intervalDuration([
        [0, 100],
        [50, 150],
        [200, 250],
        [400, 300],
      ]),
    ).toBe(200);
  });
  it("scopes native sessions to this thread's turns and separates waiting and reasoning", () => {
    const threadId = ThreadId.make("thread");
    const runId = RunId.make("run");
    const attemptId = RunAttemptId.make("attempt");
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const nodeId = NodeId.make("node");
    const driver = ProviderDriverKind.make("claudeAgent");
    const at = (ms: number) => DateTime.makeUnsafe(ms);
    const projection: Parameters<typeof threadUsageScope>[0] = {
      thread: { id: threadId, createdAt: at(10) },
      runs: [{ id: runId, startedAt: at(20), workStartedAt: at(30), completedAt: at(200) }],
      attempts: [{ id: attemptId, runId }],
      providerTurns: [
        {
          providerThreadId,
          runAttemptId: attemptId,
          startedAt: at(30),
          completedAt: at(200),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 10,
            cachedInputTokens: 50,
          },
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          appThreadId: threadId,
          driver,
          nativeThreadRef: { driver, nativeId: "native", strength: "strong" },
        },
      ],
      nodes: [
        {
          id: nodeId,
          runId,
          kind: "reasoning",
          status: "completed",
          startedAt: at(30),
          completedAt: at(50),
        },
      ],
      runtimeRequests: [{ nodeId, createdAt: at(60), resolvedAt: at(100) }],
    };
    const result = threadUsageScope(projection, null, 999);
    expect(result.tokens).toBe(120);
    expect(result.runtimeMs).toBe(130);
    expect(result.waitingMs).toBe(40);
    expect(result.reasoningMs).toBe(20);
    const overlapping = threadUsageScope(
      {
        ...projection,
        runs: [
          ...projection.runs,
          {
            id: RunId.make("parallel"),
            startedAt: at(70),
            workStartedAt: at(70),
            completedAt: at(90),
          },
        ],
      },
      null,
      999,
    );
    expect(overlapping.runtimeMs).toBe(150);
    expect(overlapping.waitingMs).toBe(20);

    expect(result.scopes).toEqual([
      { provider: "claude", sessionId: "native", since: 30, until: 200 },
    ]);
    expect(threadUsageScope(projection, RunId.make("other"), 999).scopes).toEqual([]);
    expect(
      threadUsageScope({ ...projection, nodes: [], providerTurns: [] }, null, 999).reasoningMs,
    ).toBeNull();
  });
});

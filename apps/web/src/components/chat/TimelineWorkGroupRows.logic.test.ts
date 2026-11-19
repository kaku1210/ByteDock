import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import {
  extractWorkEntryGitCommitMessage,
  extractWorkEntryReadIntentSummary,
  summarizeWorkGroupProgress,
} from "./TimelineWorkGroupRows.logic";

function readEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "read-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read src/orchestrator.ts",
    tone: "tool",
    itemType: "dynamic_tool",
    toolTitle: "Read",
    toolLifecycleStatus: "completed",
    toolData: {
      input: { file_path: "/repo/src/orchestrator.ts" },
      output: "Read prepareForkDelta implementation",
    },
    ...overrides,
  };
}

function commandEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "cmd-1",
    createdAt: "2026-01-01T00:00:01.000Z",
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    toolTitle: "Command",
    toolLifecycleStatus: "completed",
    command: 'git commit -m "feat: add progress bar"',
    rawCommand: 'git commit -m "feat: add progress bar"',
    ...overrides,
  };
}

function editEntry(id: string, files: ReadonlyArray<string>): WorkLogEntry {
  return {
    id,
    createdAt: "2026-01-01T00:00:02.000Z",
    label: `Changed ${files[0] ?? "file"}`,
    tone: "tool",
    itemType: "file_change",
    toolTitle: "File change",
    toolLifecycleStatus: "completed",
    changedFiles: files,
  };
}

describe("extractWorkEntryReadIntentSummary", () => {
  it("extracts short single-line semantic read summaries from Antigravity Read outputs", () => {
    expect(extractWorkEntryReadIntentSummary(readEntry(), "Read src/orchestrator.ts")).toBe(
      "Read prepareForkDelta implementation",
    );

    expect(
      extractWorkEntryReadIntentSummary(
        readEntry({
          toolData: {
            input: { file_path: "/repo/src/orchestrator.ts" },
            output: "  View   queuedRunCancellationEvents  ",
          },
        }),
        "Read src/orchestrator.ts",
      ),
    ).toBe("View queuedRunCancellationEvents");
  });

  it("rejects multiline dumps, code lines, bare paths, generic strings, and non-read tools", () => {
    for (const output of [
      "line 1\nline 2",
      "1: import { Effect } from 'effect';",
      "import foo from './bar';",
      '{"key": "value"}',
      "Tool execution",
      "Read file",
      "ok",
      "apps/web/src/components/chat/TimelineWorkGroupRows.tsx",
      "D:\\Project\\AgentLearn\\t3code\\package.json",
      "[Earlier output truncated] Read file",
      "x".repeat(121),
    ]) {
      expect(
        extractWorkEntryReadIntentSummary(
          readEntry({ toolData: { input: { file_path: "/repo/a.ts" }, output } }),
          "Read a.ts",
        ),
        output,
      ).toBeNull();
    }

    expect(
      extractWorkEntryReadIntentSummary(
        readEntry({
          toolData: { input: { file_path: "/repo/a.ts" }, output: "Read a.ts" },
        }),
        "Read a.ts",
      ),
    ).toBeNull();

    expect(extractWorkEntryReadIntentSummary(commandEntry())).toBeNull();
  });
});

describe("extractWorkEntryGitCommitMessage", () => {
  it("prefers the git commit output header and supports root-commit headers", () => {
    expect(
      extractWorkEntryGitCommitMessage(
        commandEntry({
          command: "git commit --amend --no-edit",
          rawCommand: "git commit --amend --no-edit",
          detail: "[feat/progress 1a2b3c4] feat: show work group progress bar\n 2 files changed",
        }),
      ),
    ).toBe("feat: show work group progress bar");

    expect(
      extractWorkEntryGitCommitMessage(
        commandEntry({
          detail: "[main (root-commit) deadbee] Initial commit\n 1 file changed",
        }),
      ),
    ).toBe("Initial commit");
  });

  it("falls back to -m / -am commit message flags and ignores failed or dry-run commits", () => {
    expect(extractWorkEntryGitCommitMessage(commandEntry())).toBe("feat: add progress bar");
    expect(
      extractWorkEntryGitCommitMessage(
        commandEntry({
          command: "git commit -am 'fix: trim read summary'",
          rawCommand: "git commit -am 'fix: trim read summary'",
        }),
      ),
    ).toBe("fix: trim read summary");

    expect(
      extractWorkEntryGitCommitMessage(
        commandEntry({
          command: 'git commit --dry-run -m "nope"',
          rawCommand: 'git commit --dry-run -m "nope"',
        }),
      ),
    ).toBeNull();
    expect(
      extractWorkEntryGitCommitMessage(commandEntry({ toolLifecycleStatus: "failed" })),
    ).toBeNull();
    expect(
      extractWorkEntryGitCommitMessage(commandEntry({ toolLifecycleStatus: "inProgress" })),
    ).toBeNull();
    expect(
      extractWorkEntryGitCommitMessage(
        commandEntry({
          command: 'git commit -m "$MSG"',
          rawCommand: 'git commit -m "$MSG"',
        }),
      ),
    ).toBeNull();
  });
});

describe("summarizeWorkGroupProgress", () => {
  it("summarizes steps, unique edited files, failures, latest commit, and latest action", () => {
    const entries: WorkLogEntry[] = [
      readEntry({ id: "1" }),
      editEntry("2", ["/repo/src/a.ts", "/repo/src/b.ts"]),
      editEntry("3", ["\\repo\\src\\a.ts"]),
      commandEntry({
        id: "4",
        command: 'git commit -m "feat: phase 1"',
        rawCommand: 'git commit -m "feat: phase 1"',
      }),
      commandEntry({
        id: "5",
        command: "vp test run",
        rawCommand: "vp test run",
        toolLifecycleStatus: "failed",
      }),
      commandEntry({
        id: "6",
        command: 'git commit -m "fix: phase 1 tests"',
        rawCommand: 'git commit -m "fix: phase 1 tests"',
        detail: "[feat/test 9876543] fix: phase 1 tests\n 1 file changed",
      }),
      readEntry({
        id: "7",
        toolLifecycleStatus: "inProgress",
        toolData: {
          input: { file_path: "/repo/src/c.ts" },
          output: "Inspect retry loop in orchestrator",
        },
      }),
    ];

    expect(summarizeWorkGroupProgress(entries, "/repo")).toEqual({
      totalSteps: 7,
      editedFileCount: 2,
      failedCount: 1,
      latestCommitMessage: "fix: phase 1 tests",
      latestActionLabel: "Inspect retry loop in orchestrator",
      latestIsInProgress: true,
    });
  });
});

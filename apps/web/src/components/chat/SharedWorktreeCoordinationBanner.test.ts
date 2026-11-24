import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type SharedWorktreeCoordinationSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getActiveOverlaps,
  resolveSharedWorktreeQueryRef,
} from "./SharedWorktreeCoordinationBanner";

const environmentId = EnvironmentId.make("env-1");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const rootId = ThreadId.make("thread-root");
const sideId = ThreadId.make("thread-side");
const sideRef = scopeThreadRef(environmentId, sideId);

function makeShell(overrides: {
  readonly id: ThreadId;
  readonly projectId?: ProjectId;
  readonly worktreePath?: string | null;
  readonly deletedAt?: string | null;
}): EnvironmentThreadShell {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? projectA,
    worktreePath: overrides.worktreePath ?? "/repo",
    deletedAt: overrides.deletedAt ?? null,
  } as unknown as EnvironmentThreadShell;
}

function makeOverlapSnapshot(
  overrides: Partial<SharedWorktreeCoordinationSnapshot> = {},
): SharedWorktreeCoordinationSnapshot {
  return {
    rootThreadId: rootId,
    checkoutPath: "/repo",
    checkoutKey: "/repo",
    policy: {
      checkoutKey: "/repo",
      checkoutPath: "/repo",
      serializationMode: "parallel",
      shellConstraintCoverage: {
        serverEnforcedWorktreeGate: true,
        serverEnforcedWriteReservation: true,
        checkoutWriteSerializationEnabled: false,
        shellGitWorktreeConstraint: "provider_tool_permission",
        summary: "summary",
      },
      updatedAt: IsoDateTime.make("2026-06-20T00:00:00.000Z"),
      updatedBy: "system",
    },
    sharedThreadCount: 2,
    threads: [],
    overlaps: [],
    observedUnverifiedPaths: [],
    activeReservations: [],
    waitingReservations: [],
    activeSerializedRun: null,
    waitingSerializedRuns: [],
    restoreSafetyProtected: true,
    generatedAt: IsoDateTime.make("2026-06-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("resolveSharedWorktreeQueryRef", () => {
  it("deduplicates a side chat query ref to its live root thread when sharing project and worktree", () => {
    const resolved = resolveSharedWorktreeQueryRef(
      sideRef,
      makeShell({ id: sideId, projectId: projectA, worktreePath: "/repo" }),
      makeShell({ id: rootId, projectId: projectA, worktreePath: "/repo" }),
    );
    expect(resolved).toEqual(scopeThreadRef(environmentId, rootId));
  });

  it("keeps the thread's own ref when worktree, project, or root liveness differs", () => {
    expect(resolveSharedWorktreeQueryRef(null, null, null)).toBeNull();
    expect(
      resolveSharedWorktreeQueryRef(
        sideRef,
        makeShell({ id: sideId, worktreePath: "/repo-wt-1" }),
        makeShell({ id: rootId, worktreePath: "/repo" }),
      ),
    ).toEqual(sideRef);
    expect(
      resolveSharedWorktreeQueryRef(
        sideRef,
        makeShell({ id: sideId, projectId: projectA }),
        makeShell({ id: rootId, projectId: projectB }),
      ),
    ).toEqual(sideRef);
    expect(
      resolveSharedWorktreeQueryRef(
        sideRef,
        makeShell({ id: sideId }),
        makeShell({ id: rootId, deletedAt: "2026-01-01T00:00:00.000Z" }),
      ),
    ).toEqual(sideRef);
  });
});

describe("getActiveOverlaps", () => {
  const threadA = ThreadId.make("thread:a");
  const threadB = ThreadId.make("thread:b");
  const threadC = ThreadId.make("thread:c");

  it("filters out historical idle overlaps even when participants carry non-null historical runIds", () => {
    const snapshot = makeOverlapSnapshot({
      threads: [
        {
          threadId: threadA,
          title: "Idle A",
          depth: 0,
          activeRunId: null,
          status: "idle",
          inFamily: true,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
        {
          threadId: threadB,
          title: "Idle B",
          depth: 0,
          activeRunId: null,
          status: "idle",
          inFamily: false,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
      ],
      overlaps: [
        {
          normalizedPath: "api/report.md",
          kind: "exact",
          severity: "warning",
          participants: [
            {
              threadId: threadA,
              threadTitle: "Idle A",
              runId: RunId.make("run:old-a"),
              layers: ["confirmed_write"],
              rawPaths: ["api/report.md"],
            },
            {
              threadId: threadB,
              threadTitle: "Idle B",
              runId: RunId.make("run:old-b"),
              layers: ["confirmed_write"],
              rawPaths: ["api/report.md"],
            },
          ],
          recommendedAction: "Coordinate",
        },
      ],
    });

    expect(getActiveOverlaps(snapshot)).toEqual([]);
  });

  it("filters out overlaps where only one thread is active and the other is idle", () => {
    const snapshot = makeOverlapSnapshot({
      threads: [
        {
          threadId: threadA,
          title: "Active A",
          depth: 0,
          activeRunId: RunId.make("run:active-a"),
          status: "running",
          inFamily: true,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
        {
          threadId: threadB,
          title: "Idle B",
          depth: 0,
          activeRunId: null,
          status: "idle",
          inFamily: false,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
      ],
      overlaps: [
        {
          normalizedPath: "api/report.md",
          kind: "exact",
          severity: "warning",
          participants: [
            {
              threadId: threadA,
              threadTitle: "Active A",
              runId: RunId.make("run:active-a"),
              layers: ["confirmed_write"],
              rawPaths: ["api/report.md"],
            },
            {
              threadId: threadB,
              threadTitle: "Idle B",
              runId: RunId.make("run:old-b"),
              layers: ["confirmed_write"],
              rawPaths: ["api/report.md"],
            },
          ],
          recommendedAction: "Coordinate",
        },
      ],
    });

    expect(getActiveOverlaps(snapshot)).toEqual([]);
  });

  it("filters out confirmed_write overlaps from an older completed run on an active thread", () => {
    const snapshot = makeOverlapSnapshot({
      threads: [
        {
          threadId: threadA,
          title: "Active A",
          depth: 0,
          activeRunId: RunId.make("run:new-a"),
          status: "running",
          inFamily: true,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
        {
          threadId: threadB,
          title: "Active B",
          depth: 0,
          activeRunId: RunId.make("run:new-b"),
          status: "running",
          inFamily: true,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
      ],
      overlaps: [
        {
          normalizedPath: "api/report.md",
          kind: "exact",
          severity: "warning",
          participants: [
            {
              threadId: threadA,
              threadTitle: "Active A",
              runId: RunId.make("run:old-a"),
              layers: ["confirmed_write"],
              rawPaths: ["api/report.md"],
            },
            {
              threadId: threadB,
              threadTitle: "Active B",
              runId: RunId.make("run:new-b"),
              layers: ["confirmed_write"],
              rawPaths: ["api/report.md"],
            },
          ],
          recommendedAction: "Coordinate",
        },
      ],
    });

    expect(getActiveOverlaps(snapshot)).toEqual([]);
  });

  it("retains active concurrent overlaps and strips unrelated idle participants", () => {
    const snapshot = makeOverlapSnapshot({
      sharedThreadCount: 3,
      threads: [
        {
          threadId: threadA,
          title: "Active A",
          depth: 1,
          activeRunId: RunId.make("run:new-a"),
          status: "running",
          inFamily: true,
          plannedPaths: [],
          confirmedWritePaths: [
            {
              path: "src/shared.ts",
              normalizedPath: "src/shared.ts",
              oldPath: null,
              oldNormalizedPath: null,
              operation: "update",
              runId: RunId.make("run:new-a"),
              turnItemId: TurnItemId.make("item:fc-a"),
              source: "turn_item",
              updatedAt: IsoDateTime.make("2026-06-20T00:00:01.000Z"),
            },
          ],
          activeReservations: [],
        },
        {
          threadId: threadB,
          title: "Active B",
          depth: 1,
          activeRunId: RunId.make("run:new-b"),
          status: "running",
          inFamily: true,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
        {
          threadId: threadC,
          title: "Idle C",
          depth: 0,
          activeRunId: null,
          status: "idle",
          inFamily: false,
          plannedPaths: [],
          confirmedWritePaths: [],
          activeReservations: [],
        },
      ],
      overlaps: [
        {
          normalizedPath: "src/shared.ts",
          kind: "exact",
          severity: "warning",
          participants: [
            {
              threadId: threadA,
              threadTitle: "Active A",
              runId: RunId.make("run:old-a"),
              layers: ["confirmed_write"],
              rawPaths: ["src/shared.ts"],
            },
            {
              threadId: threadB,
              threadTitle: "Active B",
              runId: RunId.make("run:new-b"),
              layers: ["planned"],
              rawPaths: ["src/shared.ts"],
            },
            {
              threadId: threadC,
              threadTitle: "Idle C",
              runId: RunId.make("run:old-c"),
              layers: ["confirmed_write"],
              rawPaths: ["src/shared.ts"],
            },
          ],
          recommendedAction: "Coordinate",
        },
      ],
    });

    const active = getActiveOverlaps(snapshot);
    expect(active).toHaveLength(1);
    expect(active[0]?.participants.map((p) => p.threadId)).toEqual([threadA, threadB]);
  });
});

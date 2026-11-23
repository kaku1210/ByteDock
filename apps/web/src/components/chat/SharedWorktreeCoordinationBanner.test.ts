import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSharedWorktreeQueryRef } from "./SharedWorktreeCoordinationBanner";

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

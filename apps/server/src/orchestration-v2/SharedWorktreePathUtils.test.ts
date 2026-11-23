import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computePathOverlaps, type OverlapInputEntry } from "./SharedWorktreePathUtils.ts";

function makeEntry(
  overrides: Partial<OverlapInputEntry> &
    Pick<OverlapInputEntry, "threadId" | "normalizedPath"> & {
      readonly canonicalKey?: string;
    },
): OverlapInputEntry {
  const canonicalKey = overrides.canonicalKey ?? overrides.normalizedPath.toLowerCase();
  return {
    threadTitle: overrides.threadTitle ?? `Thread ${overrides.threadId}`,
    runId: overrides.runId ?? null,
    layer: overrides.layer ?? "planned",
    rawPath: overrides.rawPath ?? overrides.normalizedPath,
    canonicalKey,
    ...overrides,
  };
}

describe("computePathOverlaps", () => {
  it("ignores single-thread duplicates and non-overlapping sibling prefixes", () => {
    const threadA = ThreadId.make("thread:a");
    const threadB = ThreadId.make("thread:b");

    const overlaps = computePathOverlaps([
      makeEntry({ threadId: threadA, normalizedPath: "src/dir", layer: "planned" }),
      makeEntry({ threadId: threadA, normalizedPath: "src/dir", layer: "confirmed_write" }),
      makeEntry({ threadId: threadA, normalizedPath: "src/dir/a.ts", layer: "confirmed_write" }),
      makeEntry({ threadId: threadB, normalizedPath: "src/dir2/b.ts", layer: "reserved" }),
    ]);

    expect(overlaps).toEqual([]);
  });

  it("merges transitive directory containment chains across multiple threads and escalates rename_pair", () => {
    const threadA = ThreadId.make("thread:a");
    const threadB = ThreadId.make("thread:b");
    const threadC = ThreadId.make("thread:c");

    const overlaps = computePathOverlaps([
      makeEntry({
        threadId: threadA,
        normalizedPath: "src",
        layer: "planned",
      }),
      makeEntry({
        threadId: threadB,
        normalizedPath: "src/feature",
        layer: "confirmed_write",
        runId: RunId.make("run:b"),
      }),
      makeEntry({
        threadId: threadC,
        normalizedPath: "src/feature/file.ts",
        layer: "reserved",
        runId: RunId.make("run:c"),
        isRenameEndpoint: true,
      }),
    ]);

    expect(overlaps).toHaveLength(1);
    const [overlap] = overlaps;
    expect(overlap?.kind).toBe("rename_pair");
    expect(overlap?.severity).toBe("blocking");
    expect(overlap?.normalizedPath).toBe("src");
    expect(overlap?.participants.map((p) => p.threadId)).toEqual([threadA, threadB, threadC]);
  });

  it("distinguishes exact warning overlaps from directory_containment blocking overlaps", () => {
    const threadA = ThreadId.make("thread:a");
    const threadB = ThreadId.make("thread:b");

    const overlaps = computePathOverlaps([
      makeEntry({ threadId: threadA, normalizedPath: "docs/guide.md", layer: "planned" }),
      makeEntry({ threadId: threadB, normalizedPath: "docs/guide.md", layer: "confirmed_write" }),
      makeEntry({ threadId: threadA, normalizedPath: "apps/web", layer: "reserved" }),
      makeEntry({ threadId: threadB, normalizedPath: "apps/web/src/app.tsx", layer: "planned" }),
    ]);

    expect(overlaps).toHaveLength(2);
    // Blocking overlaps sort before warnings.
    expect(overlaps[0]?.kind).toBe("directory_containment");
    expect(overlaps[0]?.severity).toBe("blocking");
    expect(overlaps[0]?.normalizedPath).toBe("apps/web");
    expect(overlaps[1]?.kind).toBe("exact");
    expect(overlaps[1]?.severity).toBe("warning");
    expect(overlaps[1]?.normalizedPath).toBe("docs/guide.md");
  });

  it("handles thousands of entries in linear time without quadratic blowup", () => {
    const entries: Array<OverlapInputEntry> = [];
    for (let t = 0; t < 10; t += 1) {
      const threadId = ThreadId.make(`thread:perf-${t}`);
      for (let i = 0; i < 200; i += 1) {
        entries.push(
          makeEntry({
            threadId,
            normalizedPath: `packages/pkg-${i}/src/file-${t}.ts`,
            layer: "confirmed_write",
          }),
        );
      }
      // Shared hot file across all threads.
      entries.push(
        makeEntry({
          threadId,
          normalizedPath: "packages/shared/index.ts",
          layer: t === 0 ? "reserved" : "planned",
        }),
      );
    }

    const overlaps = computePathOverlaps(entries);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.normalizedPath).toBe("packages/shared/index.ts");
    expect(overlaps[0]?.participants).toHaveLength(10);
  });
});

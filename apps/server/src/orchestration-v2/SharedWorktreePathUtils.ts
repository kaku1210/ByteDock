import {
  SharedWorktreeCoordinationError,
  type RunId,
  type SharedWorktreeOverlapKind,
  type SharedWorktreeOverlapSeverity,
  type SharedWorktreePathOverlap,
  type SharedWorktreePathOverlapParticipant,
  type SharedWorktreePathOverlapParticipantLayer,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

const isCaseInsensitivePlatform = (platform: NodeJS.Platform): boolean =>
  platform === "win32" || platform === "darwin";

const isGitMetadataSegment = (segment: string): boolean => {
  const base = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return base === ".GIT" || base === "GIT~1";
};

const stripTrailingSlashes = (value: string): string => {
  if (value === "/" || /^[a-zA-Z]:\/$/.test(value)) return value;
  return value.replace(/\/+$/u, "");
};

function toCaseCanonicalKey(posixPath: string, platform: NodeJS.Platform): string {
  const trimmed = stripTrailingSlashes(posixPath);
  return isCaseInsensitivePlatform(platform) ? trimmed.toLowerCase() : trimmed;
}

/** Resolves symlinks via the nearest existing ancestor so alias paths match canonical targets. */
const canonicalizeExistingAncestor = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalizeExistingAncestor(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );

export interface CanonicalCheckout {
  readonly checkoutPath: string;
  readonly checkoutKey: string;
}

export const canonicalizeCheckoutPath = Effect.fn(
  "SharedWorktreePathUtils.canonicalizeCheckoutPath",
)(function* (fileSystem: FileSystem.FileSystem, path: Path.Path, rawCheckoutPath: string) {
  const platform = yield* HostProcess.Platform;
  const resolved = path.resolve(rawCheckoutPath);
  const canonical = yield* canonicalizeExistingAncestor(fileSystem, path, resolved);
  const posix = stripTrailingSlashes(canonical.replaceAll("\\", "/"));
  return {
    checkoutPath: canonical,
    checkoutKey: toCaseCanonicalKey(posix, platform),
  } satisfies CanonicalCheckout;
});

export interface NormalizedCheckoutPath {
  readonly rawPath: string;
  readonly normalizedPath: string;
  readonly canonicalKey: string;
  readonly absolutePath: string;
}

const isWithinRoot = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/** Normalizes a relative or absolute path inside `canonicalCheckoutPath`, resolving symlink aliases. */
export const normalizeCheckoutRelativePath = Effect.fn(
  "SharedWorktreePathUtils.normalizeCheckoutRelativePath",
)(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  canonicalCheckoutPath: string,
  inputPath: string,
) {
  const platform = yield* HostProcess.Platform;
  const trimmed = inputPath.trim();
  if (trimmed.length === 0) {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: "Path cannot be empty.",
    });
  }

  const hostInput = platform === "win32" ? trimmed : trimmed.replaceAll("\\", "/");
  const candidateAbsolute = path.isAbsolute(hostInput)
    ? path.resolve(hostInput)
    : path.resolve(canonicalCheckoutPath, hostInput);

  if (!isWithinRoot(path, canonicalCheckoutPath, candidateAbsolute)) {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: `Path '${trimmed}' escapes the shared checkout '${canonicalCheckoutPath}'.`,
    });
  }

  const namedRelative = path.relative(canonicalCheckoutPath, candidateAbsolute);
  if (namedRelative === "" || namedRelative === ".") {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: "Path must name a file or subdirectory inside the shared checkout.",
    });
  }
  if (namedRelative.split(path.sep).some(isGitMetadataSegment)) {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: `Path '${trimmed}' targets protected Git metadata.`,
    });
  }

  const realCandidate = yield* canonicalizeExistingAncestor(fileSystem, path, candidateAbsolute);
  if (!isWithinRoot(path, canonicalCheckoutPath, realCandidate)) {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: `Path '${trimmed}' resolves outside the shared checkout via symlink.`,
    });
  }

  const realRelative = path.relative(canonicalCheckoutPath, realCandidate);
  if (realRelative === "" || realRelative === ".") {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: `Path '${trimmed}' resolves to the checkout root.`,
    });
  }
  if (realRelative.split(path.sep).some(isGitMetadataSegment)) {
    return yield* new SharedWorktreeCoordinationError({
      reason: "invalid_path",
      detail: `Path '${trimmed}' resolves into protected Git metadata.`,
    });
  }

  const normalizedPath = stripTrailingSlashes(realRelative.replaceAll("\\", "/"));
  return {
    rawPath: trimmed,
    normalizedPath,
    canonicalKey: toCaseCanonicalKey(normalizedPath, platform),
    absolutePath: realCandidate,
  } satisfies NormalizedCheckoutPath;
});

export function classifyCanonicalPathConflict(
  leftKey: string,
  rightKey: string,
): "exact" | "directory_containment" | null {
  if (leftKey === rightKey) return "exact";
  if (leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`)) {
    return "directory_containment";
  }
  return null;
}

export interface OverlapInputEntry {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly runId: RunId | null;
  readonly layer: SharedWorktreePathOverlapParticipantLayer;
  readonly rawPath: string;
  readonly normalizedPath: string;
  readonly canonicalKey: string;
  readonly isRenameEndpoint?: boolean;
}

/** Detects cross-thread exact, directory-containment, and rename-pair path overlaps. */
export function computePathOverlaps(
  entries: ReadonlyArray<OverlapInputEntry>,
): ReadonlyArray<SharedWorktreePathOverlap> {
  if (entries.length < 2) return [];

  // Build undirected conflict graph between distinct threads.
  const adjacency = new Map<number, Set<number>>();
  const pairKinds = new Map<string, SharedWorktreeOverlapKind>();

  const pairKey = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);

  for (let i = 0; i < entries.length; i += 1) {
    const left = entries[i]!;
    for (let j = i + 1; j < entries.length; j += 1) {
      const right = entries[j]!;
      if (left.threadId === right.threadId) continue;
      const baseConflict = classifyCanonicalPathConflict(left.canonicalKey, right.canonicalKey);
      if (baseConflict === null) continue;
      const kind: SharedWorktreeOverlapKind =
        left.isRenameEndpoint === true || right.isRenameEndpoint === true
          ? "rename_pair"
          : baseConflict;
      let leftSet = adjacency.get(i);
      if (!leftSet) {
        leftSet = new Set();
        adjacency.set(i, leftSet);
      }
      leftSet.add(j);
      let rightSet = adjacency.get(j);
      if (!rightSet) {
        rightSet = new Set();
        adjacency.set(j, rightSet);
      }
      rightSet.add(i);
      pairKinds.set(pairKey(i, j), kind);
    }
  }

  // Group connected components of conflicting entries so overlapping siblings appear once.
  const visited = new Set<number>();
  const overlaps: Array<SharedWorktreePathOverlap> = [];

  for (let start = 0; start < entries.length; start += 1) {
    if (visited.has(start) || !adjacency.has(start)) continue;
    const queue = [start];
    const component: Array<number> = [];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    const componentEntries = component.map((idx) => entries[idx]!);
    const distinctThreads = new Set(componentEntries.map((item) => item.threadId));
    if (distinctThreads.size < 2) continue;

    let kind: SharedWorktreeOverlapKind = "exact";
    for (let a = 0; a < component.length; a += 1) {
      for (let b = a + 1; b < component.length; b += 1) {
        const edgeKind = pairKinds.get(pairKey(component[a]!, component[b]!));
        if (edgeKind === "rename_pair") {
          kind = "rename_pair";
          break;
        }
        if (edgeKind === "directory_containment") {
          kind = "directory_containment";
        }
      }
      if (kind === "rename_pair") break;
    }

    const byThread = new Map<
      ThreadId,
      {
        readonly threadId: ThreadId;
        readonly threadTitle: string;
        runId: RunId | null;
        readonly layers: Set<SharedWorktreePathOverlapParticipantLayer>;
        readonly rawPaths: Set<string>;
      }
    >();

    for (const item of componentEntries) {
      let existing = byThread.get(item.threadId);
      if (!existing) {
        existing = {
          threadId: item.threadId,
          threadTitle: item.threadTitle,
          runId: item.runId,
          layers: new Set(),
          rawPaths: new Set(),
        };
        byThread.set(item.threadId, existing);
      }
      if (existing.runId === null && item.runId !== null) {
        existing.runId = item.runId;
      }
      existing.layers.add(item.layer);
      existing.rawPaths.add(item.normalizedPath);
    }

    const participants: Array<SharedWorktreePathOverlapParticipant> = [...byThread.values()]
      .sort((a, b) => a.threadId.localeCompare(b.threadId))
      .map((participant) => ({
        threadId: participant.threadId,
        threadTitle: participant.threadTitle,
        runId: participant.runId,
        layers: [...participant.layers].sort(),
        rawPaths: [...participant.rawPaths].sort(),
      }));

    const hasReservation = participants.some((p) => p.layers.includes("reserved"));
    const severity: SharedWorktreeOverlapSeverity = hasReservation ? "blocking" : "warning";

    // Shortest normalized path represents the common/parent scope cleanly.
    const representativePath = [...componentEntries]
      .map((item) => item.normalizedPath)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;

    const recommendedAction =
      severity === "blocking"
        ? "Wait for the active write reservation to release, then re-read the latest file contents before writing."
        : kind === "rename_pair"
          ? "Coordinate rename source and destination paths via write reservations before editing either endpoint."
          : kind === "directory_containment"
            ? "Reserve overlapping directory/file scopes or enable checkout write serialization to avoid conflicting edits."
            : "Coordinate via t3_worktree_coordinate write reservations or enable checkout write serialization so the second writer reads the latest version.";

    overlaps.push({
      normalizedPath: representativePath,
      kind,
      severity,
      participants,
      recommendedAction,
    });
  }

  return overlaps.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1) ||
      a.normalizedPath.localeCompare(b.normalizedPath),
  );
}

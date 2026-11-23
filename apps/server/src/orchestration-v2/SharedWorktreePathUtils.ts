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

/** Untraced checkout canonicalizer for cached hot paths inside snapshot reads. */
export const canonicalizeCheckoutPathRaw = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  rawCheckoutPath: string,
  platform: NodeJS.Platform,
) {
  const resolved = path.resolve(rawCheckoutPath);
  const canonical = yield* canonicalizeExistingAncestor(fileSystem, path, resolved);
  const posix = stripTrailingSlashes(canonical.replaceAll("\\", "/"));
  return {
    checkoutPath: canonical,
    checkoutKey: toCaseCanonicalKey(posix, platform),
  } satisfies CanonicalCheckout;
});

export const canonicalizeCheckoutPath = Effect.fn(
  "SharedWorktreePathUtils.canonicalizeCheckoutPath",
)(function* (fileSystem: FileSystem.FileSystem, path: Path.Path, rawCheckoutPath: string) {
  const platform = yield* HostProcess.Platform;
  return yield* canonicalizeCheckoutPathRaw(fileSystem, path, rawCheckoutPath, platform);
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

/** Untraced core path normalizer for high-volume batch snapshot reads. */
export const normalizeCheckoutRelativePathRaw = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  canonicalCheckoutPath: string,
  inputPath: string,
  platform: NodeJS.Platform,
) {
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
  return yield* normalizeCheckoutRelativePathRaw(
    fileSystem,
    path,
    canonicalCheckoutPath,
    inputPath,
    platform,
  );
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

interface AggregatedOverlapNode {
  readonly index: number;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly canonicalKey: string;
  runId: RunId | null;
  readonly layers: Set<SharedWorktreePathOverlapParticipantLayer>;
  readonly normalizedPaths: Set<string>;
  hasRenameEndpoint: boolean;
}

const OVERLAP_KIND_PRIORITY: Record<SharedWorktreeOverlapKind, number> = {
  exact: 0,
  directory_containment: 1,
  rename_pair: 2,
};

function mergeOverlapKind(
  current: SharedWorktreeOverlapKind,
  next: SharedWorktreeOverlapKind,
): SharedWorktreeOverlapKind {
  return OVERLAP_KIND_PRIORITY[next] > OVERLAP_KIND_PRIORITY[current] ? next : current;
}

/** Detects cross-thread exact, directory-containment, and rename-pair path overlaps. */
export function computePathOverlaps(
  entries: ReadonlyArray<OverlapInputEntry>,
): ReadonlyArray<SharedWorktreePathOverlap> {
  if (entries.length < 2) return [];

  // Collapse duplicate entries per (threadId, canonicalKey) without losing layer/path/rename info.
  const nodes: Array<AggregatedOverlapNode> = [];
  const nodeByThreadKey = new Map<string, AggregatedOverlapNode>();
  const bucketsByCanonicalKey = new Map<string, Array<AggregatedOverlapNode>>();

  for (const entry of entries) {
    const threadKey = `${entry.threadId}\0${entry.canonicalKey}`;
    let node = nodeByThreadKey.get(threadKey);
    if (node === undefined) {
      node = {
        index: nodes.length,
        threadId: entry.threadId,
        threadTitle: entry.threadTitle,
        canonicalKey: entry.canonicalKey,
        runId: entry.runId,
        layers: new Set([entry.layer]),
        normalizedPaths: new Set([entry.normalizedPath]),
        hasRenameEndpoint: entry.isRenameEndpoint === true,
      };
      nodes.push(node);
      nodeByThreadKey.set(threadKey, node);

      let bucket = bucketsByCanonicalKey.get(entry.canonicalKey);
      if (bucket === undefined) {
        bucket = [];
        bucketsByCanonicalKey.set(entry.canonicalKey, bucket);
      }
      bucket.push(node);
    } else {
      if (node.runId === null && entry.runId !== null) {
        node.runId = entry.runId;
      }
      node.layers.add(entry.layer);
      node.normalizedPaths.add(entry.normalizedPath);
      if (entry.isRenameEndpoint === true) {
        node.hasRenameEndpoint = true;
      }
    }
  }

  if (nodes.length < 2) return [];

  // Disjoint-set union over aggregated nodes to build cross-thread conflict components in linear time.
  const parent = new Int32Array(nodes.length);
  const componentKind: Array<SharedWorktreeOverlapKind> = new Array(nodes.length);
  const hasConflictEdge = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i += 1) {
    parent[i] = i;
    componentKind[i] = "exact";
  }

  const find = (idx: number): number => {
    let root = idx;
    while (parent[root]! !== root) {
      root = parent[root]!;
    }
    let current = idx;
    while (parent[current]! !== root) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };

  const union = (a: number, b: number, edgeKind: SharedWorktreeOverlapKind): void => {
    const rootA = find(a);
    const rootB = find(b);
    const mergedKind = mergeOverlapKind(
      mergeOverlapKind(componentKind[rootA]!, componentKind[rootB]!),
      edgeKind,
    );
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
    componentKind[rootA] = mergedKind;
  };

  // 1. Exact path overlaps: every bucket with >= 2 distinct threads conflicts pairwise.
  for (const bucket of bucketsByCanonicalKey.values()) {
    if (bucket.length < 2) continue;
    const first = bucket[0]!;
    hasConflictEdge[first.index] = 1;
    let bucketHasRename = first.hasRenameEndpoint;
    for (let i = 1; i < bucket.length; i += 1) {
      const node = bucket[i]!;
      hasConflictEdge[node.index] = 1;
      if (node.hasRenameEndpoint) bucketHasRename = true;
      union(first.index, node.index, bucketHasRename ? "rename_pair" : "exact");
    }
    if (bucketHasRename) {
      const root = find(first.index);
      componentKind[root] = "rename_pair";
    }
  }

  // 2. Directory containment overlaps: check strict ancestor prefixes in O(uniqueKeys * pathDepth).
  for (const [canonicalKey, childBucket] of bucketsByCanonicalKey.entries()) {
    let slashIdx = canonicalKey.lastIndexOf("/");
    while (slashIdx > 0) {
      const ancestorKey = canonicalKey.slice(0, slashIdx);
      const parentBucket = bucketsByCanonicalKey.get(ancestorKey);
      if (parentBucket !== undefined) {
        const sameSingleThread =
          childBucket.length === 1 &&
          parentBucket.length === 1 &&
          childBucket[0]!.threadId === parentBucket[0]!.threadId;
        if (!sameSingleThread) {
          let edgeKind: SharedWorktreeOverlapKind = "directory_containment";
          for (const node of childBucket) {
            hasConflictEdge[node.index] = 1;
            if (node.hasRenameEndpoint) edgeKind = "rename_pair";
          }
          for (const node of parentBucket) {
            hasConflictEdge[node.index] = 1;
            if (node.hasRenameEndpoint) edgeKind = "rename_pair";
          }
          union(childBucket[0]!.index, parentBucket[0]!.index, edgeKind);
        }
      }
      slashIdx = canonicalKey.lastIndexOf("/", slashIdx - 1);
    }
  }

  // Group conflicting nodes by connected component root.
  const components = new Map<number, Array<AggregatedOverlapNode>>();
  for (const node of nodes) {
    if (hasConflictEdge[node.index] === 0) continue;
    const root = find(node.index);
    let group = components.get(root);
    if (group === undefined) {
      group = [];
      components.set(root, group);
    }
    group.push(node);
  }

  const overlaps: Array<SharedWorktreePathOverlap> = [];

  for (const [root, componentNodes] of components.entries()) {
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

    let representativePath: string | null = null;

    for (const node of componentNodes) {
      let existing = byThread.get(node.threadId);
      if (existing === undefined) {
        existing = {
          threadId: node.threadId,
          threadTitle: node.threadTitle,
          runId: node.runId,
          layers: new Set(),
          rawPaths: new Set(),
        };
        byThread.set(node.threadId, existing);
      }
      if (existing.runId === null && node.runId !== null) {
        existing.runId = node.runId;
      }
      for (const layer of node.layers) {
        existing.layers.add(layer);
      }
      for (const normalizedPath of node.normalizedPaths) {
        existing.rawPaths.add(normalizedPath);
        if (
          representativePath === null ||
          normalizedPath.length < representativePath.length ||
          (normalizedPath.length === representativePath.length &&
            normalizedPath.localeCompare(representativePath) < 0)
        ) {
          representativePath = normalizedPath;
        }
      }
    }

    if (byThread.size < 2 || representativePath === null) continue;

    const kind = componentKind[root] ?? "exact";
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

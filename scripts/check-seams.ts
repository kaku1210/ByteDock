// @effect-diagnostics nodeBuiltinImport:off -- Standalone CLI seam ledger validator.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export type SeamMode = "strict" | "diverged";
export type SeamReview = "auto" | "manual";

export interface SeamLedgerEntry {
  readonly id: string;
  readonly file: string;
  readonly anchor: "block" | "import" | "both";
  readonly tagCount: number;
  readonly mode?: SeamMode | undefined;
  readonly driftThresholdPct: number;
  readonly review: SeamReview;
  readonly cutOrder: string;
  readonly note?: string | undefined;
}

export interface SeamLedger {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly seams: ReadonlyArray<SeamLedgerEntry>;
}

export interface DiffLineChange {
  readonly kind: "add" | "del";
  readonly newLine: number | null;
  readonly oldLine: number | null;
  readonly text: string;
}

export interface ParsedFileDiff {
  readonly path: string;
  readonly changes: ReadonlyArray<DiffLineChange>;
}

export interface SeamViolation {
  readonly file: string;
  readonly line: number | null;
  readonly rule: "R1_UNTAGGED_ADDITION" | "R1_UNKNOWN_SEAM_ID" | "R2_UNTAGGED_UPSTREAM_EDIT";
  readonly message: string;
  readonly text: string;
}

export interface SeamNotice {
  readonly file: string;
  readonly kind: "diverged" | "idea-sync" | "manual-review";
  readonly message: string;
}

export interface SeamCheckResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<SeamViolation>;
  readonly notices: ReadonlyArray<SeamNotice>;
}

const SEAM_START_RE = /(?:\/\/|\/\*)\s*bytedock-seam:([a-z0-9-]+)\b/;
const SEAM_END_RE = /(?:\/\/|\/\*)\s*end-bytedock-seam:([a-z0-9-]+)\b/;
const SEAM_IMPORT_RE = /\/\/\s*bytedock-seam-import:([a-z0-9-]+)\b/;
const IDEA_SYNC_RE = /(?:\/\/|\/\*)\s*bytedock-idea-sync:([A-Za-z0-9._#-]+)\b/;
const IDEA_SYNC_END_RE = /(?:\/\/|\/\*)\s*end-bytedock-idea-sync:([A-Za-z0-9._#-]+)\b/;

/** Expands a single brace-group path like `dir/{a.ts,b/c.ts}` into concrete repo-relative POSIX paths. */
export function expandLedgerPaths(pattern: string): ReadonlyArray<string> {
  const normalized = pattern.replace(/\\/g, "/");
  const match = /^(.*)\{([^}]+)\}(.*)$/.exec(normalized);
  if (!match) return [normalized];
  const prefix = match[1] ?? "";
  const body = match[2] ?? "";
  const suffix = match[3] ?? "";
  return body.split(",").map((part) => `${prefix}${part.trim()}${suffix}`);
}

export function loadSeamLedger(ledgerPath: string): SeamLedger {
  return JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")) as SeamLedger;
}

/** Parses standard `git diff -U0` / unified diff text into per-file changed lines. */
export function parseUnifiedDiff(diffText: string): ReadonlyArray<ParsedFileDiff> {
  const files: Array<{ path: string; changes: Array<DiffLineChange> }> = [];
  let current: { path: string; changes: Array<DiffLineChange> } | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
      if (match?.[2]) {
        current = { path: match[2].replace(/\\/g, "/"), changes: [] };
        files.push(current);
      }
      continue;
    }
    if (rawLine.startsWith("+++ b/")) {
      const nextPath = rawLine.slice("+++ b/".length).trim().replace(/\\/g, "/");
      if (!current) {
        current = { path: nextPath, changes: [] };
        files.push(current);
      } else {
        current.path = nextPath;
      }
      continue;
    }
    if (
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("new file")
    ) {
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("+")) {
      current.changes.push({
        kind: "add",
        newLine,
        oldLine: null,
        text: rawLine.slice(1),
      });
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      current.changes.push({
        kind: "del",
        newLine: null,
        oldLine,
        text: rawLine.slice(1),
      });
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return files;
}

interface TaggedRanges {
  readonly seamRanges: ReadonlyArray<{
    readonly id: string;
    readonly start: number;
    readonly end: number;
  }>;
  readonly seamImportLines: ReadonlyMap<number, string>;
  readonly ideaSyncLines: ReadonlySet<number>;
  readonly ideaSyncRanges: ReadonlyArray<{
    readonly ref: string;
    readonly start: number;
    readonly end: number;
  }>;
}

function scanTaggedRanges(lines: ReadonlyArray<string>): TaggedRanges {
  const seamRanges: Array<{ readonly id: string; readonly start: number; readonly end: number }> =
    [];
  const seamImportLines = new Map<number, string>();
  const ideaSyncLines = new Set<number>();
  const ideaSyncRanges: Array<{
    readonly ref: string;
    readonly start: number;
    readonly end: number;
  }> = [];

  let openSeam: { readonly id: string; readonly start: number } | null = null;
  let openIdea: { readonly ref: string; readonly start: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const text = lines[i] ?? "";

    const imp = SEAM_IMPORT_RE.exec(text);
    if (imp?.[1]) {
      seamImportLines.set(lineNo, imp[1]);
      // When vp fmt / Prettier wraps a long tagged import across lines, attach the tag to the whole statement.
      if (!/^\s*import\b/.test(text)) {
        for (let k = i - 1; k >= 0; k -= 1) {
          const prevText = lines[k] ?? "";
          seamImportLines.set(k + 1, imp[1]);
          if (/^\s*import\b/.test(prevText)) break;
        }
      }
    }

    const start = SEAM_START_RE.exec(text);
    if (start?.[1]) {
      openSeam = { id: start[1], start: lineNo };
    }
    const end = SEAM_END_RE.exec(text);
    if (end?.[1] && openSeam && openSeam.id === end[1]) {
      seamRanges.push({ id: openSeam.id, start: openSeam.start, end: lineNo });
      openSeam = null;
    }

    const ideaStart = IDEA_SYNC_RE.exec(text);
    if (ideaStart?.[1]) {
      ideaSyncLines.add(lineNo);
      openIdea = { ref: ideaStart[1], start: lineNo };
    }
    const ideaEnd = IDEA_SYNC_END_RE.exec(text);
    if (ideaEnd?.[1] && openIdea) {
      ideaSyncRanges.push({ ref: openIdea.ref, start: openIdea.start, end: lineNo });
      openIdea = null;
    }
  }

  return { seamRanges, seamImportLines, ideaSyncLines, ideaSyncRanges };
}

function isInsideSeamRange(ranges: TaggedRanges, lineNo: number): string | undefined {
  for (const r of ranges.seamRanges) {
    if (lineNo >= r.start && lineNo <= r.end) return r.id;
  }
  return undefined;
}

function isBlankAdjacentToSeam(ranges: TaggedRanges, lineNo: number): string | undefined {
  for (const r of ranges.seamRanges) {
    if (lineNo === r.start - 1 || lineNo === r.end + 1) return r.id;
  }
  const prevImp = ranges.seamImportLines.get(lineNo - 1);
  if (prevImp) return prevImp;
  const nextImp = ranges.seamImportLines.get(lineNo + 1);
  if (nextImp) return nextImp;
  return undefined;
}

function isCoveredByIdeaSync(ranges: TaggedRanges, lineNo: number, text: string): boolean {
  if (IDEA_SYNC_RE.test(text) || IDEA_SYNC_END_RE.test(text)) return true;
  if (ranges.ideaSyncLines.has(lineNo)) return true;
  for (const r of ranges.ideaSyncRanges) {
    if (lineNo >= r.start && lineNo <= r.end) return true;
  }
  return false;
}

/**
 * Validates diffs against seam-ledger.json: R1 tagged additions, R2 upstream-line protection
 * (allowing explicit idea-sync or diverged files), and R3 manual-review notices.
 */
export function checkSeams(
  diffs: ReadonlyArray<ParsedFileDiff>,
  ledger: SeamLedger,
  options?: {
    readonly readFileLines?: (repoRelPath: string) => ReadonlyArray<string> | undefined;
    readonly readOldFileLines?: (repoRelPath: string) => ReadonlyArray<string> | undefined;
  },
): SeamCheckResult {
  const fileIndex = new Map<string, Array<SeamLedgerEntry>>();
  for (const entry of ledger.seams) {
    for (const expanded of expandLedgerPaths(entry.file)) {
      const bucket = fileIndex.get(expanded) ?? [];
      bucket.push(entry);
      fileIndex.set(expanded, bucket);
    }
  }

  const violations: Array<SeamViolation> = [];
  const notices: Array<SeamNotice> = [];

  for (const diff of diffs) {
    const entries = fileIndex.get(diff.path);
    if (!entries || entries.length === 0) continue; // Outside protected seam ledger -> allowed.

    const allowedIds = new Set(entries.map((e) => e.id));
    const isDiverged = entries.some((e) => e.mode === "diverged");
    const requiresManual = entries.some((e) => e.review === "manual");

    if (requiresManual) {
      notices.push({
        file: diff.path,
        kind: "manual-review",
        message: `Manual review required for high-sensitivity seam file (${[...allowedIds].join(", ")}).`,
      });
    }

    if (isDiverged) {
      notices.push({
        file: diff.path,
        kind: "diverged",
        message: `File is marked mode:"diverged" in seam-ledger.json; bypassing strict line guard with drift notice.`,
      });
      continue;
    }

    const fullLines = options?.readFileLines?.(diff.path);
    const ranges = fullLines ? scanTaggedRanges(fullLines) : undefined;
    const oldLines = options?.readOldFileLines?.(diff.path);
    const oldRanges = oldLines ? scanTaggedRanges(oldLines) : ranges;

    // Track in-diff seam block & idea-sync state as fallback when full file lines are not supplied (pure diff fixtures).
    let diffOpenSeamId: string | null = null;
    let diffOpenIdeaSync = false;
    let emittedIdeaNotice = false;

    // Collect line numbers covered by idea-sync inside the diff so paired delete+add replacements pass cleanly.
    const diffHasIdeaSync = diff.changes.some(
      (c) => IDEA_SYNC_RE.test(c.text) || IDEA_SYNC_END_RE.test(c.text),
    );

    // Pre-scan deletions that fall strictly inside an existing seam block (e.g. prettier reformatting inside seam block).
    const addedLineNumbers = new Set(
      diff.changes
        .filter((c) => c.kind === "add" && c.newLine !== null)
        .map((c) => c.newLine as number),
    );

    for (const change of diff.changes) {
      if (change.kind === "add") {
        const lineNo = change.newLine ?? 0;

        // Check in-diff block tags first.
        const startTag = SEAM_START_RE.exec(change.text)?.[1];
        const endTag = SEAM_END_RE.exec(change.text)?.[1];
        const importTag = SEAM_IMPORT_RE.exec(change.text)?.[1];
        if (startTag) diffOpenSeamId = startTag;
        if (IDEA_SYNC_RE.test(change.text)) diffOpenIdeaSync = true;

        const rangeSeamId = ranges ? isInsideSeamRange(ranges, lineNo) : undefined;
        const rangeImportId = ranges?.seamImportLines.get(lineNo);
        const adjacentBlankSeamId =
          change.text.trim() === ""
            ? ((ranges ? isBlankAdjacentToSeam(ranges, lineNo) : undefined) ??
              diff.changes
                .filter(
                  (peer) =>
                    peer.kind === "add" &&
                    peer.newLine !== null &&
                    Math.abs(peer.newLine - lineNo) === 1,
                )
                .map(
                  (peer) =>
                    SEAM_START_RE.exec(peer.text)?.[1] ??
                    SEAM_END_RE.exec(peer.text)?.[1] ??
                    SEAM_IMPORT_RE.exec(peer.text)?.[1],
                )
                .find((id) => id !== undefined))
            : undefined;
        const resolvedSeamId =
          rangeSeamId ?? rangeImportId ?? importTag ?? diffOpenSeamId ?? adjacentBlankSeamId;

        const isIdeaSynced =
          diffOpenIdeaSync ||
          (ranges
            ? isCoveredByIdeaSync(ranges, lineNo, change.text)
            : IDEA_SYNC_RE.test(change.text));

        if (endTag && diffOpenSeamId === endTag) {
          diffOpenSeamId = null;
        }
        if (IDEA_SYNC_END_RE.test(change.text)) {
          diffOpenIdeaSync = false;
        }

        if (isIdeaSynced) {
          if (!emittedIdeaNotice) {
            emittedIdeaNotice = true;
            notices.push({
              file: diff.path,
              kind: "idea-sync",
              message: `Explicit // bytedock-idea-sync marker detected; bypassing strict upstream line guard (record in upstream-ledger.jsonl & cover with regression tests).`,
            });
          }
          continue;
        }

        if (!resolvedSeamId) {
          violations.push({
            file: diff.path,
            line: change.newLine,
            rule: "R1_UNTAGGED_ADDITION",
            message: `Added line is outside any // bytedock-seam:<id> block and lacks // bytedock-seam-import:<id> (or // bytedock-idea-sync:<ref>).`,
            text: change.text,
          });
          continue;
        }

        if (!allowedIds.has(resolvedSeamId)) {
          violations.push({
            file: diff.path,
            line: change.newLine,
            rule: "R1_UNKNOWN_SEAM_ID",
            message: `Seam tag "${resolvedSeamId}" is not registered for ${diff.path} in seam-ledger.json (allowed: ${[...allowedIds].join(", ")}).`,
            text: change.text,
          });
        }
      } else {
        // Deletion / modification of an existing line.
        // Allowed if:
        // 1. Inside an explicit idea-sync replacement block, OR
        // 2. Formatting/editing lines strictly inside an existing bytedock-seam block or tagged seam import.
        const isTaggedSeamLine =
          SEAM_START_RE.test(change.text) ||
          SEAM_END_RE.test(change.text) ||
          SEAM_IMPORT_RE.test(change.text);
        const isReplacementInsideExistingSeam =
          oldRanges !== undefined &&
          change.oldLine !== null &&
          (isInsideSeamRange(oldRanges, change.oldLine) !== undefined ||
            oldRanges.seamImportLines.has(change.oldLine) ||
            (ranges !== undefined &&
              addedLineNumbers.has(change.oldLine) &&
              isInsideSeamRange(ranges, change.oldLine) !== undefined));
        const isIdeaSyncedDel =
          diffHasIdeaSync ||
          (oldRanges !== undefined &&
            change.oldLine !== null &&
            isCoveredByIdeaSync(oldRanges, change.oldLine, change.text));

        if (isTaggedSeamLine || isReplacementInsideExistingSeam || isIdeaSyncedDel) {
          if (isIdeaSyncedDel && !emittedIdeaNotice) {
            emittedIdeaNotice = true;
            notices.push({
              file: diff.path,
              kind: "idea-sync",
              message: `Explicit // bytedock-idea-sync marker detected; bypassing strict upstream line guard (record in upstream-ledger.jsonl & cover with regression tests).`,
            });
          }
          continue;
        }

        violations.push({
          file: diff.path,
          line: change.oldLine,
          rule: "R2_UNTAGGED_UPSTREAM_EDIT",
          message: `Modified or deleted an untagged upstream line in strict seam file ${diff.path}. Keep edits inside // bytedock-seam:<id> or declare // bytedock-idea-sync:<ref> / mode:"diverged".`,
          text: change.text,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    notices,
  };
}

function runCli(): void {
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const ledgerPath = NodePath.join(repoRoot, "seam-ledger.json");
  const ledger = loadSeamLedger(ledgerPath);

  const baseArgIdx = process.argv.indexOf("--base");
  const baseRef = baseArgIdx >= 0 ? process.argv[baseArgIdx + 1] : undefined;

  let diffTarget = "HEAD";
  if (baseRef) {
    diffTarget = baseRef;
  } else {
    for (const candidate of ["main", "develop"]) {
      const mergeBase = NodeChildProcess.spawnSync("git", ["merge-base", "HEAD", candidate], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
        diffTarget = mergeBase.stdout.trim();
        break;
      }
    }
  }

  const diffRun = NodeChildProcess.spawnSync("git", ["diff", "-U0", diffTarget], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (diffRun.status !== 0) {
    console.error(`[check:seams] git diff failed: ${diffRun.stderr}`);
    process.exit(1);
  }

  const diffs = parseUnifiedDiff(diffRun.stdout);
  const result = checkSeams(diffs, ledger, {
    readFileLines: (relPath) => {
      const abs = NodePath.join(repoRoot, relPath);
      if (!NodeFS.existsSync(abs)) return undefined;
      return NodeFS.readFileSync(abs, "utf8").split(/\r?\n/);
    },
    readOldFileLines: (relPath) => {
      const shown = NodeChildProcess.spawnSync("git", ["show", `${diffTarget}:${relPath}`], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      if (shown.status !== 0) return undefined;
      return shown.stdout.split(/\r?\n/);
    },
  });

  for (const notice of result.notices) {
    console.log(`[check:seams] NOTICE (${notice.kind}) ${notice.file}: ${notice.message}`);
  }

  if (!result.ok) {
    console.error(`[check:seams] FAILED with ${result.violations.length} violation(s):`);
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line ?? "?"} [${v.rule}] ${v.message}`);
      console.error(`      ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    `[check:seams] PASS (${diffs.length} changed files checked against ${ledger.seams.length} ledger seams; base=${diffTarget.slice(0, 12)}).`,
  );
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runCli();
}

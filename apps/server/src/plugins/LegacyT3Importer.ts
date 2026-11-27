// @effect-diagnostics nodeBuiltinImport:off -- Read-only legacy importer inspects filesystem paths and snapshots SQLite via node:sqlite.
// @effect-diagnostics globalDate:off -- Import receipts stamp wall-clock ISO timestamps.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { resolveLegacyReadOnlyImportCandidates } from "@t3tools/shared/bytedockPaths";

export type LegacySourceBrand = "t3-plus" | "t3" | "custom";

export type LegacyImportCategory =
  | "settings"
  | "keybindings"
  | "themes"
  | "stateDb"
  | "attachments"
  | "usageDb"
  | "secrets";

const LEGACY_IMPORT_DENYLIST: ReadonlySet<string> = new Set([
  "clerk",
  "anonymous-id",
  "usage-host-id",
  "server-runtime.json",
  "server-owner.sqlite",
  "server-owner.sqlite-journal",
  "logs",
  "antigravity-tmp",
  "caches",
  "backups",
]);

export interface LegacyCategorySummary {
  readonly category: LegacyImportCategory;
  readonly available: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly detail: string;
}

export interface LegacySourceScanResult {
  readonly brand: LegacySourceBrand;
  readonly baseDir: string;
  readonly userdataDir: string;
  readonly exists: boolean;
  readonly schemaCompatible: boolean;
  readonly projectCount: number | null;
  readonly threadCount: number | null;
  readonly categories: ReadonlyArray<LegacyCategorySummary>;
  readonly excludedTelemetryItems: ReadonlyArray<string>;
}

export interface LegacyImportOptions {
  readonly sourceBaseDir: string;
  readonly sourceBrand?: LegacySourceBrand | undefined;
  readonly targetStateDir: string;
  readonly categories: ReadonlyArray<LegacyImportCategory>;
  readonly overwrite?: boolean | undefined;
  readonly deferLockedStateDb?: boolean | undefined;
}

export interface LegacyImportedCategoryOutcome {
  readonly category: LegacyImportCategory;
  readonly status: "imported" | "staged-for-restart" | "skipped-exists" | "skipped-missing";
  readonly filesCopied: number;
  readonly bytesCopied: number;
  readonly targetPath?: string | undefined;
}

export interface LegacyImportReport {
  readonly sourceBrand: LegacySourceBrand;
  readonly sourceBaseDir: string;
  readonly sourceUserdataDir: string;
  readonly targetStateDir: string;
  readonly importedAt: string;
  readonly sourceReadOnlyVerified: true;
  readonly restartRequired: boolean;
  readonly outcomes: ReadonlyArray<LegacyImportedCategoryOutcome>;
}

const SETTINGS_FILES = ["settings.json", "client-settings.json", "desktop-settings.json"] as const;
const PENDING_STATE_DB_FILENAME = "statev2.sqlite.pending-import";

function resolveUserdataDir(baseDir: string): string {
  const nested = NodePath.join(baseDir, "userdata");
  if (NodeFS.existsSync(nested) && NodeFS.statSync(nested).isDirectory()) {
    return nested;
  }
  return baseDir;
}

function measurePathStats(targetPath: string): {
  readonly fileCount: number;
  readonly totalBytes: number;
} {
  if (!NodeFS.existsSync(targetPath)) return { fileCount: 0, totalBytes: 0 };
  const stat = NodeFS.statSync(targetPath);
  if (stat.isFile()) {
    return { fileCount: 1, totalBytes: stat.size };
  }
  if (!stat.isDirectory()) return { fileCount: 0, totalBytes: 0 };

  let fileCount = 0;
  let totalBytes = 0;
  const stack: Array<string> = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (LEGACY_IMPORT_DENYLIST.has(entry.name)) continue;
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          totalBytes += NodeFS.statSync(full).size;
        } catch {
          // Ignore unreadable transient files during read-only scan.
        }
      }
    }
  }
  return { fileCount, totalBytes };
}

function inspectSqliteCountsReadOnly(dbPath: string): {
  readonly compatible: boolean;
  readonly projectCount: number | null;
  readonly threadCount: number | null;
} {
  if (!NodeFS.existsSync(dbPath)) {
    return { compatible: false, projectCount: null, threadCount: null };
  }
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as ReadonlyArray<{ readonly name: string }>;
    const tableSet = new Set(tables.map((t) => t.name));

    const projectTable = tableSet.has("projection_projects")
      ? "projection_projects"
      : tableSet.has("projects")
        ? "projects"
        : null;
    const threadTable = tableSet.has("orchestration_v2_projection_threads")
      ? "orchestration_v2_projection_threads"
      : tableSet.has("projection_threads")
        ? "projection_threads"
        : tableSet.has("threads")
          ? "threads"
          : null;

    const projectCount = projectTable
      ? Number(
          (
            db.prepare(`SELECT COUNT(*) AS cnt FROM ${projectTable}`).get() as
              | { readonly cnt: number }
              | undefined
          )?.cnt ?? 0,
        )
      : null;
    const threadCount = threadTable
      ? Number(
          (
            db.prepare(`SELECT COUNT(*) AS cnt FROM ${threadTable}`).get() as
              | { readonly cnt: number }
              | undefined
          )?.cnt ?? 0,
        )
      : null;

    return {
      compatible: tableSet.size > 0,
      projectCount,
      threadCount,
    };
  } catch {
    return { compatible: false, projectCount: null, threadCount: null };
  } finally {
    db?.close();
  }
}

/**
 * Scans a T3 Code (`~/.t3`) or T3 Code Plus (`~/.t3-plus`) directory strictly read-only.
 * Both share the identical `<root>/userdata/` layout and SQLite v2 schema.
 */
export function scanLegacySourceReadOnly(input: {
  readonly baseDir: string;
  readonly brand?: LegacySourceBrand | undefined;
}): LegacySourceScanResult {
  const brand: LegacySourceBrand =
    input.brand ??
    (input.baseDir.toLowerCase().includes(".t3-plus")
      ? "t3-plus"
      : input.baseDir.toLowerCase().includes(".t3")
        ? "t3"
        : "custom");

  if (!NodeFS.existsSync(input.baseDir)) {
    return {
      brand,
      baseDir: input.baseDir,
      userdataDir: NodePath.join(input.baseDir, "userdata"),
      exists: false,
      schemaCompatible: false,
      projectCount: null,
      threadCount: null,
      categories: [],
      excludedTelemetryItems: [],
    };
  }

  const userdataDir = resolveUserdataDir(input.baseDir);
  const excludedTelemetryItems: Array<string> = [];
  for (const name of LEGACY_IMPORT_DENYLIST) {
    if (NodeFS.existsSync(NodePath.join(userdataDir, name))) {
      excludedTelemetryItems.push(name);
    }
  }

  let settingsFiles = 0;
  let settingsBytes = 0;
  for (const file of SETTINGS_FILES) {
    const stat = measurePathStats(NodePath.join(userdataDir, file));
    settingsFiles += stat.fileCount;
    settingsBytes += stat.totalBytes;
  }

  const keybindingsStat = measurePathStats(NodePath.join(userdataDir, "keybindings.json"));
  const themesStat = measurePathStats(NodePath.join(userdataDir, "themes"));
  const stateDbPath = NodePath.join(userdataDir, "statev2.sqlite");
  const stateDbStat = measurePathStats(stateDbPath);
  const sqliteMeta = inspectSqliteCountsReadOnly(stateDbPath);
  const attachmentsStat = measurePathStats(NodePath.join(userdataDir, "attachments"));
  const usageDbStat = measurePathStats(NodePath.join(userdataDir, "usage-estimates.sqlite"));
  const secretsStat = measurePathStats(NodePath.join(userdataDir, "secrets"));

  const categories: ReadonlyArray<LegacyCategorySummary> = [
    {
      category: "settings",
      available: settingsFiles > 0,
      fileCount: settingsFiles,
      totalBytes: settingsBytes,
      detail: "settings.json / client-settings.json / desktop-settings.json",
    },
    {
      category: "keybindings",
      available: keybindingsStat.fileCount > 0,
      fileCount: keybindingsStat.fileCount,
      totalBytes: keybindingsStat.totalBytes,
      detail: "keybindings.json",
    },
    {
      category: "themes",
      available: themesStat.fileCount > 0,
      fileCount: themesStat.fileCount,
      totalBytes: themesStat.totalBytes,
      detail: "themes/",
    },
    {
      category: "stateDb",
      available: stateDbStat.fileCount > 0,
      fileCount: stateDbStat.fileCount,
      totalBytes: stateDbStat.totalBytes,
      detail:
        sqliteMeta.projectCount !== null || sqliteMeta.threadCount !== null
          ? `statev2.sqlite (${sqliteMeta.projectCount ?? 0} projects, ${sqliteMeta.threadCount ?? 0} threads)`
          : "statev2.sqlite",
    },
    {
      category: "attachments",
      available: attachmentsStat.fileCount > 0,
      fileCount: attachmentsStat.fileCount,
      totalBytes: attachmentsStat.totalBytes,
      detail: "attachments/",
    },
    {
      category: "usageDb",
      available: usageDbStat.fileCount > 0,
      fileCount: usageDbStat.fileCount,
      totalBytes: usageDbStat.totalBytes,
      detail: "usage-estimates.sqlite",
    },
    {
      category: "secrets",
      available: secretsStat.fileCount > 0,
      fileCount: secretsStat.fileCount,
      totalBytes: secretsStat.totalBytes,
      detail: "secrets/ (provider keys only, excludes clerk & telemetry)",
    },
  ];

  return {
    brand,
    baseDir: input.baseDir,
    userdataDir,
    exists: true,
    schemaCompatible: sqliteMeta.compatible || settingsFiles > 0 || keybindingsStat.fileCount > 0,
    projectCount: sqliteMeta.projectCount,
    threadCount: sqliteMeta.threadCount,
    categories,
    excludedTelemetryItems,
  };
}

/** Auto-discovers both `~/.t3-plus` (T3 Code Plus) and `~/.t3` (T3 Code) read-only. */
export function discoverLegacySourcesReadOnly(
  homeDir: string = NodeOS.homedir(),
): ReadonlyArray<LegacySourceScanResult> {
  const candidates = resolveLegacyReadOnlyImportCandidates(homeDir, NodePath.join);
  return candidates.map((c) =>
    scanLegacySourceReadOnly({ baseDir: c.baseDir, brand: c.sourceBrand }),
  );
}

function copyFileSafe(
  src: string,
  dest: string,
  overwrite: boolean,
): { readonly copied: boolean; readonly bytes: number } {
  if (!NodeFS.existsSync(src)) return { copied: false, bytes: 0 };
  if (NodeFS.existsSync(dest) && !overwrite) {
    return { copied: false, bytes: 0 };
  }
  NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
  if (NodeFS.existsSync(dest) && overwrite) {
    NodeFS.copyFileSync(dest, `${dest}.pre-import.bak`);
  }
  const tmpDest = `${dest}.bytedock-import-tmp`;
  NodeFS.copyFileSync(src, tmpDest);
  NodeFS.renameSync(tmpDest, dest);
  return { copied: true, bytes: NodeFS.statSync(dest).size };
}

function copyDirectorySafe(
  srcDir: string,
  destDir: string,
  overwrite: boolean,
): { readonly filesCopied: number; readonly bytesCopied: number } {
  if (!NodeFS.existsSync(srcDir)) return { filesCopied: 0, bytesCopied: 0 };
  let filesCopied = 0;
  let bytesCopied = 0;

  const walk = (currentSrc: string, currentDest: string) => {
    NodeFS.mkdirSync(currentDest, { recursive: true });
    for (const entry of NodeFS.readdirSync(currentSrc, { withFileTypes: true })) {
      if (LEGACY_IMPORT_DENYLIST.has(entry.name)) continue;
      if (entry.name.toLowerCase().includes("clerk")) continue;
      const srcPath = NodePath.join(currentSrc, entry.name);
      const destPath = NodePath.join(currentDest, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        const res = copyFileSafe(srcPath, destPath, overwrite);
        if (res.copied) {
          filesCopied += 1;
          bytesCopied += res.bytes;
        }
      }
    }
  };

  walk(srcDir, destDir);
  return { filesCopied, bytesCopied };
}

/**
 * Produces a consistent single-file SQLite snapshot from a live WAL-mode source DB
 * using a strictly read-only connection + `VACUUM INTO`. Never mutates source files.
 */
function snapshotSqliteReadOnly(sourceDbPath: string, destinationPath: string): number {
  NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
  const tmpPath = `${destinationPath}.vacuum-tmp`;
  if (NodeFS.existsSync(tmpPath)) {
    NodeFS.rmSync(tmpPath, { force: true });
  }
  const escapedTmp = tmpPath.replaceAll("'", "''");
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(sourceDbPath, { readOnly: true });
    db.exec(`VACUUM INTO '${escapedTmp}'`);
  } finally {
    db?.close();
  }
  if (NodeFS.existsSync(destinationPath)) {
    NodeFS.rmSync(destinationPath, { force: true });
  }
  NodeFS.renameSync(tmpPath, destinationPath);
  return NodeFS.statSync(destinationPath).size;
}

/**
 * Executes a non-destructive read-only import from T3 Code or T3 Code Plus into `~/.bytedock/userdata`.
 * Guarantees zero writes to source paths and stages `statev2.sqlite` safely when target DB is live-locked.
 */
export function runLegacyReadOnlyImport(options: LegacyImportOptions): LegacyImportReport {
  const sourceUserdataDir = resolveUserdataDir(options.sourceBaseDir);
  const sourceBrand: LegacySourceBrand =
    options.sourceBrand ??
    (options.sourceBaseDir.toLowerCase().includes(".t3-plus")
      ? "t3-plus"
      : options.sourceBaseDir.toLowerCase().includes(".t3")
        ? "t3"
        : "custom");

  // Guardrail: never allow importing into the same directory as the source.
  if (NodePath.resolve(sourceUserdataDir) === NodePath.resolve(options.targetStateDir)) {
    throw new Error("Source and target ByteDock userdata directories must be distinct.");
  }

  NodeFS.mkdirSync(options.targetStateDir, { recursive: true });
  const overwrite = options.overwrite ?? false;
  const deferLockedStateDb = options.deferLockedStateDb ?? false;
  const outcomes: Array<LegacyImportedCategoryOutcome> = [];
  let restartRequired = false;

  for (const category of options.categories) {
    switch (category) {
      case "settings": {
        let copiedCount = 0;
        let copiedBytes = 0;
        let foundAny = false;
        for (const filename of SETTINGS_FILES) {
          const src = NodePath.join(sourceUserdataDir, filename);
          if (!NodeFS.existsSync(src)) continue;
          foundAny = true;
          const dest = NodePath.join(options.targetStateDir, filename);
          const res = copyFileSafe(src, dest, overwrite);
          if (res.copied) {
            copiedCount += 1;
            copiedBytes += res.bytes;
          }
        }
        outcomes.push({
          category,
          status: !foundAny ? "skipped-missing" : copiedCount > 0 ? "imported" : "skipped-exists",
          filesCopied: copiedCount,
          bytesCopied: copiedBytes,
          targetPath: options.targetStateDir,
        });
        break;
      }

      case "keybindings": {
        const src = NodePath.join(sourceUserdataDir, "keybindings.json");
        const dest = NodePath.join(options.targetStateDir, "keybindings.json");
        if (!NodeFS.existsSync(src)) {
          outcomes.push({ category, status: "skipped-missing", filesCopied: 0, bytesCopied: 0 });
        } else {
          const res = copyFileSafe(src, dest, overwrite);
          outcomes.push({
            category,
            status: res.copied ? "imported" : "skipped-exists",
            filesCopied: res.copied ? 1 : 0,
            bytesCopied: res.bytes,
            targetPath: dest,
          });
        }
        break;
      }

      case "themes":
      case "attachments":
      case "secrets": {
        const srcDir = NodePath.join(sourceUserdataDir, category);
        const destDir = NodePath.join(options.targetStateDir, category);
        if (!NodeFS.existsSync(srcDir)) {
          outcomes.push({ category, status: "skipped-missing", filesCopied: 0, bytesCopied: 0 });
        } else {
          const res = copyDirectorySafe(srcDir, destDir, overwrite);
          outcomes.push({
            category,
            status: res.filesCopied > 0 ? "imported" : "skipped-exists",
            filesCopied: res.filesCopied,
            bytesCopied: res.bytesCopied,
            targetPath: destDir,
          });
        }
        break;
      }

      case "stateDb": {
        const srcDb = NodePath.join(sourceUserdataDir, "statev2.sqlite");
        const targetDb = NodePath.join(options.targetStateDir, "statev2.sqlite");
        if (!NodeFS.existsSync(srcDb)) {
          outcomes.push({ category, status: "skipped-missing", filesCopied: 0, bytesCopied: 0 });
          break;
        }
        if (NodeFS.existsSync(targetDb) && !overwrite && !deferLockedStateDb) {
          outcomes.push({
            category,
            status: "skipped-exists",
            filesCopied: 0,
            bytesCopied: 0,
            targetPath: targetDb,
          });
          break;
        }
        if (deferLockedStateDb) {
          const stagedPath = NodePath.join(options.targetStateDir, PENDING_STATE_DB_FILENAME);
          const bytes = snapshotSqliteReadOnly(srcDb, stagedPath);
          restartRequired = true;
          outcomes.push({
            category,
            status: "staged-for-restart",
            filesCopied: 1,
            bytesCopied: bytes,
            targetPath: stagedPath,
          });
        } else {
          if (NodeFS.existsSync(targetDb)) {
            NodeFS.copyFileSync(targetDb, `${targetDb}.pre-import.bak`);
          }
          const bytes = snapshotSqliteReadOnly(srcDb, targetDb);
          outcomes.push({
            category,
            status: "imported",
            filesCopied: 1,
            bytesCopied: bytes,
            targetPath: targetDb,
          });
        }
        break;
      }

      case "usageDb": {
        const srcDb = NodePath.join(sourceUserdataDir, "usage-estimates.sqlite");
        const targetDb = NodePath.join(options.targetStateDir, "usage-estimates.sqlite");
        if (!NodeFS.existsSync(srcDb)) {
          outcomes.push({ category, status: "skipped-missing", filesCopied: 0, bytesCopied: 0 });
          break;
        }
        if (NodeFS.existsSync(targetDb) && !overwrite) {
          outcomes.push({
            category,
            status: "skipped-exists",
            filesCopied: 0,
            bytesCopied: 0,
            targetPath: targetDb,
          });
          break;
        }
        const bytes = snapshotSqliteReadOnly(srcDb, targetDb);
        outcomes.push({
          category,
          status: "imported",
          filesCopied: 1,
          bytesCopied: bytes,
          targetPath: targetDb,
        });
        break;
      }
    }
  }

  const report: LegacyImportReport = {
    sourceBrand,
    sourceBaseDir: options.sourceBaseDir,
    sourceUserdataDir,
    targetStateDir: options.targetStateDir,
    importedAt: new Date().toISOString(),
    sourceReadOnlyVerified: true,
    restartRequired,
    outcomes,
  };

  const receiptPath = NodePath.join(options.targetStateDir, "legacy-import-receipt.json");
  NodeFS.writeFileSync(receiptPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}

/**
 * Promotes a staged `statev2.sqlite.pending-import` snapshot before ByteDock opens its SQLite DB.
 */
export function applyPendingStateDbImportIfPresent(stateDir: string): boolean {
  const stagedPath = NodePath.join(stateDir, PENDING_STATE_DB_FILENAME);
  if (!NodeFS.existsSync(stagedPath)) return false;
  const targetDb = NodePath.join(stateDir, "statev2.sqlite");
  if (NodeFS.existsSync(targetDb)) {
    NodeFS.copyFileSync(targetDb, `${targetDb}.pre-import.bak`);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${targetDb}${suffix}`;
      if (NodeFS.existsSync(sidecar)) {
        NodeFS.rmSync(sidecar, { force: true });
      }
    }
  }
  NodeFS.renameSync(stagedPath, targetDb);
  return true;
}

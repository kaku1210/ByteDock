/**
 * ByteDock isolated home directory layout & read-only legacy import discovery.
 *
 * ByteDock stores all runtime data under `~/.bytedock` so it never mutates or
 * collides with existing `~/.t3` or `~/.t3-plus` installations.
 */

export const BYTEDOCK_BRAND_NAME = "ByteDock";
export const BYTEDOCK_WEBSITE_URL = "https://byte.didyou.eat";
export const BYTEDOCK_PROTOCOL_SCHEME = "bytedock";
export const BYTEDOCK_HOME_DIR_NAME = ".bytedock";
export const BYTEDOCK_HOME_ENV_VAR = "BYTEDOCK_HOME";
export const BYTEDOCK_AUMID_PROD = "dev.bytedock.desktop";
export const BYTEDOCK_AUMID_DEV = "dev.bytedock.desktop.dev";
export const BYTEDOCK_GITHUB_REPOSITORY = "kaku1210/ByteDock";

export interface ByteDockDirectoryLayout {
  readonly baseDir: string;
  readonly pluginsDir: string;
  readonly pluginsDevDir: string;
  readonly pluginsConfigPath: string;
  readonly pluginsDataDir: string;
  readonly auditDir: string;
  readonly artifactsDir: string;
}

export type JoinPathFn = (first: string, ...segments: ReadonlyArray<string>) => string;

export function resolveByteDockDirectoryLayout(
  baseDir: string,
  joinPath: JoinPathFn,
): ByteDockDirectoryLayout {
  return {
    baseDir,
    pluginsDir: joinPath(baseDir, "plugins"),
    pluginsDevDir: joinPath(baseDir, "plugins-dev"),
    pluginsConfigPath: joinPath(baseDir, "plugins.yml"),
    pluginsDataDir: joinPath(baseDir, "plugins-data"),
    auditDir: joinPath(baseDir, "audit"),
    artifactsDir: joinPath(baseDir, "artifacts"),
  };
}

export interface LegacyImportCandidate {
  readonly sourceBrand: "t3-plus" | "t3";
  readonly baseDir: string;
  readonly settingsPath: string;
  readonly keybindingsPath: string;
}

/**
 * Enumerates candidate legacy T3 directories for a one-time read-only import wizard.
 * ByteDock must NEVER open or write to these paths in read-write mode.
 */
export function resolveLegacyReadOnlyImportCandidates(
  homeDirectory: string,
  joinPath: JoinPathFn,
): ReadonlyArray<LegacyImportCandidate> {
  const plusBase = joinPath(homeDirectory, ".t3-plus");
  const officialBase = joinPath(homeDirectory, ".t3");
  return [
    {
      sourceBrand: "t3-plus",
      baseDir: plusBase,
      settingsPath: joinPath(plusBase, "userdata", "settings.json"),
      keybindingsPath: joinPath(plusBase, "userdata", "keybindings.json"),
    },
    {
      sourceBrand: "t3",
      baseDir: officialBase,
      settingsPath: joinPath(officialBase, "userdata", "settings.json"),
      keybindingsPath: joinPath(officialBase, "userdata", "keybindings.json"),
    },
  ];
}

// @effect-diagnostics nodeBuiltinImport:off -- Standalone CI static gate script.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface DeniedDomainsConfig {
  readonly deniedDomains: ReadonlyArray<string>;
  readonly deniedPackages: ReadonlyArray<string>;
  readonly deniedCredentialReads: ReadonlyArray<string>;
}

export interface TelemetryViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: "domain" | "package" | "credential-read";
  readonly match: string;
}

const IGNORED_DIRS = new Set([
  ".generated",
  ".git",
  ".repos",
  ".t3",
  ".vite-plus",
  "coverage",
  "dist",
  "dist-electron",
  "dist-exe",
  "node_modules",
]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]);

// Files that legitimately reference denied patterns to enforce or document blocking rules,
// plus audited non-telemetry provider/UI filter entries.
const ALLOWLIST_PATH_PATTERNS = [
  /^scripts\/egress-denied-domains\.json$/,
  /^scripts\/check-zero-telemetry(\.test)?\.ts$/,
  /^plugins\/plugin-egress-guard\//,
  /^plugins\/plugin-upstream-radar\//,
  /^packages\/plugin-kernel\/src\/egressGuard/,
  // Audited: strips third-party tracking pixel URLs (including segment pixel) from PR comments.
  /^apps\/mobile\/src\/features\/pull-requests\/botBadgeImages\.ts$/,
  // Audited: user-initiated Claude provider reset-credit claim (never used for analytics/telemetry).
  /^apps\/server\/src\/provider\/claudeResetCredits\.ts$/,
  /\.test\.[cm]?[jt]sx?$/,
  /^apps\/marketing\//,
  /^evals\//,
  /^docs\//,
];

function isAllowlisted(relPath: string): boolean {
  return ALLOWLIST_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
}

export function scanSourceForTelemetryViolations(
  relPath: string,
  content: string,
  config: DeniedDomainsConfig,
): ReadonlyArray<TelemetryViolation> {
  if (isAllowlisted(relPath)) return [];
  const violations: Array<TelemetryViolation> = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    // Skip pure comments explaining why telemetry was removed.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    for (const domain of config.deniedDomains) {
      if (line.includes(domain)) {
        violations.push({ file: relPath, line: i + 1, kind: "domain", match: domain });
      }
    }
    for (const pkg of config.deniedPackages) {
      if (
        line.includes(`"${pkg}"`) ||
        line.includes(`'${pkg}'`) ||
        line.includes(`"${pkg}/`) ||
        line.includes(`'${pkg}/`)
      ) {
        violations.push({ file: relPath, line: i + 1, kind: "package", match: pkg });
      }
    }
    for (const cred of config.deniedCredentialReads) {
      // Only flag active filesystem read calls or path joins targeting external CLI auth files.
      if (
        line.includes(cred) &&
        /(readFile|openSync|createReadStream|readFileString|join\()/.test(line)
      ) {
        violations.push({ file: relPath, line: i + 1, kind: "credential-read", match: cred });
      }
    }
  }

  return violations;
}

export function runZeroTelemetryScan(repoRoot: string): ReadonlyArray<TelemetryViolation> {
  const configPath = NodePath.join(repoRoot, "scripts", "egress-denied-domains.json");
  const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8")) as DeniedDomainsConfig;
  const scanRoots = ["apps", "packages", "plugins", "scripts"];
  const allViolations: Array<TelemetryViolation> = [];

  const walk = (dir: string): void => {
    if (!NodeFS.existsSync(dir)) return;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const ext = NodePath.extname(entry.name);
      if (!SCANNED_EXTENSIONS.has(ext)) continue;
      const relPath = NodePath.relative(repoRoot, fullPath).replace(/\\/g, "/");
      if (isAllowlisted(relPath)) continue;
      const content = NodeFS.readFileSync(fullPath, "utf8");
      allViolations.push(...scanSourceForTelemetryViolations(relPath, content, config));
    }
  };

  for (const root of scanRoots) {
    walk(NodePath.join(repoRoot, root));
  }

  return allViolations;
}

const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) ===
    NodePath.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectExecution) {
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const violations = runZeroTelemetryScan(repoRoot);
  if (violations.length > 0) {
    console.error(
      `[check-zero-telemetry] Found ${violations.length} prohibited telemetry/credential reference(s):`,
    );
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} [${v.kind}] ${v.match}`);
    }
    process.exit(1);
  }
  console.log(
    "[check-zero-telemetry] PASS (0 violations across apps/, packages/, plugins/, scripts/)",
  );
}

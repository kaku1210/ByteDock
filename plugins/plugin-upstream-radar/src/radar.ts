// @effect-diagnostics nodeBuiltinImport:off -- Radar reads shared JSON policy files and persists upstream-ledger.jsonl.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type UpstreamClass = "A" | "B" | "C" | "D";

/** Upstream absorption mode: direct cherry-pick, native AI idea-sync rewrite, plugin, or skipped. */
export type AbsorptionStrategy = "cherry-pick" | "idea-sync" | "plugin" | "skipped";

export interface DeniedTelemetryPolicy {
  readonly schemaVersion: number;
  readonly deniedDomains: ReadonlyArray<string>;
  readonly deniedPackages: ReadonlyArray<string>;
  readonly deniedCredentialReads: ReadonlyArray<string>;
}

export interface UpstreamChangeInput {
  readonly prSha: string;
  readonly prNumber?: number | undefined;
  readonly title: string;
  readonly touchedFiles: ReadonlyArray<string>;
  readonly diffText: string;
  readonly author?: string | undefined;
}

export interface UpstreamClassification {
  readonly prSha: string;
  readonly classification: UpstreamClass;
  readonly recommendedStrategy: AbsorptionStrategy;
  readonly dClassHits: ReadonlyArray<string>;
  readonly touchedSeams: ReadonlyArray<string>;
  readonly requiresManualReview: boolean;
  readonly reason: string;
}

export interface UpstreamLedgerEntry {
  readonly prSha: string;
  readonly prNumber?: number | undefined;
  readonly title: string;
  readonly classification: UpstreamClass;
  readonly strategy: AbsorptionStrategy;
  readonly dClassHits: ReadonlyArray<string>;
  readonly touchedSeams: ReadonlyArray<string>;
  readonly recordedAt: string;
  readonly notes?: string | undefined;
}

const HOSTED_CLOUD_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^apps\/server\/src\/telemetry\//,
  /^apps\/server\/src\/cloud\//,
  /^apps\/marketing\//,
];

const CLASS_D_DIFF_MARKERS: ReadonlyArray<RegExp> = [
  /\bCLERK_PUBLISHABLE_KEY\b/,
  /\bVITE_CLERK_/,
  /\bposthog\b/i,
  /\bsentry\b/i,
  /\bT3_TELEMETRY\b/i,
];

export function loadDeniedTelemetryPolicy(policyPath: string): DeniedTelemetryPolicy {
  return JSON.parse(NodeFS.readFileSync(policyPath, "utf8")) as DeniedTelemetryPolicy;
}

/**
 * Stage 1 hard zero-telemetry & credential-harvesting gate (W1-8).
 * Any hit against scripts/egress-denied-domains.json or hosted-telemetry patterns
 * unconditionally demotes the upstream commit/PR to Class D ("skipped") before AI review.
 */
export function detectClassDHits(
  change: UpstreamChangeInput,
  policy: DeniedTelemetryPolicy,
): ReadonlyArray<string> {
  const hits = new Set<string>();
  const haystack = `${change.title}\n${change.diffText}`;
  const lower = haystack.toLowerCase();

  for (const domain of policy.deniedDomains) {
    if (lower.includes(domain.toLowerCase())) {
      hits.add(`denied-domain:${domain}`);
    }
  }
  for (const pkg of policy.deniedPackages) {
    if (lower.includes(pkg.toLowerCase())) {
      hits.add(`denied-package:${pkg}`);
    }
  }
  for (const cred of policy.deniedCredentialReads) {
    if (lower.includes(cred.toLowerCase())) {
      hits.add(`denied-credential-read:${cred}`);
    }
  }
  for (const re of CLASS_D_DIFF_MARKERS) {
    if (re.test(haystack)) {
      hits.add(`denied-marker:${re.source}`);
    }
  }
  for (const file of change.touchedFiles) {
    const norm = file.replace(/\\/g, "/");
    for (const pathRe of HOSTED_CLOUD_PATH_PATTERNS) {
      if (pathRe.test(norm)) {
        hits.add(`denied-path:${norm}`);
      }
    }
  }

  return [...hits];
}

export interface SeamLookupEntry {
  readonly id: string;
  readonly files: ReadonlyArray<string>;
  readonly review: "auto" | "manual";
}

/**
 * Classifies an upstream PR/commit into A / B / C / D using Stage 1 D-class policy + seam ledger.
 */
export function classifyUpstreamChange(
  change: UpstreamChangeInput,
  policy: DeniedTelemetryPolicy,
  seams: ReadonlyArray<SeamLookupEntry> = [],
): UpstreamClassification {
  const dClassHits = detectClassDHits(change, policy);
  if (dClassHits.length > 0) {
    return {
      prSha: change.prSha,
      classification: "D",
      recommendedStrategy: "skipped",
      dClassHits,
      touchedSeams: [],
      requiresManualReview: false,
      reason: `Stage 1 zero-telemetry gate blocked D-class change (${dClassHits.join(", ")}).`,
    };
  }

  const normalizedFiles = change.touchedFiles.map((f) => f.replace(/\\/g, "/"));
  const touchedSeams: Array<string> = [];
  let requiresManualReview = false;

  for (const seam of seams) {
    if (seam.files.some((sf) => normalizedFiles.includes(sf))) {
      touchedSeams.push(seam.id);
      if (seam.review === "manual") requiresManualReview = true;
    }
  }

  if (requiresManualReview) {
    return {
      prSha: change.prSha,
      classification: "A",
      recommendedStrategy: "idea-sync",
      dClassHits: [],
      touchedSeams,
      requiresManualReview: true,
      reason: `Touches high-sensitivity manual-review seam(s): ${touchedSeams.join(", ")}. Prefer idea-sync or manual review.`,
    };
  }

  if (touchedSeams.length > 0) {
    return {
      prSha: change.prSha,
      classification: "B",
      recommendedStrategy: "cherry-pick",
      dClassHits: [],
      touchedSeams,
      requiresManualReview: false,
      reason: `Touches auto-mergeable seam file(s): ${touchedSeams.join(", ")}.`,
    };
  }

  return {
    prSha: change.prSha,
    classification: "C",
    recommendedStrategy: "cherry-pick",
    dClassHits: [],
    touchedSeams: [],
    requiresManualReview: false,
    reason: "Does not intersect any ByteDock seam or D-class policy.",
  };
}

/**
 * Idempotent JSONL ledger keyed on `prSha`.
 * Repeated runs with the same `prSha` are guaranteed no-ops (returns `{ appended: false }`).
 */
export function recordUpstreamLedgerEntry(
  ledgerFilePath: string,
  entry: UpstreamLedgerEntry,
): { readonly appended: boolean; readonly existing?: UpstreamLedgerEntry | undefined } {
  NodeFS.mkdirSync(NodePath.dirname(ledgerFilePath), { recursive: true });
  const existingEntries = readUpstreamLedger(ledgerFilePath);
  const duplicate = existingEntries.find((e) => e.prSha === entry.prSha);
  if (duplicate) {
    return { appended: false, existing: duplicate };
  }
  NodeFS.appendFileSync(ledgerFilePath, `${JSON.stringify(entry)}\n`, "utf8");
  return { appended: true };
}

export function readUpstreamLedger(ledgerFilePath: string): ReadonlyArray<UpstreamLedgerEntry> {
  if (!NodeFS.existsSync(ledgerFilePath)) return [];
  const raw = NodeFS.readFileSync(ledgerFilePath, "utf8").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line: string) => JSON.parse(line) as UpstreamLedgerEntry);
}

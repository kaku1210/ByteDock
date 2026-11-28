// @effect-diagnostics nodeBuiltinImport:off -- Permission fingerprinting hashes manifest declarations via node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Schema from "effect/Schema";

import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import { DEFAULT_DENIED_DOMAINS, type EgressPolicy } from "./egressGuard.ts";

export const EgressGuardConfigSchema = Schema.Struct({
  mode: Schema.Literals(["strict", "audit-only"]),
  allowedHosts: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  allowLoopbackHosts: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  deniedDomains: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  allowUdp: Schema.Boolean,
});
export type EgressGuardConfig = typeof EgressGuardConfigSchema.Type;

export const TokenOptimizerConfigSchema = Schema.Struct({
  cacheGuardActive: Schema.Boolean,
  steadyStateTargetPct: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 99 })),
  xrayHonestyMode: Schema.Literals(["strict-no-fabrication"]),
  showStatusBarMetrics: Schema.Boolean,
  watchdogEnabled: Schema.Boolean,
  watchdogWarnAfterSec: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 600 })),
  watchdogCriticalAfterSec: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 1800 })),
});
export type TokenOptimizerConfig = typeof TokenOptimizerConfigSchema.Type;

export const BotsCoreConfigSchema = Schema.Struct({
  soulPrefixGuard: Schema.Boolean,
  memoryMode: Schema.Literals(["append-only"]),
  autoReplyEnabled: Schema.Boolean,
  replyMaxChars: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 4000 })),
  turnWaitTimeoutSec: Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 600 })),
});
export type BotsCoreConfig = typeof BotsCoreConfigSchema.Type;

export const NapcatQqConfigSchema = Schema.Struct({
  endpointMode: Schema.Literals(["loopback-only"]),
  oneBotBaseUrl: Schema.String.check(Schema.isMinLength(1)),
  allowedHosts: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMinLength(1),
  ),
  rateLimitPerMin: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
  webhookRoute: Schema.String.check(Schema.isMinLength(1)),
  webhookAuthMode: Schema.Literals(["onebot-hmac", "hmac-and-bearer"]),
  tokenSecretRef: Schema.String.check(Schema.isMinLength(1)),
  allowedUserIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  allowedGroupIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  requireAtInGroup: Schema.Boolean,
});
export type NapcatQqConfig = typeof NapcatQqConfigSchema.Type;

export const LegacyImporterConfigSchema = Schema.Struct({
  deferLockedStateDb: Schema.Boolean,
});
export type LegacyImporterConfig = typeof LegacyImporterConfigSchema.Type;

export const DEFAULT_BUILTIN_PLUGIN_CONFIGS: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  "builtin.egress-guard": {
    mode: "audit-only",
    allowedHosts: ["*"],
    allowLoopbackHosts: ["127.0.0.1", "localhost", "::1"],
    deniedDomains: [...DEFAULT_DENIED_DOMAINS],
    allowUdp: false,
  } satisfies EgressGuardConfig,
  "builtin.token-optimizer": {
    cacheGuardActive: true,
    steadyStateTargetPct: 90,
    xrayHonestyMode: "strict-no-fabrication",
    showStatusBarMetrics: true,
    watchdogEnabled: true,
    watchdogWarnAfterSec: 45,
    watchdogCriticalAfterSec: 120,
  } satisfies TokenOptimizerConfig,
  "builtin.bots-core": {
    soulPrefixGuard: true,
    memoryMode: "append-only",
    autoReplyEnabled: true,
    replyMaxChars: 1500,
    turnWaitTimeoutSec: 120,
  } satisfies BotsCoreConfig,
  "community.napcat-qq": {
    endpointMode: "loopback-only",
    oneBotBaseUrl: "http://127.0.0.1:3000",
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
    rateLimitPerMin: 50,
    webhookRoute: "/api/plugins/community.napcat-qq/onebot/event",
    webhookAuthMode: "onebot-hmac",
    tokenSecretRef: "bytedock.napcat.webhook_token",
    allowedUserIds: [],
    allowedGroupIds: [],
    requireAtInGroup: true,
  } satisfies NapcatQqConfig,
  "builtin.legacy-importer": {
    deferLockedStateDb: true,
  } satisfies LegacyImporterConfig,
};

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(token|api[_-]?key|password|passwd|secret|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?header|bearer)($|[_-])/i;

const ALLOWED_NON_SECRET_KEYS = new Set([
  "secretref",
  "secretrefs",
  "secretnamespaces",
  "tokenbudget",
  "tokencount",
  "tokenlimit",
  "tokenoptimizer",
]);

const PLAINTEXT_SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /^sk-[A-Za-z0-9_-]{12,}$/,
  /^gh[pousr]_[A-Za-z0-9_]{12,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
];

function isSafeSecretReferenceString(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("secret-ref:") ||
    trimmed.startsWith("$secret:") ||
    trimmed === "[REDACTED]"
  );
}

/** Rejects plaintext credential keys or token-like values in YAML/MCP config payloads without echoing them. */
export function findPlaintextSecretViolation(value: unknown, path = "config"): string | undefined {
  if (typeof value === "string") {
    if (!isSafeSecretReferenceString(value)) {
      for (const pattern of PLAINTEXT_SECRET_VALUE_PATTERNS) {
        if (pattern.test(value.trim())) {
          return `Plaintext secret-like value is forbidden at "${path}". Use a secret-ref instead.`;
        }
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findPlaintextSecretViolation(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const childPath = `${path}.${key}`;
      if (
        SENSITIVE_KEY_PATTERN.test(key) &&
        !ALLOWED_NON_SECRET_KEYS.has(normalizedKey) &&
        !key.toLowerCase().endsWith("secretref")
      ) {
        if (typeof entry === "string" && !isSafeSecretReferenceString(entry)) {
          return `Plaintext credential field "${childPath}" is forbidden in plugins.yml. Use a secretRef via request_secret.`;
        }
        if (entry !== undefined && entry !== null && typeof entry !== "string") {
          return `Sensitive credential field "${childPath}" cannot store inline structured values in plugins.yml.`;
        }
      }
      const nested = findPlaintextSecretViolation(entry, childPath);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function getDefaultPluginConfig(pluginId: string): Readonly<Record<string, unknown>> {
  const base = DEFAULT_BUILTIN_PLUGIN_CONFIGS[pluginId];
  if (!base) return {};
  return structuredClone(base);
}

export type PluginConfigValidationResult =
  | { readonly ok: true; readonly config: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly message: string };

const decodeEgressGuardConfig = Schema.decodeUnknownSync(EgressGuardConfigSchema);
const decodeTokenOptimizerConfig = Schema.decodeUnknownSync(TokenOptimizerConfigSchema);
const decodeBotsCoreConfig = Schema.decodeUnknownSync(BotsCoreConfigSchema);
const decodeNapcatQqConfig = Schema.decodeUnknownSync(NapcatQqConfigSchema);
const decodeLegacyImporterConfig = Schema.decodeUnknownSync(LegacyImporterConfigSchema);

const BUILTIN_SCHEMA_VALIDATORS: Readonly<
  Record<string, (value: unknown) => Readonly<Record<string, unknown>>>
> = {
  "builtin.egress-guard": (v) => decodeEgressGuardConfig(v) as Readonly<Record<string, unknown>>,
  "builtin.token-optimizer": (v) =>
    decodeTokenOptimizerConfig(v) as Readonly<Record<string, unknown>>,
  "builtin.bots-core": (v) => decodeBotsCoreConfig(v) as Readonly<Record<string, unknown>>,
  "community.napcat-qq": (v) => decodeNapcatQqConfig(v) as Readonly<Record<string, unknown>>,
  "builtin.legacy-importer": (v) =>
    decodeLegacyImporterConfig(v) as Readonly<Record<string, unknown>>,
};

function normalizeHostList(items: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const item of items) {
    const clean = item.trim().toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

/** Merges user/plugin Egress config with mandatory DEFAULT_DENIED_DOMAINS baseline protection. */
export function buildEffectiveEgressPolicy(
  rawConfig: Readonly<Record<string, unknown>>,
): EgressPolicy {
  const defaults = DEFAULT_BUILTIN_PLUGIN_CONFIGS["builtin.egress-guard"] as EgressGuardConfig;
  const merged: unknown = { ...defaults, ...rawConfig };
  const parsed = decodeEgressGuardConfig(merged);
  return {
    mode: parsed.mode,
    allowedHosts: normalizeHostList(parsed.allowedHosts),
    allowLoopbackHosts: normalizeHostList(parsed.allowLoopbackHosts),
    deniedDomains: normalizeHostList([...DEFAULT_DENIED_DOMAINS, ...parsed.deniedDomains]),
    allowUdp: parsed.allowUdp,
  };
}

/** Validates and merges a plugin configuration patch/snapshot against builtin schemas and secret rules. */
export function validatePluginConfig(
  pluginId: string,
  inputConfig: Readonly<Record<string, unknown>> | undefined,
  baseConfig?: Readonly<Record<string, unknown>> | undefined,
): PluginConfigValidationResult {
  if (
    inputConfig !== undefined &&
    (inputConfig === null || typeof inputConfig !== "object" || Array.isArray(inputConfig))
  ) {
    return { ok: false, message: `Plugin "${pluginId}" config must be a JSON/YAML object.` };
  }
  const merged: Record<string, unknown> = {
    ...getDefaultPluginConfig(pluginId),
    ...baseConfig,
    ...inputConfig,
  };
  const secretViolation = findPlaintextSecretViolation(merged, `plugins.${pluginId}.config`);
  if (secretViolation) {
    return { ok: false, message: secretViolation };
  }

  const validator = BUILTIN_SCHEMA_VALIDATORS[pluginId];
  if (!validator) {
    return { ok: true, config: merged };
  }

  const knownKeys = new Set(Object.keys(getDefaultPluginConfig(pluginId)));
  for (const key of Object.keys(merged)) {
    if (!knownKeys.has(key)) {
      return {
        ok: false,
        message: `Unknown config field "${key}" for plugin "${pluginId}".`,
      };
    }
  }

  try {
    const decoded = validator(merged);
    if (pluginId === "builtin.egress-guard") {
      const effective = buildEffectiveEgressPolicy(decoded);
      return {
        ok: true,
        config: {
          mode: effective.mode,
          allowedHosts: [...effective.allowedHosts],
          allowLoopbackHosts: [...effective.allowLoopbackHosts],
          deniedDomains: [...effective.deniedDomains],
          allowUdp: effective.allowUdp,
        },
      };
    }
    if (pluginId === "builtin.token-optimizer") {
      const cfg = decoded as unknown as TokenOptimizerConfig;
      if (cfg.watchdogCriticalAfterSec <= cfg.watchdogWarnAfterSec) {
        return {
          ok: false,
          message:
            'Invalid config for "builtin.token-optimizer": watchdogCriticalAfterSec must be greater than watchdogWarnAfterSec.',
        };
      }
    }
    if (pluginId === "community.napcat-qq") {
      const cfg = decoded as unknown as NapcatQqConfig;
      const napcatErr = validateNapcatQqSemantics(cfg);
      if (napcatErr) {
        return { ok: false, message: napcatErr };
      }
      return {
        ok: true,
        config: {
          ...cfg,
          oneBotBaseUrl: cfg.oneBotBaseUrl.trim().replace(/\/+$/, ""),
          allowedHosts: [...normalizeHostList(cfg.allowedHosts)],
          webhookRoute: cfg.webhookRoute.trim(),
          tokenSecretRef: cfg.tokenSecretRef.trim(),
          allowedUserIds: [...normalizeNumericIdList(cfg.allowedUserIds)],
          allowedGroupIds: [...normalizeNumericIdList(cfg.allowedGroupIds)],
        },
      };
    }
    return { ok: true, config: decoded };
  } catch (cause) {
    return {
      ok: false,
      message: `Invalid config for "${pluginId}": ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** Computes a deterministic SHA-256 fingerprint over a plugin manifest's declared security permissions. */
export function computePluginPermissionsFingerprint(manifest: ByteDockPluginManifest): string {
  const canonical = {
    execution: manifest.execution,
    trust: manifest.trust,
    rpcScopes: [...(manifest.permissions.rpcScopes ?? [])].sort(),
    networkHosts: [...(manifest.permissions.networkHosts ?? [])].sort(),
    secretNamespaces: [...(manifest.permissions.secretNamespaces ?? [])].sort(),
    storage: manifest.permissions.storage ?? "none",
    hooks: [...(manifest.permissions.hooks ?? [])]
      .map((h) => ({ name: h.name, onError: h.onError, timeoutMs: h.timeoutMs }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface PrivilegeAssessment {
  readonly requiresApproval: boolean;
  readonly riskLevel: "normal" | "high";
  readonly reasons: ReadonlyArray<string>;
}

const NAPCAT_WEBHOOK_ROUTE_RE = /^\/api\/plugins\/community\.napcat-qq\/[A-Za-z0-9._/-]{1,128}$/;
const NAPCAT_SECRET_REF_RE = /^bytedock\.napcat\.[A-Za-z0-9_-]{1,128}$/;
const QQ_NUMERIC_ID_RE = /^[1-9]\d{0,15}$/;
const STRICT_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function normalizeNumericIdList(items: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const item of items) {
    const clean = item.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function validateNapcatQqSemantics(cfg: NapcatQqConfig): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.oneBotBaseUrl.trim());
  } catch {
    return 'Invalid config for "community.napcat-qq": oneBotBaseUrl must be a valid http(s) URL.';
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return 'Invalid config for "community.napcat-qq": oneBotBaseUrl protocol must be http or https.';
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return 'Invalid config for "community.napcat-qq": oneBotBaseUrl must not contain credentials, query parameters, or fragments.';
  }
  const normalizedHost = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (cfg.endpointMode === "loopback-only" && !STRICT_LOOPBACK_HOSTS.has(normalizedHost)) {
    return `Invalid config for "community.napcat-qq": oneBotBaseUrl host "${normalizedHost}" is forbidden in loopback-only mode (allowed: 127.0.0.1, localhost, ::1).`;
  }
  if (cfg.endpointMode === "loopback-only") {
    for (const allowedHost of cfg.allowedHosts) {
      const cleanHost = allowedHost
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "");
      if (!STRICT_LOOPBACK_HOSTS.has(cleanHost)) {
        return `Invalid config for "community.napcat-qq": allowedHosts entry "${allowedHost}" is forbidden in loopback-only mode.`;
      }
    }
  }

  const route = cfg.webhookRoute.trim();
  if (
    !NAPCAT_WEBHOOK_ROUTE_RE.test(route) ||
    route.includes("..") ||
    route.includes("//") ||
    route.endsWith("/") ||
    route === "/api/plugins/community.napcat-qq/health"
  ) {
    return 'Invalid config for "community.napcat-qq": webhookRoute must stay under "/api/plugins/community.napcat-qq/<path>" without traversal or /health collision.';
  }

  const secretRef = cfg.tokenSecretRef.trim();
  if (!NAPCAT_SECRET_REF_RE.test(secretRef)) {
    return 'Invalid config for "community.napcat-qq": tokenSecretRef must match "bytedock.napcat.<key>" with [A-Za-z0-9_-] key characters.';
  }

  for (const id of cfg.allowedUserIds) {
    if (!QQ_NUMERIC_ID_RE.test(id.trim())) {
      return `Invalid config for "community.napcat-qq": allowedUserIds entry "${id}" must be a positive numeric QQ ID.`;
    }
  }
  for (const id of cfg.allowedGroupIds) {
    if (!QQ_NUMERIC_ID_RE.test(id.trim())) {
      return `Invalid config for "community.napcat-qq": allowedGroupIds entry "${id}" must be a positive numeric QQ group ID.`;
    }
  }
  return undefined;
}

function listAddedStrings(
  prev: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const prevSet = new Set(prev.map((s) => s.trim().toLowerCase()));
  return next.filter((item) => !prevSet.has(item.trim().toLowerCase()));
}

function listRemovedStrings(
  prev: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const nextSet = new Set(next.map((s) => s.trim().toLowerCase()));
  return prev.filter((item) => !nextSet.has(item.trim().toLowerCase()));
}

/** Classifies whether a config patch touches firewall weakening/mode changes or sensitive permission expansion. */
export function assessConfigPatchPrivilege(input: {
  readonly pluginId: string;
  readonly prevConfig: Readonly<Record<string, unknown>>;
  readonly nextConfig: Readonly<Record<string, unknown>>;
  readonly rawPatch?: Readonly<Record<string, unknown>> | undefined;
}): PrivilegeAssessment {
  const reasons: Array<string> = [];

  if (input.pluginId === "builtin.egress-guard") {
    const prev = buildEffectiveEgressPolicy(input.prevConfig);
    const next = buildEffectiveEgressPolicy(input.nextConfig);

    if (prev.mode !== next.mode) {
      reasons.push(`egress-mode-change:${prev.mode}->${next.mode}`);
    }
    const addedAllowed = listAddedStrings(prev.allowedHosts, next.allowedHosts);
    if (addedAllowed.length > 0) {
      reasons.push(`egress-allowed-hosts-expanded:${addedAllowed.join(",")}`);
    }
    const addedLoopback = listAddedStrings(prev.allowLoopbackHosts, next.allowLoopbackHosts);
    const removedLoopback = listRemovedStrings(prev.allowLoopbackHosts, next.allowLoopbackHosts);
    if (addedLoopback.length > 0 || removedLoopback.length > 0) {
      reasons.push("egress-loopback-hosts-changed");
    }
    if (!prev.allowUdp && next.allowUdp) {
      reasons.push("egress-udp-enabled");
    }
    if (Array.isArray(input.rawPatch?.deniedDomains)) {
      const requestedDenied = new Set(
        input.rawPatch.deniedDomains
          .filter((d): d is string => typeof d === "string")
          .map((d) => d.trim().toLowerCase()),
      );
      const removedBaseline = DEFAULT_DENIED_DOMAINS.filter((d) => !requestedDenied.has(d));
      const removedPrev = prev.deniedDomains.filter((d) => !requestedDenied.has(d));
      if (removedBaseline.length > 0 || removedPrev.length > 0) {
        reasons.push("egress-denied-domains-removed");
      }
    }
  } else {
    for (const hostKey of ["allowedHosts", "networkHosts"] as const) {
      const prevHosts = Array.isArray(input.prevConfig[hostKey])
        ? (input.prevConfig[hostKey] as ReadonlyArray<unknown>).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      const nextHosts = Array.isArray(input.nextConfig[hostKey])
        ? (input.nextConfig[hostKey] as ReadonlyArray<unknown>).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      const added = listAddedStrings(prevHosts, nextHosts);
      if (added.length > 0) {
        reasons.push(`plugin-${hostKey}-expanded:${added.join(",")}`);
      }
    }

    for (const privKey of ["secretNamespaces", "rpcScopes"] as const) {
      const prevVals = Array.isArray(input.prevConfig[privKey])
        ? (input.prevConfig[privKey] as ReadonlyArray<unknown>).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      const nextVals = Array.isArray(input.nextConfig[privKey])
        ? (input.nextConfig[privKey] as ReadonlyArray<unknown>).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      const added = listAddedStrings(prevVals, nextVals);
      if (added.length > 0) {
        reasons.push(`plugin-${privKey}-expanded:${added.join(",")}`);
      }
    }

    if (input.pluginId === "builtin.bots-core") {
      const prevGuard = input.prevConfig.soulPrefixGuard !== false;
      const nextGuard = input.nextConfig.soulPrefixGuard !== false;
      if (prevGuard && !nextGuard) {
        reasons.push("bots-soul-prefix-guard-disabled");
      }
    }

    if (input.pluginId === "community.napcat-qq") {
      const strChanged = (field: string): boolean => {
        const prevVal = typeof input.prevConfig[field] === "string" ? input.prevConfig[field] : "";
        const nextVal = typeof input.nextConfig[field] === "string" ? input.nextConfig[field] : "";
        return prevVal.trim() !== nextVal.trim();
      };
      if (strChanged("oneBotBaseUrl")) {
        reasons.push("napcat-onebot-base-url-changed");
      }
      if (strChanged("tokenSecretRef")) {
        reasons.push("napcat-token-secret-ref-changed");
      }
      if (strChanged("webhookRoute")) {
        reasons.push("napcat-webhook-route-changed");
      }
      if (strChanged("webhookAuthMode")) {
        reasons.push("napcat-webhook-auth-mode-changed");
      }
      const prevRequireAt = input.prevConfig.requireAtInGroup !== false;
      const nextRequireAt = input.nextConfig.requireAtInGroup !== false;
      if (prevRequireAt && !nextRequireAt) {
        reasons.push("napcat-group-at-requirement-disabled");
      }
      for (const listField of ["allowedUserIds", "allowedGroupIds"] as const) {
        const prevList = Array.isArray(input.prevConfig[listField])
          ? (input.prevConfig[listField] as ReadonlyArray<unknown>).filter(
              (v): v is string => typeof v === "string",
            )
          : [];
        const nextList = Array.isArray(input.nextConfig[listField])
          ? (input.nextConfig[listField] as ReadonlyArray<unknown>).filter(
              (v): v is string => typeof v === "string",
            )
          : [];
        if (
          listAddedStrings(prevList, nextList).length > 0 ||
          listRemovedStrings(prevList, nextList).length > 0
        ) {
          reasons.push(`napcat-${listField}-changed`);
        }
      }
    }
  }

  return reasons.length > 0
    ? { requiresApproval: true, riskLevel: "high", reasons }
    : { requiresApproval: false, riskLevel: "normal", reasons: [] };
}

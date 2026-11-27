// @effect-diagnostics nodeBuiltinImport:off -- Webhook HMAC and timing-safe checks use node:crypto.
// @effect-diagnostics globalDate:off -- Synchronous webhook replay and rate-limit windows read wall-clock timestamps.
import * as NodeCrypto from "node:crypto";

import type { PluginWebhookContribution } from "@bytedock/plugin-sdk/manifest";

export const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN = 50;
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const PURE_HEALTH_ROUTE_RE = /\/(health|healthz|ping)$/u;

export interface WebhookManifestLintViolation {
  readonly route: string;
  readonly code: "AUTH_NONE_DISALLOWED" | "MISSING_TOKEN_SECRET_REF" | "RAW_BODY_HMAC_REQUIRED";
  readonly message: string;
}

/**
 * Manifest security lint (Blueprint §8.3 / Matrix 4):
 * - auth:"none" is forbidden on any route except pure health checks (/health, /healthz, /ping)
 * - auth:"token" must declare tokenSecretRef (no inline plaintext secrets)
 * - hmac verification must use rawBody: true to prevent JSON canonicalization bypass
 */
export function lintWebhookContributions(
  webhooks: ReadonlyArray<PluginWebhookContribution>,
): ReadonlyArray<WebhookManifestLintViolation> {
  const violations: Array<WebhookManifestLintViolation> = [];
  for (const hook of webhooks) {
    if (hook.auth === "none" && !PURE_HEALTH_ROUTE_RE.test(hook.route)) {
      violations.push({
        route: hook.route,
        code: "AUTH_NONE_DISALLOWED",
        message: `Webhook "${hook.route}" declares auth:"none" on a non-health route.`,
      });
    }
    if (hook.auth === "token" && !hook.tokenSecretRef) {
      violations.push({
        route: hook.route,
        code: "MISSING_TOKEN_SECRET_REF",
        message: `Webhook "${hook.route}" with auth:"token" must specify tokenSecretRef.`,
      });
    }
    if (hook.hmac && hook.hmac.rawBody !== true) {
      violations.push({
        route: hook.route,
        code: "RAW_BODY_HMAC_REQUIRED",
        message: `Webhook "${hook.route}" HMAC verification must enable rawBody:true.`,
      });
    }
  }
  return violations;
}

export interface IncomingWebhookRequest {
  readonly route: string;
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly replayKey?: string | undefined;
  readonly seq?: number | undefined;
  readonly nowMs?: number | undefined;
}

export interface WebhookGuardOutcome {
  readonly allowed: boolean;
  readonly status: 200 | 401 | 403 | 409 | 429;
  readonly reason: string;
  readonly headers: Readonly<Record<string, string>>;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return NodeCrypto.timingSafeEqual(bufA, bufB);
}

/**
 * Computes raw-body HMAC signature for OneBot v11 (`sha1=<hex>`) or standard hex.
 * Always hashes the exact raw Buffer received over the wire (never re-serialized JSON).
 */
export function computeRawBodyHmac(
  rawBody: Buffer,
  secret: string,
  algorithm: "sha1" | "sha256" = "sha1",
): string {
  const digest = NodeCrypto.createHmac(algorithm, secret).update(rawBody).digest("hex");
  return `${algorithm}=${digest}`;
}

export interface WebhookRouteGuard {
  readonly verify: (req: IncomingWebhookRequest) => WebhookGuardOutcome;
  readonly resetState: () => void;
}

/**
 * Per-route ADR-08 webhook guard enforcing Bearer token, raw-body HMAC,
 * 300s monotonic replay window, 50/min rate limiting, and X-Frame-Options: DENY.
 */
export function createWebhookRouteGuard(options: {
  readonly contribution: PluginWebhookContribution;
  readonly resolveSecret: (secretRef: string) => string | undefined;
}): WebhookRouteGuard {
  const rateLimit = options.contribution.rateLimitPerMin ?? DEFAULT_WEBHOOK_RATE_LIMIT_PER_MIN;
  const windowMs =
    (options.contribution.replayDefense?.windowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS) * 1_000;
  const requireMonotonicSeq = options.contribution.replayDefense?.requireMonotonicSeq ?? true;

  const baseHeaders: Readonly<Record<string, string>> = {
    "X-Frame-Options": options.contribution.frameOptions ?? "DENY",
    "Cache-Control": "no-store",
  };

  let requestTimestamps: Array<number> = [];
  const seenKeys = new Map<string, number>();
  let lastAcceptedSeq = -1;

  const deny = (status: 401 | 403 | 409 | 429, reason: string): WebhookGuardOutcome => ({
    allowed: false,
    status,
    reason,
    headers: baseHeaders,
  });

  const verify = (req: IncomingWebhookRequest): WebhookGuardOutcome => {
    const now = req.nowMs ?? Date.now();

    // 1. Sliding 60s rate limit (default 50/min)
    requestTimestamps = requestTimestamps.filter((ts) => now - ts < 60_000);
    if (requestTimestamps.length >= rateLimit) {
      return deny(429, `rate-limit-exceeded:${rateLimit}/min`);
    }
    requestTimestamps.push(now);

    // 2. Auth verification
    const normalizedHeaders: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    let resolvedSecret: string | undefined;
    if (options.contribution.auth === "token") {
      const ref = options.contribution.tokenSecretRef;
      resolvedSecret = ref ? options.resolveSecret(ref) : undefined;
      if (!resolvedSecret) {
        return deny(401, "missing-configured-secret");
      }
      const authHeader = normalizedHeaders.authorization ?? "";
      const match = /^Bearer\s+(.+)$/iu.exec(authHeader.trim());
      if (!match?.[1] || !timingSafeStringEqual(match[1], resolvedSecret)) {
        return deny(401, "invalid-or-missing-bearer-token");
      }
    }

    // 3. Raw-body HMAC verification (OneBot v11 x-signature: sha1=<hex>)
    if (options.contribution.hmac) {
      const secret =
        resolvedSecret ??
        (options.contribution.tokenSecretRef
          ? options.resolveSecret(options.contribution.tokenSecretRef)
          : undefined);
      if (!secret) {
        return deny(401, "missing-hmac-secret");
      }
      const sigHeader = (normalizedHeaders["x-signature"] ?? "").trim().toLowerCase();
      if (!sigHeader) {
        return deny(403, "missing-hmac-signature");
      }
      const expected = computeRawBodyHmac(
        req.rawBody,
        secret,
        options.contribution.hmac.algorithm,
      ).toLowerCase();
      const expectedHexOnly = expected.slice(expected.indexOf("=") + 1);
      const valid =
        timingSafeStringEqual(sigHeader, expected) ||
        (options.contribution.hmac.mode === "standard-hex" &&
          timingSafeStringEqual(sigHeader, expectedHexOnly));
      if (!valid) {
        return deny(403, "raw-body-hmac-mismatch");
      }
    }

    // 4. Replay defense (300s sliding window + monotonic seq)
    for (const [key, seenAt] of seenKeys.entries()) {
      if (now - seenAt > windowMs) {
        seenKeys.delete(key);
      }
    }
    if (requireMonotonicSeq && req.seq !== undefined) {
      if (req.seq <= lastAcceptedSeq) {
        return deny(409, `replay-non-monotonic-seq:${req.seq}<=${lastAcceptedSeq}`);
      }
      lastAcceptedSeq = req.seq;
    }
    if (req.replayKey) {
      if (seenKeys.has(req.replayKey)) {
        return deny(409, `replay-duplicate-key:${req.replayKey}`);
      }
      seenKeys.set(req.replayKey, now);
    }

    return {
      allowed: true,
      status: 200,
      reason: "verified",
      headers: baseHeaders,
    };
  };

  return {
    verify,
    resetState: () => {
      requestTimestamps = [];
      seenKeys.clear();
      lastAcceptedSeq = -1;
    },
  };
}

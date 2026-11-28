// @effect-diagnostics nodeBuiltinImport:off -- NapCatChannelService hashes raw webhook payloads and validates loopback IP literals via node:crypto and node:net.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as PluginKernel from "@bytedock/plugin-kernel";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { assertPluginSecretRefAllowed } from "../secrets/SecretResolver.ts";
import type { BotsCoreService } from "./BotsCoreService.ts";

export class NapCatChannelError extends Schema.TaggedError<NapCatChannelError>()(
  "NapCatChannelError",
  {
    message: Schema.String,
  },
) {}

function parseUrlSafe(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function parseJsonSafe(
  rawText: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawText) };
  } catch {
    return { ok: false };
  }
}

function encodeJsonPayload(payload: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(payload);
}

export const NAPCAT_PLUGIN_ID = "community.napcat-qq";
const NAPCAT_SECRET_NAMESPACE = "bytedock.napcat";
const DEFAULT_WEBHOOK_ROUTE = "/api/plugins/community.napcat-qq/onebot/event";
const DEFAULT_SECRET_REF = "bytedock.napcat.webhook_token";
const DEFAULT_ONEBOT_BASE_URL = "http://127.0.0.1:3000";
const REPLAY_CLOCK_SKEW_SEC = 300;
const MAX_ACTIVITY_ENTRIES = 100;
const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_THREAD_DISPATCHES = 4;
const STRICT_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface BotBindableThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface BotsThreadDispatchOutcome {
  readonly runId: string;
  readonly delivery: string;
  readonly status: string;
  readonly timedOut: boolean;
  readonly replyText: string | null;
}

export interface BotsThreadBridge {
  readonly listThreads: () => Effect.Effect<ReadonlyArray<BotBindableThread>>;
  readonly sendAndWait: (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly text: string;
    readonly timeoutMs: number;
  }) => Effect.Effect<BotsThreadDispatchOutcome, NapCatChannelError>;
}

export interface NapCatActivityEntry {
  readonly id: string;
  readonly at: string;
  readonly direction: "inbound" | "outbound" | "diagnostic";
  readonly kind: string;
  readonly summary: string;
  readonly ok: boolean;
  readonly chatType?: "private" | "group" | undefined;
  readonly senderId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly botId?: string | undefined;
  readonly threadId?: string | undefined;
}

export interface NapCatWebhookResult {
  readonly status: 200 | 202 | 400 | 401 | 403 | 409 | 413 | 429 | 503;
  readonly body: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface NapCatStatusSnapshot {
  readonly pluginId: typeof NAPCAT_PLUGIN_ID;
  readonly endpointMode: "loopback-only";
  readonly oneBotBaseUrl: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly webhookRoute: string;
  readonly webhookAuthMode: "onebot-hmac" | "hmac-and-bearer";
  readonly rateLimitPerMin: number;
  readonly tokenSecretRef: string;
  readonly secretConfigured: boolean;
  readonly secretStoreAvailable: boolean;
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly allowedGroupIds: ReadonlyArray<string>;
  readonly requireAtInGroup: boolean;
  readonly allowlistConfigured: boolean;
  readonly threadBridgeReady: boolean;
  readonly recentActivity: ReadonlyArray<NapCatActivityEntry>;
}

export interface NapCatChannelService {
  readonly syncConfig: (input: {
    readonly napcatConfig: Readonly<Record<string, unknown>>;
    readonly botsConfig: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<void>;
  readonly setThreadBridge: (bridge: BotsThreadBridge | undefined) => void;
  readonly getThreadBridge: () => BotsThreadBridge | undefined;
  readonly getConfig: () => NormalizedNapCatConfig;
  readonly hasConfiguredSecret: () => Effect.Effect<boolean>;
  readonly getStatus: () => Effect.Effect<NapCatStatusSnapshot>;
  readonly setTokenSecret: (
    token: string,
  ) => Effect.Effect<{ readonly configured: true; readonly secretRef: string }, NapCatChannelError>;
  readonly clearTokenSecret: () => Effect.Effect<
    { readonly configured: false; readonly secretRef: string },
    NapCatChannelError
  >;
  readonly handleWebhook: (input: {
    readonly route: string;
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly pluginEnabled: boolean;
  }) => Effect.Effect<NapCatWebhookResult>;
  readonly testConnection: () => Effect.Effect<
    {
      readonly ok: boolean;
      readonly url: string;
      readonly status?: number | undefined;
      readonly loginInfo?: Readonly<Record<string, unknown>> | undefined;
      readonly error?: string | undefined;
    },
    never
  >;
  readonly sendReply: (input: {
    readonly chatType: "private" | "group";
    readonly targetId: string;
    readonly text: string;
  }) => Effect.Effect<
    {
      readonly ok: boolean;
      readonly status?: number | undefined;
      readonly error?: string | undefined;
    },
    never
  >;
  readonly simulateInbound: (input: {
    readonly chatType: "private" | "group";
    readonly userId: string;
    readonly groupId?: string | undefined;
    readonly text: string;
    readonly mentionedBot?: boolean | undefined;
    readonly botId?: string | undefined;
    readonly waitForDispatch?: boolean | undefined;
  }) => Effect.Effect<
    {
      readonly accepted: boolean;
      readonly reason: string;
      readonly replyText?: string | undefined;
      readonly botId?: string | undefined;
      readonly threadId?: string | undefined;
      readonly dispatch?: BotsThreadDispatchOutcome | undefined;
    },
    NapCatChannelError
  >;
}

interface NormalizedNapCatConfig {
  readonly endpointMode: "loopback-only";
  readonly oneBotBaseUrl: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly rateLimitPerMin: number;
  readonly webhookRoute: string;
  readonly webhookAuthMode: "onebot-hmac" | "hmac-and-bearer";
  readonly tokenSecretRef: string;
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly allowedGroupIds: ReadonlyArray<string>;
  readonly requireAtInGroup: boolean;
}

interface NormalizedBotsReplyConfig {
  readonly autoReplyEnabled: boolean;
  readonly replyMaxChars: number;
  readonly turnWaitTimeoutSec: number;
}

interface ParsedOneBotMessage {
  readonly chatType: "private" | "group";
  readonly userId: string;
  readonly groupId?: string | undefined;
  readonly selfId?: string | undefined;
  readonly text: string;
  readonly mentionedBot: boolean;
}

const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

function isoFromMs(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isLoopbackIpLiteral(ipRaw: string): boolean {
  const ip = normalizeHost(ipRaw);
  if (ip.startsWith("::ffff:")) {
    return isLoopbackIpLiteral(ip.slice("::ffff:".length));
  }
  if (NodeNet.isIPv4(ip)) {
    return ip.startsWith("127.");
  }
  if (NodeNet.isIPv6(ip)) {
    return ip === "::1";
  }
  return false;
}

function toStringArray(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeNapCatConfig(raw: Readonly<Record<string, unknown>>): NormalizedNapCatConfig {
  const allowedHosts = toStringArray(raw.allowedHosts);
  return {
    endpointMode: "loopback-only",
    oneBotBaseUrl:
      typeof raw.oneBotBaseUrl === "string" && raw.oneBotBaseUrl.trim().length > 0
        ? raw.oneBotBaseUrl.trim().replace(/\/+$/, "")
        : DEFAULT_ONEBOT_BASE_URL,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : ["127.0.0.1", "localhost", "::1"],
    rateLimitPerMin:
      typeof raw.rateLimitPerMin === "number" &&
      Number.isFinite(raw.rateLimitPerMin) &&
      raw.rateLimitPerMin >= 1
        ? Math.min(600, Math.trunc(raw.rateLimitPerMin))
        : 50,
    webhookRoute:
      typeof raw.webhookRoute === "string" && raw.webhookRoute.trim().length > 0
        ? raw.webhookRoute.trim()
        : DEFAULT_WEBHOOK_ROUTE,
    webhookAuthMode: raw.webhookAuthMode === "hmac-and-bearer" ? "hmac-and-bearer" : "onebot-hmac",
    tokenSecretRef:
      typeof raw.tokenSecretRef === "string" && raw.tokenSecretRef.trim().length > 0
        ? raw.tokenSecretRef.trim()
        : DEFAULT_SECRET_REF,
    allowedUserIds: toStringArray(raw.allowedUserIds),
    allowedGroupIds: toStringArray(raw.allowedGroupIds),
    requireAtInGroup: raw.requireAtInGroup !== false,
  };
}

function normalizeBotsReplyConfig(
  raw: Readonly<Record<string, unknown>>,
): NormalizedBotsReplyConfig {
  return {
    autoReplyEnabled: raw.autoReplyEnabled !== false,
    replyMaxChars:
      typeof raw.replyMaxChars === "number" && Number.isFinite(raw.replyMaxChars)
        ? Math.max(200, Math.min(4000, Math.trunc(raw.replyMaxChars)))
        : 1500,
    turnWaitTimeoutSec:
      typeof raw.turnWaitTimeoutSec === "number" && Number.isFinite(raw.turnWaitTimeoutSec)
        ? Math.max(15, Math.min(600, Math.trunc(raw.turnWaitTimeoutSec)))
        : 120,
  };
}

function parsePositiveIntId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return String(raw);
  }
  if (typeof raw === "string" && /^[1-9]\d{0,15}$/.test(raw.trim())) {
    return raw.trim();
  }
  return undefined;
}

function parseOneBotMessageEvent(
  event: Readonly<Record<string, unknown>>,
): ParsedOneBotMessage | null {
  if (event.post_type !== "message") return null;
  const chatType =
    event.message_type === "group" ? "group" : event.message_type === "private" ? "private" : null;
  if (!chatType) return null;

  const userId = parsePositiveIntId(event.user_id);
  if (!userId) return null;
  const groupId = chatType === "group" ? parsePositiveIntId(event.group_id) : undefined;
  if (chatType === "group" && !groupId) return null;
  const selfId = parsePositiveIntId(event.self_id);

  let mentionedBot = false;
  let textParts: Array<string> = [];

  if (Array.isArray(event.message)) {
    for (const seg of event.message) {
      if (!seg || typeof seg !== "object" || Array.isArray(seg)) continue;
      const item = seg as { readonly type?: unknown; readonly data?: Record<string, unknown> };
      if (item.type === "at") {
        const qq = item.data?.qq !== undefined ? String(item.data.qq).trim() : "";
        if (selfId && qq === selfId) {
          mentionedBot = true;
        }
      } else if (item.type === "text" && typeof item.data?.text === "string") {
        textParts.push(item.data.text);
      }
    }
  } else {
    const rawText =
      typeof event.raw_message === "string"
        ? event.raw_message
        : typeof event.message === "string"
          ? event.message
          : "";
    const cqAtRe = /\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]/gi;
    let match: RegExpExecArray | null;
    while ((match = cqAtRe.exec(rawText)) !== null) {
      const qq = match[1]?.trim() ?? "";
      if (selfId && qq === selfId) {
        mentionedBot = true;
      }
    }
    const stripped = rawText.replace(cqAtRe, " ").trim();
    textParts = [stripped];
  }

  let cleanText = textParts.join(" ").replace(/\s+/g, " ").trim();
  if (/^@bot(?:\s|$)/i.test(cleanText)) {
    mentionedBot = true;
    cleanText = cleanText.replace(/^@bot\s*/i, "").trim();
  }

  return {
    chatType,
    userId,
    ...(groupId ? { groupId } : {}),
    ...(selfId ? { selfId } : {}),
    text: cleanText,
    mentionedBot,
  };
}

function truncateReply(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(20, maxChars - 16)).trimEnd()}\n... [truncated]`;
}

/**
 * Runtime service for community.napcat-qq bridging hardened loopback OneBot v11 webhooks,
 * ServerSecretStore secrets in the `bytedock.napcat` namespace, BotsCoreService,
 * ThreadManagementService, and Egress-Guard-audited loopback OneBot HTTP API replies.
 */
export const makeNapCatChannelService = Effect.fn("NapCatChannelService.make")(function* (options: {
  readonly kernel: PluginKernel.PluginKernelService;
  readonly botsCore: BotsCoreService;
  readonly secretStore?: ServerSecretStore["Service"] | undefined;
  readonly hasControlPlaneApproval: (requestId: string) => Effect.Effect<boolean>;
  readonly emitEvent: (
    kind: string,
    payload: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
}) {
  const serviceScope = yield* Scope.Scope;
  const dispatchSemaphore = yield* Semaphore.make(MAX_CONCURRENT_THREAD_DISPATCHES);
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  let config = normalizeNapCatConfig(PluginKernel.getDefaultPluginConfig(NAPCAT_PLUGIN_ID));
  let botsReplyConfig = normalizeBotsReplyConfig(
    PluginKernel.getDefaultPluginConfig("builtin.bots-core"),
  );
  let cachedSecret: string | undefined;
  let cachedSecretRef = config.tokenSecretRef;
  let threadBridge: BotsThreadBridge | undefined;
  let activity: Array<NapCatActivityEntry> = [];

  const buildGuard = () =>
    PluginKernel.createWebhookRouteGuard({
      contribution: {
        route: config.webhookRoute,
        auth: "token",
        tokenSecretRef: config.tokenSecretRef,
        hmac: {
          algorithm: "sha1",
          mode: "onebot-custom",
          rawBody: true,
        },
        replayDefense: {
          windowSeconds: REPLAY_CLOCK_SKEW_SEC,
          requireMonotonicSeq: true,
        },
        rateLimitPerMin: config.rateLimitPerMin,
        frameOptions: "DENY",
      },
      requireBearer: config.webhookAuthMode === "hmac-and-bearer",
      acceptedHmacAlgorithms: ["sha1", "sha256"],
      resolveSecret: (ref) => (ref === cachedSecretRef ? cachedSecret : undefined),
    });

  let webhookGuard = buildGuard();

  const recordActivity = Effect.fn("NapCatChannelService.recordActivity")(function* (
    entry: Omit<NapCatActivityEntry, "id" | "at">,
  ) {
    const nowIso = isoFromMs(yield* Clock.currentTimeMillis);
    const full: NapCatActivityEntry = {
      id: `nc-${NodeCrypto.randomBytes(4).toString("hex")}`,
      at: nowIso,
      ...entry,
    };
    activity = [full, ...activity].slice(0, MAX_ACTIVITY_ENTRIES);
    yield* options.emitEvent("napcat-event", {
      eventId: full.id,
      direction: full.direction,
      kind: full.kind,
      ok: full.ok,
    });
    return full;
  });

  const validateSecretRef = (secretRef: string) =>
    assertPluginSecretRefAllowed({
      pluginId: NAPCAT_PLUGIN_ID,
      declaredNamespaces: [NAPCAT_SECRET_NAMESPACE],
      secretRef,
    }).pipe(
      Effect.mapError(
        (err) =>
          new NapCatChannelError({
            message: `NapCatQQ secretRef "${err.secretRef}" denied (${err.reason}). Allowed namespace: ${NAPCAT_SECRET_NAMESPACE}.`,
          }),
      ),
    );

  const hydrateSecretFromStore = Effect.fn("NapCatChannelService.hydrateSecretFromStore")(
    function* (secretRef: string) {
      if (!options.secretStore) {
        if (cachedSecretRef !== secretRef) {
          cachedSecret = undefined;
          cachedSecretRef = secretRef;
        }
        return cachedSecret;
      }
      const checked = yield* validateSecretRef(secretRef).pipe(Effect.option);
      if (Option.isNone(checked)) {
        cachedSecret = undefined;
        cachedSecretRef = secretRef;
        return undefined;
      }
      const stored = yield* options.secretStore
        .get(secretRef)
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      cachedSecretRef = secretRef;
      if (Option.isSome(stored)) {
        const decoded = new TextDecoder().decode(stored.value).trim();
        cachedSecret = decoded.length > 0 ? decoded : undefined;
      } else {
        cachedSecret = undefined;
      }
      return cachedSecret;
    },
  );

  // Hydrate initial token on boot if present in ServerSecretStore.
  yield* hydrateSecretFromStore(config.tokenSecretRef);

  const syncConfig: NapCatChannelService["syncConfig"] = Effect.fn(
    "NapCatChannelService.syncConfig",
  )(function* (input) {
    const prev = config;
    config = normalizeNapCatConfig(input.napcatConfig);
    botsReplyConfig = normalizeBotsReplyConfig(input.botsConfig);
    if (prev.tokenSecretRef !== config.tokenSecretRef) {
      yield* hydrateSecretFromStore(config.tokenSecretRef);
    }
    if (
      prev.webhookRoute !== config.webhookRoute ||
      prev.rateLimitPerMin !== config.rateLimitPerMin ||
      prev.webhookAuthMode !== config.webhookAuthMode ||
      prev.tokenSecretRef !== config.tokenSecretRef
    ) {
      webhookGuard = buildGuard();
    }
  });

  const validateAndAuditOutboundUrl = Effect.fn("NapCatChannelService.validateAndAuditOutboundUrl")(
    function* (pathSuffix: string) {
      const fullUrl = `${config.oneBotBaseUrl}${pathSuffix}`;
      const parsed = parseUrlSafe(fullUrl);
      if (!parsed) {
        return { ok: false as const, url: fullUrl, error: "Invalid OneBot base URL." };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          ok: false as const,
          url: fullUrl,
          error: `Unsupported OneBot protocol "${parsed.protocol}".`,
        };
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        return {
          ok: false as const,
          url: fullUrl,
          error: "OneBot URL must not contain credentials, query strings, or fragments.",
        };
      }
      const host = normalizeHost(parsed.hostname);
      if (config.endpointMode === "loopback-only" && !STRICT_LOOPBACK_HOSTS.has(host)) {
        return {
          ok: false as const,
          url: fullUrl,
          error: `Outbound OneBot host "${host}" rejected by loopback-only policy.`,
        };
      }
      if (host === "localhost") {
        const lookup = yield* Effect.tryPromise({
          try: () => options.kernel.egress.guardedLookupAll("localhost"),
          catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(Effect.option);
        if (
          Option.isNone(lookup) ||
          lookup.value.length === 0 ||
          lookup.value.some((addr) => !isLoopbackIpLiteral(addr.address))
        ) {
          return {
            ok: false as const,
            url: fullUrl,
            error: 'DNS verification for "localhost" returned non-loopback address.',
          };
        }
      }

      const egressVerdict = options.kernel.egress.evaluateRequest({
        pluginId: NAPCAT_PLUGIN_ID,
        url: fullUrl,
        method: "POST",
      });
      if (!egressVerdict.allowed) {
        return {
          ok: false as const,
          url: fullUrl,
          error: `Blocked by Egress Guard (${egressVerdict.reason}).`,
        };
      }

      const activeRev = (yield* options.kernel.revisions.active()).rev;
      const hookVerdict = yield* options.kernel.hooks.runEgressBefore({
        host,
        port: egressVerdict.port,
        protocol: parsed.protocol,
        revision: activeRev,
      });
      if (!hookVerdict.allowed) {
        return {
          ok: false as const,
          url: fullUrl,
          error: `Blocked by egress.request.before hook (${hookVerdict.reason ?? "denied"}).`,
        };
      }

      return { ok: true as const, url: fullUrl };
    },
  );

  const postOneBotApi = Effect.fn("NapCatChannelService.postOneBotApi")(function* (
    pathSuffix: string,
    payload: Readonly<Record<string, unknown>>,
  ) {
    const target = yield* validateAndAuditOutboundUrl(pathSuffix);
    if (!target.ok) {
      return { ok: false as const, url: target.url, error: target.error };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cachedSecret) {
      headers.Authorization = `Bearer ${cachedSecret}`;
    }
    const encodedBody = encodeJsonPayload(payload);
    const responseResult = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetchFn(target.url, {
          method: "POST",
          headers,
          body: encodedBody,
          redirect: "error",
          signal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS),
        });
        const text = await res.text();
        const parsedRes = parseJsonSafe(text);
        return {
          status: res.status,
          ok: res.ok,
          json: parsedRes.ok ? parsedRes.value : undefined,
          text,
        };
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    }).pipe(Effect.result);

    if (responseResult._tag === "Failure") {
      return { ok: false as const, url: target.url, error: responseResult.failure };
    }
    const res = responseResult.success;
    if (!res.ok) {
      return {
        ok: false as const,
        url: target.url,
        status: res.status,
        error: `OneBot HTTP ${res.status}`,
      };
    }
    if (res.json && typeof res.json === "object" && !Array.isArray(res.json)) {
      const obj = res.json as Readonly<Record<string, unknown>>;
      const statusStr = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
      const retcode = typeof obj.retcode === "number" ? obj.retcode : undefined;
      if (statusStr === "failed" || (retcode !== undefined && retcode !== 0 && retcode !== 1)) {
        const detail =
          typeof obj.message === "string" && obj.message.trim()
            ? obj.message.trim()
            : typeof obj.wording === "string" && obj.wording.trim()
              ? obj.wording.trim()
              : `retcode=${retcode ?? "unknown"}`;
        return {
          ok: false as const,
          url: target.url,
          status: res.status,
          error: `OneBot API rejected (${detail})`,
        };
      }
    }
    return {
      ok: true as const,
      url: target.url,
      status: res.status,
      json: res.json,
    };
  });

  const sendReply: NapCatChannelService["sendReply"] = Effect.fn("NapCatChannelService.sendReply")(
    function* (input) {
      const numericId = Number.parseInt(input.targetId.trim(), 10);
      if (
        !/^[1-9]\d{0,15}$/.test(input.targetId.trim()) ||
        !Number.isSafeInteger(numericId) ||
        numericId <= 0
      ) {
        return { ok: false as const, error: `Invalid OneBot target id "${input.targetId}".` };
      }
      const message = truncateReply(input.text, botsReplyConfig.replyMaxChars);
      if (!message) {
        return { ok: false as const, error: "Outbound reply message cannot be empty." };
      }
      const endpoint = input.chatType === "group" ? "/send_group_msg" : "/send_private_msg";
      const body =
        input.chatType === "group"
          ? { group_id: numericId, message }
          : { user_id: numericId, message };
      const outcome = yield* postOneBotApi(endpoint, body);
      yield* recordActivity({
        direction: "outbound",
        kind: endpoint.slice(1),
        summary: outcome.ok
          ? `Sent ${input.chatType} reply (${message.length} chars)`
          : `Reply failed: ${outcome.error}`,
        ok: outcome.ok,
        chatType: input.chatType,
        ...(input.chatType === "group"
          ? { groupId: input.targetId }
          : { senderId: input.targetId }),
      });
      return outcome.ok
        ? { ok: true as const, status: outcome.status }
        : {
            ok: false as const,
            ...(outcome.status !== undefined ? { status: outcome.status } : {}),
            error: outcome.error,
          };
    },
  );

  const deliverReplyBestEffort = (msg: ParsedOneBotMessage, text: string) => {
    if (!botsReplyConfig.autoReplyEnabled) {
      return Effect.void;
    }
    const targetId = msg.chatType === "group" ? msg.groupId! : msg.userId;
    return sendReply({ chatType: msg.chatType, targetId, text }).pipe(Effect.asVoid);
  };

  const handleBotCommand = Effect.fn("NapCatChannelService.handleBotCommand")(function* (
    msg: ParsedOneBotMessage,
    preferredBotId?: string | undefined,
  ) {
    const trimmed = msg.text.trim();
    const bot = options.botsCore.getDefaultOrActiveBot(preferredBotId);

    if (/^\/status(?:\s|$)/i.test(trimmed)) {
      const summary = options.botsCore.getSummary();
      const lines = [
        `ByteDock Bots: ${summary.activeBotCount}/${summary.botCount} active`,
        `Active bot: ${bot ? `${bot.name} (${bot.id})` : "none"}`,
        `Bound thread: ${bot?.boundThreadId ?? "unbound"}`,
        `Pending Decision Gates: ${summary.pendingDecisionGates}`,
      ];
      return { handled: true as const, replyText: lines.join("\n"), botId: bot?.id };
    }

    if (/^\/gates(?:\s|$)/i.test(trimmed)) {
      const pending = options.botsCore.listGates("pending");
      if (pending.length === 0) {
        return {
          handled: true as const,
          replyText: "No pending Bot Decision Gates.",
          botId: bot?.id,
        };
      }
      const lines = pending.slice(0, 10).map((g) => `- ${g.gateId}: ${g.title} (bot=${g.botId})`);
      return {
        handled: true as const,
        replyText: `Pending Bot Decision Gates (${pending.length}):\n${lines.join("\n")}\nReply /approve <gateId> or /reject <gateId>.`,
        botId: bot?.id,
      };
    }

    const decisionMatch = /^\/(approve|reject)\s+(\S+)(?:\s+(.+))?$/i.exec(trimmed);
    if (decisionMatch) {
      const action = decisionMatch[1]!.toLowerCase() === "approve" ? "approved" : "rejected";
      const gateId = decisionMatch[2]!.trim();
      const note = decisionMatch[3]?.trim();

      const existingGate = options.botsCore.listGates().find((g) => g.gateId === gateId);
      if (!existingGate) {
        const isPrivilegedApproval = yield* options.hasControlPlaneApproval(gateId);
        if (isPrivilegedApproval || /^apr[-_]/i.test(gateId) || /^req[-_]/i.test(gateId)) {
          return {
            handled: true as const,
            replyText:
              "Privileged host Control Plane approvals cannot be resolved via QQ. Please review and approve directly in ByteDock Control Center.",
            botId: bot?.id,
          };
        }
        return {
          handled: true as const,
          replyText: `Bot Decision Gate "${gateId}" was not found.`,
          botId: bot?.id,
        };
      }

      const resolved = yield* options.botsCore
        .resolveGate({
          gateId,
          decision: action,
          resolvedBy: `qq:${msg.userId}`,
          resolvedVia: NAPCAT_PLUGIN_ID,
          note,
        })
        .pipe(Effect.result);

      if (resolved._tag === "Failure") {
        return {
          handled: true as const,
          replyText: `Failed to resolve gate "${gateId}": ${resolved.failure.message}`,
          botId: existingGate.botId,
        };
      }

      return {
        handled: true as const,
        replyText: `Bot Decision Gate "${gateId}" marked as ${resolved.success.status}.`,
        botId: resolved.success.botId,
      };
    }

    const memoryMatch = /^\/memory\s+(.+)$/i.exec(trimmed);
    if (memoryMatch?.[1]) {
      if (!bot) {
        return { handled: true as const, replyText: "No active bot available." };
      }
      const res = yield* options.botsCore
        .appendMemory({
          botId: bot.id,
          entry: memoryMatch[1].trim(),
          source: `qq:${msg.userId}`,
        })
        .pipe(Effect.result);
      if (res._tag === "Failure") {
        return {
          handled: true as const,
          replyText: `Failed to append MEMORY.md: ${res.failure.message}`,
          botId: bot.id,
        };
      }
      return {
        handled: true as const,
        replyText: `Appended to ${bot.id}/MEMORY.md (total lines: ${res.success.memoryLineCount}).`,
        botId: bot.id,
      };
    }

    return { handled: false as const, botId: bot?.id };
  });

  const runThreadDispatchTask = Effect.fn("NapCatChannelService.runThreadDispatchTask")(
    function* (input: {
      readonly botId: string;
      readonly projectId: string;
      readonly threadId: string;
      readonly msg: ParsedOneBotMessage;
      readonly deliverReply: boolean;
    }) {
      const bridge = threadBridge;
      if (!bridge) {
        return undefined;
      }
      return yield* dispatchSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const prompt = `[QQ ${input.msg.chatType} user=${input.msg.userId}${input.msg.groupId ? ` group=${input.msg.groupId}` : ""}] ${input.msg.text}`;
          const result = yield* bridge
            .sendAndWait({
              projectId: input.projectId,
              threadId: input.threadId,
              text: prompt,
              timeoutMs: botsReplyConfig.turnWaitTimeoutSec * 1_000,
            })
            .pipe(Effect.result);

          if (result._tag === "Failure") {
            const errReply = `ByteDock thread dispatch failed: ${result.failure.message}`;
            yield* recordActivity({
              direction: "inbound",
              kind: "thread-dispatch-error",
              summary: errReply,
              ok: false,
              chatType: input.msg.chatType,
              senderId: input.msg.userId,
              groupId: input.msg.groupId,
              botId: input.botId,
              threadId: input.threadId,
            });
            if (input.deliverReply) {
              yield* deliverReplyBestEffort(input.msg, errReply);
            }
            return undefined;
          }

          const outcome = result.success;
          const replyText = outcome.replyText?.trim()
            ? outcome.replyText.trim()
            : outcome.timedOut
              ? `Task is still running on ByteDock thread ${input.threadId} (run ${outcome.runId}).`
              : `ByteDock thread ${input.threadId} finished with status "${outcome.status}".`;

          const memoryNote = `QQ ${input.msg.chatType} (${input.msg.userId}): "${input.msg.text.slice(0, 120)}" -> ${replyText.slice(0, 180)}`;
          yield* options.botsCore
            .appendMemory({
              botId: input.botId,
              entry: memoryNote,
              source: NAPCAT_PLUGIN_ID,
            })
            .pipe(Effect.ignore);

          yield* recordActivity({
            direction: "inbound",
            kind: "thread-dispatch-complete",
            summary: `Run ${outcome.runId} (${outcome.status}) replied to QQ ${input.msg.chatType}`,
            ok: !outcome.timedOut && outcome.status === "completed",
            chatType: input.msg.chatType,
            senderId: input.msg.userId,
            groupId: input.msg.groupId,
            botId: input.botId,
            threadId: input.threadId,
          });

          if (input.deliverReply) {
            yield* deliverReplyBestEffort(input.msg, replyText);
          }

          return outcome;
        }),
      );
    },
  );

  const handleWebhook: NapCatChannelService["handleWebhook"] = Effect.fn(
    "NapCatChannelService.handleWebhook",
  )(function* (input) {
    // 1. Check enabled & secret availability BEFORE guard so unconfigured traffic cannot drain rate-limit tokens.
    if (!input.pluginEnabled) {
      return {
        status: 503 as const,
        body: { ok: false, error: "plugin_disabled" },
        headers: BASE_SECURITY_HEADERS,
      };
    }
    if (!cachedSecret) {
      yield* hydrateSecretFromStore(config.tokenSecretRef);
    }
    if (!cachedSecret) {
      return {
        status: 503 as const,
        body: { ok: false, error: "webhook_secret_unconfigured" },
        headers: BASE_SECURITY_HEADERS,
      };
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const rawBodyHash = NodeCrypto.createHash("sha256").update(input.rawBody).digest("hex");
    const seqHeader =
      input.headers["x-bytedock-seq"] ?? input.headers["X-ByteDock-Seq"] ?? undefined;
    const parsedSeq =
      seqHeader !== undefined && /^\d+$/.test(seqHeader.trim())
        ? Number.parseInt(seqHeader.trim(), 10)
        : undefined;

    // 2. Enforce raw-body HMAC / Bearer / payload freshness / replay / rate-limit guard atomically.
    let parsedEvent: Record<string, unknown> | null = null;
    const guardOutcome = webhookGuard.verify({
      route: input.route,
      rawBody: input.rawBody,
      headers: input.headers,
      replayKey: rawBodyHash,
      ...(parsedSeq !== undefined ? { seq: parsedSeq } : {}),
      nowMs,
      validateBeforeCommit: () => {
        const parsedAttempt = parseJsonSafe(input.rawBody.toString("utf8"));
        if (!parsedAttempt.ok) {
          return { ok: false, status: 400, reason: "invalid_json" };
        }
        const rawVal = parsedAttempt.value;
        if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) {
          return { ok: false, status: 400, reason: "invalid_onebot_payload" };
        }
        const obj = rawVal as Record<string, unknown>;
        if (typeof obj.time !== "number" || !Number.isFinite(obj.time)) {
          return { ok: false, status: 400, reason: "missing_onebot_time" };
        }
        const nowSec = Math.floor(nowMs / 1_000);
        if (Math.abs(nowSec - obj.time) > REPLAY_CLOCK_SKEW_SEC) {
          return { ok: false, status: 409, reason: "replay-window-expired" };
        }
        parsedEvent = obj;
        return { ok: true };
      },
    });
    if (!guardOutcome.allowed) {
      yield* recordActivity({
        direction: "inbound",
        kind: "webhook-rejected",
        summary: `HTTP ${guardOutcome.status} ${guardOutcome.reason}`,
        ok: false,
      });
      return {
        status: guardOutcome.status,
        body: { ok: false, error: guardOutcome.reason },
        headers: guardOutcome.headers,
      };
    }

    const event = parsedEvent!;

    const postType = typeof event.post_type === "string" ? event.post_type : "unknown";
    if (postType !== "message") {
      return {
        status: 200 as const,
        body: { ok: true, accepted: true, ignored: postType },
        headers: guardOutcome.headers,
      };
    }

    const msg = parseOneBotMessageEvent(event);
    if (!msg) {
      return {
        status: 200 as const,
        body: { ok: true, accepted: false, reason: "unsupported-message-event" },
        headers: guardOutcome.headers,
      };
    }

    // 4. Fail-closed allowlist enforcement on live webhook traffic.
    if (config.allowedUserIds.length === 0) {
      yield* recordActivity({
        direction: "inbound",
        kind: "allowlist-blocked",
        summary: `Blocked ${msg.chatType} message: allowedUserIds is empty (fail-closed)`,
        ok: false,
        chatType: msg.chatType,
        senderId: msg.userId,
        groupId: msg.groupId,
      });
      return {
        status: 200 as const,
        body: { ok: true, accepted: false, reason: "allowlist-empty" },
        headers: guardOutcome.headers,
      };
    }
    if (!config.allowedUserIds.includes(msg.userId)) {
      yield* recordActivity({
        direction: "inbound",
        kind: "allowlist-blocked",
        summary: `Blocked unauthorized sender ${msg.userId}`,
        ok: false,
        chatType: msg.chatType,
        senderId: msg.userId,
        groupId: msg.groupId,
      });
      return {
        status: 200 as const,
        body: { ok: true, accepted: false, reason: "user-not-allowed" },
        headers: guardOutcome.headers,
      };
    }
    if (msg.chatType === "group") {
      if (!msg.groupId || !config.allowedGroupIds.includes(msg.groupId)) {
        yield* recordActivity({
          direction: "inbound",
          kind: "allowlist-blocked",
          summary: `Blocked unauthorized group ${msg.groupId ?? "unknown"}`,
          ok: false,
          chatType: msg.chatType,
          senderId: msg.userId,
          groupId: msg.groupId,
        });
        return {
          status: 200 as const,
          body: { ok: true, accepted: false, reason: "group-not-allowed" },
          headers: guardOutcome.headers,
        };
      }
      if (config.requireAtInGroup && !msg.mentionedBot) {
        return {
          status: 200 as const,
          body: { ok: true, accepted: false, reason: "group-at-required" },
          headers: guardOutcome.headers,
        };
      }
    }

    if (!msg.text) {
      return {
        status: 200 as const,
        body: { ok: true, accepted: false, reason: "empty-message" },
        headers: guardOutcome.headers,
      };
    }

    // 5. Bot commands execute immediately.
    const cmdOutcome = yield* handleBotCommand(msg);
    if (cmdOutcome.handled) {
      yield* recordActivity({
        direction: "inbound",
        kind: "bot-command",
        summary: `${msg.text.slice(0, 60)} -> handled`,
        ok: true,
        chatType: msg.chatType,
        senderId: msg.userId,
        groupId: msg.groupId,
        botId: cmdOutcome.botId,
      });
      if (botsReplyConfig.autoReplyEnabled && cmdOutcome.replyText) {
        yield* Effect.forkIn(
          deliverReplyBestEffort(msg, cmdOutcome.replyText).pipe(Effect.ignore),
          serviceScope,
        );
      }
      return {
        status: 200 as const,
        body: {
          ok: true,
          accepted: true,
          commandHandled: true,
          replyText: cmdOutcome.replyText,
        },
        headers: guardOutcome.headers,
      };
    }

    // 6. Regular message -> dispatch into bound ByteDock thread on a bounded service-scoped fiber.
    const activeBot = options.botsCore.getDefaultOrActiveBot();
    if (!activeBot || !activeBot.enabled) {
      const reply = "No enabled ByteDock bot is available.";
      if (botsReplyConfig.autoReplyEnabled) {
        yield* Effect.forkIn(deliverReplyBestEffort(msg, reply).pipe(Effect.ignore), serviceScope);
      }
      return {
        status: 200 as const,
        body: { ok: true, accepted: false, reason: "no-active-bot", replyText: reply },
        headers: guardOutcome.headers,
      };
    }

    if (!activeBot.boundThreadId || !activeBot.boundProjectId) {
      const reply = `Bot "${activeBot.name}" is not bound to a ByteDock thread yet. Open ByteDock Control Center -> Bots & QQ to bind a thread.`;
      yield* recordActivity({
        direction: "inbound",
        kind: "bot-unbound",
        summary: `Received message for unbound bot "${activeBot.id}"`,
        ok: false,
        chatType: msg.chatType,
        senderId: msg.userId,
        groupId: msg.groupId,
        botId: activeBot.id,
      });
      if (botsReplyConfig.autoReplyEnabled) {
        yield* Effect.forkIn(deliverReplyBestEffort(msg, reply).pipe(Effect.ignore), serviceScope);
      }
      return {
        status: 200 as const,
        body: { ok: true, accepted: false, reason: "bot-thread-unbound", replyText: reply },
        headers: guardOutcome.headers,
      };
    }

    if (!threadBridge) {
      const reply = "ByteDock thread orchestration bridge is currently unavailable.";
      return {
        status: 503 as const,
        body: { ok: false, error: "thread_bridge_unavailable", replyText: reply },
        headers: guardOutcome.headers,
      };
    }

    yield* recordActivity({
      direction: "inbound",
      kind: "thread-dispatch-queued",
      summary: `Queued QQ ${msg.chatType} task for bot "${activeBot.id}"`,
      ok: true,
      chatType: msg.chatType,
      senderId: msg.userId,
      groupId: msg.groupId,
      botId: activeBot.id,
      threadId: activeBot.boundThreadId,
    });

    yield* Effect.forkIn(
      runThreadDispatchTask({
        botId: activeBot.id,
        projectId: activeBot.boundProjectId,
        threadId: activeBot.boundThreadId,
        msg,
        deliverReply: true,
      }).pipe(Effect.ignore),
      serviceScope,
    );

    return {
      status: 202 as const,
      body: {
        ok: true,
        accepted: true,
        queued: true,
        botId: activeBot.id,
        threadId: activeBot.boundThreadId,
      },
      headers: guardOutcome.headers,
    };
  });

  const setTokenSecret: NapCatChannelService["setTokenSecret"] = Effect.fn(
    "NapCatChannelService.setTokenSecret",
  )(function* (rawToken) {
    const token = rawToken.trim();
    if (token.length === 0 || token.length > 1024) {
      return yield* new NapCatChannelError({
        message: "NapCatQQ token secret must be 1 to 1024 characters.",
      });
    }
    const secretRef = config.tokenSecretRef;
    yield* validateSecretRef(secretRef);
    if (!options.secretStore) {
      return yield* new NapCatChannelError({
        message: "ServerSecretStore is unavailable on this ByteDock host.",
      });
    }
    yield* options.secretStore.set(secretRef, new TextEncoder().encode(token)).pipe(
      Effect.mapError(
        (err) =>
          new NapCatChannelError({
            message: `Failed to persist NapCatQQ secret: ${err.message}`,
          }),
      ),
    );
    cachedSecret = token;
    cachedSecretRef = secretRef;
    yield* recordActivity({
      direction: "diagnostic",
      kind: "secret-updated",
      summary: `Updated ServerSecretStore secret (${secretRef})`,
      ok: true,
    });
    return { configured: true as const, secretRef };
  });

  const clearTokenSecret: NapCatChannelService["clearTokenSecret"] = Effect.fn(
    "NapCatChannelService.clearTokenSecret",
  )(function* () {
    const secretRef = config.tokenSecretRef;
    yield* validateSecretRef(secretRef);
    if (options.secretStore) {
      yield* options.secretStore.remove(secretRef).pipe(
        Effect.mapError(
          (err) =>
            new NapCatChannelError({
              message: `Failed clearing NapCatQQ secret: ${err.message}`,
            }),
        ),
      );
    }
    cachedSecret = undefined;
    cachedSecretRef = secretRef;
    yield* recordActivity({
      direction: "diagnostic",
      kind: "secret-cleared",
      summary: `Cleared ServerSecretStore secret (${secretRef})`,
      ok: true,
    });
    return { configured: false as const, secretRef };
  });

  const testConnection: NapCatChannelService["testConnection"] = Effect.fn(
    "NapCatChannelService.testConnection",
  )(function* () {
    const res = yield* postOneBotApi("/get_login_info", {});
    const loginInfo =
      res.ok && res.json && typeof res.json === "object" && !Array.isArray(res.json)
        ? (res.json as Readonly<Record<string, unknown>>)
        : undefined;
    yield* recordActivity({
      direction: "diagnostic",
      kind: "connection-test",
      summary: res.ok
        ? `OneBot /get_login_info reachable (HTTP ${res.status})`
        : `OneBot /get_login_info failed: ${res.error}`,
      ok: res.ok,
    });
    return res.ok
      ? { ok: true, url: res.url, status: res.status, ...(loginInfo ? { loginInfo } : {}) }
      : {
          ok: false,
          url: res.url,
          ...(res.status !== undefined ? { status: res.status } : {}),
          error: res.error,
        };
  });

  const simulateInbound: NapCatChannelService["simulateInbound"] = Effect.fn(
    "NapCatChannelService.simulateInbound",
  )(function* (input) {
    const userId = parsePositiveIntId(input.userId);
    if (!userId) {
      return yield* new NapCatChannelError({
        message: "simulateInbound requires a positive numeric userId.",
      });
    }
    const groupId = input.chatType === "group" ? parsePositiveIntId(input.groupId) : undefined;
    if (input.chatType === "group" && !groupId) {
      return yield* new NapCatChannelError({
        message: "simulateInbound with chatType='group' requires a positive numeric groupId.",
      });
    }
    const text = input.text.trim();
    if (!text) {
      return yield* new NapCatChannelError({
        message: "simulateInbound requires non-empty text.",
      });
    }
    const msg: ParsedOneBotMessage = {
      chatType: input.chatType,
      userId,
      ...(groupId ? { groupId } : {}),
      text,
      mentionedBot: input.mentionedBot ?? input.chatType === "group",
    };

    const cmdOutcome = yield* handleBotCommand(msg, input.botId);
    if (cmdOutcome.handled) {
      yield* recordActivity({
        direction: "diagnostic",
        kind: "simulate-command",
        summary: `Simulated command "${text.slice(0, 60)}"`,
        ok: true,
        chatType: msg.chatType,
        senderId: msg.userId,
        groupId: msg.groupId,
        botId: cmdOutcome.botId,
      });
      return {
        accepted: true,
        reason: "command-handled",
        replyText: cmdOutcome.replyText,
        botId: cmdOutcome.botId,
      };
    }

    const bot = options.botsCore.getDefaultOrActiveBot(input.botId);
    if (!bot || !bot.enabled) {
      return {
        accepted: false,
        reason: "no-active-bot",
        replyText: "No enabled bot available.",
      };
    }
    if (!bot.boundThreadId || !bot.boundProjectId) {
      return {
        accepted: false,
        reason: "bot-thread-unbound",
        replyText: `Bot "${bot.name}" is not bound to any ByteDock thread yet.`,
        botId: bot.id,
      };
    }
    if (!threadBridge) {
      return {
        accepted: false,
        reason: "thread-bridge-unavailable",
        replyText: "Thread orchestration bridge is unavailable in this environment.",
        botId: bot.id,
        threadId: bot.boundThreadId,
      };
    }

    if (input.waitForDispatch !== false) {
      const dispatch = yield* runThreadDispatchTask({
        botId: bot.id,
        projectId: bot.boundProjectId,
        threadId: bot.boundThreadId,
        msg,
        deliverReply: false,
      });
      return {
        accepted: true,
        reason: "dispatched-and-completed",
        botId: bot.id,
        threadId: bot.boundThreadId,
        replyText: dispatch?.replyText ?? undefined,
        dispatch,
      };
    }

    yield* Effect.forkIn(
      runThreadDispatchTask({
        botId: bot.id,
        projectId: bot.boundProjectId,
        threadId: bot.boundThreadId,
        msg,
        deliverReply: false,
      }).pipe(Effect.ignore),
      serviceScope,
    );
    return {
      accepted: true,
      reason: "queued",
      botId: bot.id,
      threadId: bot.boundThreadId,
    };
  });

  const hasConfiguredSecret: NapCatChannelService["hasConfiguredSecret"] = Effect.fn(
    "NapCatChannelService.hasConfiguredSecret",
  )(function* () {
    if (!cachedSecret && options.secretStore) {
      yield* hydrateSecretFromStore(config.tokenSecretRef);
    }
    return cachedSecret !== undefined;
  });

  const getStatus: NapCatChannelService["getStatus"] = Effect.fn("NapCatChannelService.getStatus")(
    function* () {
      if (!cachedSecret && options.secretStore) {
        yield* hydrateSecretFromStore(config.tokenSecretRef);
      }
      return {
        pluginId: NAPCAT_PLUGIN_ID,
        endpointMode: config.endpointMode,
        oneBotBaseUrl: config.oneBotBaseUrl,
        allowedHosts: [...config.allowedHosts],
        webhookRoute: config.webhookRoute,
        webhookAuthMode: config.webhookAuthMode,
        rateLimitPerMin: config.rateLimitPerMin,
        tokenSecretRef: config.tokenSecretRef,
        secretConfigured: cachedSecret !== undefined,
        secretStoreAvailable: options.secretStore !== undefined,
        allowedUserIds: [...config.allowedUserIds],
        allowedGroupIds: [...config.allowedGroupIds],
        requireAtInGroup: config.requireAtInGroup,
        allowlistConfigured: config.allowedUserIds.length > 0,
        threadBridgeReady: threadBridge !== undefined,
        recentActivity: activity.slice(0, 30),
      };
    },
  );

  return {
    syncConfig,
    setThreadBridge: (bridge) => {
      threadBridge = bridge;
    },
    getThreadBridge: () => threadBridge,
    getConfig: () => config,
    hasConfiguredSecret,
    getStatus,
    setTokenSecret,
    clearTokenSecret,
    handleWebhook,
    testConnection,
    sendReply,
    simulateInbound,
  } satisfies NapCatChannelService;
});

// @effect-diagnostics nodeBuiltinImport:off -- Loopback address validation and command id generation use node:crypto and node:net.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requestUrl } from "../requestUrl.ts";
import {
  NAPCAT_PLUGIN_ID,
  NapCatChannelError,
  type BotBindableThread,
  type BotsThreadBridge,
} from "./NapCatChannelService.ts";
import * as PluginControlPlane from "./PluginControlPlane.ts";

const NAPCAT_ROUTE_PREFIX = "/api/plugins/community.napcat-qq";
const NAPCAT_HEALTH_ROUTE = `${NAPCAT_ROUTE_PREFIX}/health`;
const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const FORBIDDEN_FORWARD_HEADERS: ReadonlyArray<string> = [
  "origin",
  "x-forwarded-for",
  "forwarded",
  "cf-connecting-ip",
  "x-real-ip",
  "x-t3-relay-delivery-id",
];

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

function isLoopbackRemoteAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (cleaned === "127.0.0.1" || cleaned === "::1" || cleaned === "::ffff:127.0.0.1") {
    return true;
  }
  if (cleaned.startsWith("::ffff:")) {
    const v4 = cleaned.slice("::ffff:".length);
    return NodeNet.isIPv4(v4) && v4.startsWith("127.");
  }
  return NodeNet.isIPv4(cleaned) && cleaned.startsWith("127.");
}

function readSocketRemoteAddress(
  request: HttpServerRequest.HttpServerRequest,
  overrideRemoteAddress?: string | undefined,
): string | undefined {
  if (overrideRemoteAddress !== undefined) {
    return overrideRemoteAddress;
  }
  try {
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    if (incoming?.socket?.remoteAddress) {
      return incoming.socket.remoteAddress;
    }
  } catch {
    // Request may originate from a synthetic/non-Node adapter (e.g. Web handler).
  }
  if (Option.isSome(request.remoteAddress)) {
    return request.remoteAddress.value;
  }
  return undefined;
}

function normalizeRequestHeaders(
  request: HttpServerRequest.HttpServerRequest,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (lower === "cookie") continue;
    if (typeof value === "string") {
      out[lower] = value;
    }
  }
  return out;
}

function isLoopbackHostHeader(rawHostHeader: string | undefined): boolean {
  if (!rawHostHeader) return true;
  const trimmed = rawHostHeader.trim().toLowerCase();
  if (!trimmed) return true;
  let hostPart = trimmed;
  if (trimmed.startsWith("[")) {
    const endIdx = trimmed.indexOf("]");
    if (endIdx < 0) return false;
    hostPart = trimmed.slice(1, endIdx);
  } else {
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx >= 0) {
      hostPart = trimmed.slice(0, colonIdx);
    }
  }
  return hostPart === "localhost" || isLoopbackRemoteAddress(hostPart);
}

function checkLoopbackOriginAndProxy(
  request: HttpServerRequest.HttpServerRequest,
  headers: Readonly<Record<string, string | undefined>>,
  overrideRemoteAddress?: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (const forbidden of FORBIDDEN_FORWARD_HEADERS) {
    const val = headers[forbidden];
    if (typeof val === "string" && val.trim().length > 0) {
      return { ok: false, reason: `forbidden-header:${forbidden}` };
    }
  }
  if (!isLoopbackHostHeader(headers.host)) {
    return { ok: false, reason: `non-loopback-host:${headers.host ?? "unknown"}` };
  }
  const remoteAddress = readSocketRemoteAddress(request, overrideRemoteAddress);
  if (!isLoopbackRemoteAddress(remoteAddress)) {
    return { ok: false, reason: `non-loopback-remote:${remoteAddress ?? "unknown"}` };
  }
  return { ok: true };
}

function jsonResponse(
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders?: Readonly<Record<string, string>>,
) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/** Adapts ThreadManagementService into the decoupled BotsThreadBridge used by NapCatChannelService. */
function createThreadManagementBridge(
  threads: ThreadManagementService.ThreadManagementService["Service"],
): BotsThreadBridge {
  return {
    listThreads: () =>
      threads.listProjectThreads({ includeSubagents: false }).pipe(
        Effect.map((entries): ReadonlyArray<BotBindableThread> =>
          entries.slice(0, 100).map((entry) => ({
            threadId: entry.id,
            projectId: entry.projectId,
            title: entry.title,
            updatedAt: DateTime.formatIso(entry.updatedAt),
          })),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<BotBindableThread>),
      ),
    sendAndWait: Effect.fn("PluginWebhookHttp.sendAndWait")(function* (input) {
      const projectId = ProjectId.make(input.projectId);
      const threadId = ThreadId.make(input.threadId);
      const sent = yield* threads
        .sendToThread({
          projectId,
          threadId,
          commandId: CommandId.make(`cmd-napcat-${NodeCrypto.randomUUID()}`),
          messageId: MessageId.make(`msg-napcat-${NodeCrypto.randomUUID()}`),
          text: input.text,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new NapCatChannelError({
                message: err instanceof Error ? err.message : String(err),
              }),
          ),
        );

      const waited = yield* threads
        .waitForThread({
          projectId,
          threadId,
          runId: sent.run.id,
          timeoutMs: input.timeoutMs,
        })
        .pipe(
          Effect.mapError(
            (err) =>
              new NapCatChannelError({
                message: err instanceof Error ? err.message : String(err),
              }),
          ),
        );

      const targetRunId = waited.resultRun?.id ?? waited.run?.id ?? sent.run.id;
      let replyText: string | null = null;
      if (!waited.timedOut) {
        const projection = yield* threads.getThreadProjection(threadId).pipe(Effect.option);
        if (Option.isSome(projection)) {
          const matchingAssistantMessages = projection.value.messages.filter(
            (m) => m.role === "assistant" && m.runId === targetRunId && m.text.trim().length > 0,
          );
          const latest = matchingAssistantMessages[matchingAssistantMessages.length - 1];
          if (latest) {
            replyText = latest.text.trim();
          }
        }
      }

      return {
        runId: targetRunId,
        delivery: sent.delivery,
        status: waited.resultRun?.status ?? waited.run?.status ?? sent.run.status,
        timedOut: waited.timedOut,
        replyText,
      };
    }),
  };
}

/**
 * Builds the Effect HttpRouter route layer for community.napcat-qq:
 * - GET  /api/plugins/community.napcat-qq/health (minimal non-secret status, loopback-only)
 * - POST /api/plugins/community.napcat-qq/*      (strict pathname match to active config.webhookRoute)
 */
export function makePluginWebhookRoutes(options?: {
  readonly testRemoteAddress?: string | undefined;
}) {
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      const maybeControlPlane = yield* Effect.serviceOption(PluginControlPlane.PluginControlPlane);
      const maybeThreads = yield* Effect.serviceOption(
        ThreadManagementService.ThreadManagementService,
      );
      if (Option.isSome(maybeControlPlane) && Option.isSome(maybeThreads)) {
        maybeControlPlane.value.setThreadBridge(createThreadManagementBridge(maybeThreads.value));
      }

      const healthHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const headers = normalizeRequestHeaders(request);
        const cp = Option.getOrUndefined(maybeControlPlane);
        const endpointMode = cp?.napcat.getConfig().endpointMode ?? "loopback-only";
        if (endpointMode === "loopback-only") {
          const guard = checkLoopbackOriginAndProxy(request, headers, options?.testRemoteAddress);
          if (!guard.ok) {
            return jsonResponse(403, { ok: false, error: guard.reason });
          }
        }
        const enabled = cp ? yield* cp.isPluginEnabled(NAPCAT_PLUGIN_ID) : false;
        return jsonResponse(200, { ok: true, enabled });
      });

      const webhookHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const headers = normalizeRequestHeaders(request);
        const cp = Option.getOrUndefined(maybeControlPlane);
        if (!cp) {
          return jsonResponse(503, { ok: false, error: "control_plane_unavailable" });
        }

        const activeCfg = cp.napcat.getConfig();
        if (activeCfg.endpointMode === "loopback-only") {
          const guard = checkLoopbackOriginAndProxy(request, headers, options?.testRemoteAddress);
          if (!guard.ok) {
            return jsonResponse(403, { ok: false, error: guard.reason });
          }
        }

        const parsedUrl = requestUrl(request);
        const pathname = Option.isSome(parsedUrl)
          ? parsedUrl.value.pathname
          : (request.url.split("?")[0] ?? "");
        if (pathname !== activeCfg.webhookRoute) {
          return jsonResponse(404, { ok: false, error: "webhook_route_not_found" });
        }

        // Enforce 503 disabled/unconfigured BEFORE buffering 1 MiB body (403 -> 404 -> 503 -> 413 -> guard).
        const pluginEnabled = yield* cp.isPluginEnabled(NAPCAT_PLUGIN_ID);
        if (!pluginEnabled) {
          return jsonResponse(503, { ok: false, error: "plugin_disabled" });
        }
        const secretReady = yield* cp.napcat.hasConfiguredSecret();
        if (!secretReady) {
          return jsonResponse(503, { ok: false, error: "webhook_secret_unconfigured" });
        }

        const contentLength = Number(headers["content-length"] ?? "0");
        if (!Number.isFinite(contentLength) || contentLength > WEBHOOK_MAX_BODY_BYTES) {
          return jsonResponse(413, { ok: false, error: "body_too_large" });
        }

        const maybeBody = yield* request.arrayBuffer.pipe(
          Effect.map((ab) => Buffer.from(ab)),
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            ByteSize.bytes(WEBHOOK_MAX_BODY_BYTES),
          ),
          Effect.option,
        );
        if (Option.isNone(maybeBody) || maybeBody.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
          return jsonResponse(413, { ok: false, error: "body_too_large" });
        }

        const result = yield* cp.napcat.handleWebhook({
          route: pathname,
          rawBody: maybeBody.value,
          headers,
          pluginEnabled,
        });
        return jsonResponse(result.status, result.body, result.headers);
      });

      yield* router.add("GET", NAPCAT_HEALTH_ROUTE, healthHandler);
      yield* router.add("POST", `${NAPCAT_ROUTE_PREFIX}/*`, webhookHandler);
    }),
  );
}

export const routeLayer = makePluginWebhookRoutes();

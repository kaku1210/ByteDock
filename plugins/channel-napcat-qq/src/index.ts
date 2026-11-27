// @effect-diagnostics globalDate:off -- Inbound OneBot event normalization stamps wall-clock timestamps.
// @effect-diagnostics globalFetch:off -- Loopback OneBot v11 HTTP client uses native fetch audited by Egress Guard L1.
import * as Effect from "effect/Effect";
import {
  createWebhookRouteGuard,
  evaluateHostPolicy,
  type EgressGuardController,
  type WebhookGuardOutcome,
} from "@bytedock/plugin-kernel";
import type {
  BotChannelAdapter,
  InboundBotMessage,
  OutboundBotReply,
} from "@bytedock/plugin-bots-core";
import type {
  ByteDockPluginManifest,
  PluginWebhookContribution,
} from "@bytedock/plugin-sdk/manifest";
import { defineServerPlugin, type PluginServerContext } from "@bytedock/plugin-sdk/server";

export const NAPCAT_WEBHOOK_CONTRIBUTION: PluginWebhookContribution = {
  route: "/api/plugins/community.napcat-qq/onebot/event",
  auth: "token",
  tokenSecretRef: "bytedock.napcat.webhook_token",
  hmac: {
    algorithm: "sha1",
    mode: "onebot-custom",
    rawBody: true,
  },
  replayDefense: {
    requireMonotonicSeq: true,
    windowSeconds: 300,
  },
  rateLimitPerMin: 50,
  frameOptions: "DENY",
};

/**
 * Security template manifest for local IM channel plugins (Blueprint §8.3).
 * Exposing NapCat to the public internet requires opting into L3 OS firewall mode.
 */
export const NAPCAT_QQ_MANIFEST: ByteDockPluginManifest = {
  id: "community.napcat-qq",
  name: "NapCatQQ OneBot v11 Channel",
  version: "0.1.0",
  apiVersion: "0.1",
  execution: "trusted-worker",
  trust: "local-dev",
  entry: { server: "./src/index.ts" },
  permissions: {
    rpcScopes: ["plugins:napcat:read", "plugins:napcat:write"],
    secretNamespaces: ["bytedock.napcat"],
    networkHosts: ["127.0.0.1", "localhost"],
    storage: "kv",
    hooks: [{ name: "egress.request.before", onError: "deny", timeoutMs: 2_000 }],
  },
  contributes: {
    settingsSection: {
      id: "napcat-qq",
      titleI18n: "napcat.settings.title",
      group: "plugins",
      icon: "message-square",
    },
    statusBarItems: [{ id: "napcat-status", align: "right", priority: 40 }],
    webhooks: [NAPCAT_WEBHOOK_CONTRIBUTION],
  },
};

export interface OneBotV11Event {
  readonly post_type?: string | undefined;
  readonly message_type?: "group" | "private" | undefined;
  readonly self_id?: number | undefined;
  readonly user_id?: number | undefined;
  readonly group_id?: number | undefined;
  readonly message_id?: number | undefined;
  readonly raw_message?: string | undefined;
  readonly sender?: { readonly nickname?: string | undefined } | undefined;
}

export interface NapCatChannelRuntime {
  readonly channelAdapter: BotChannelAdapter;
  readonly handleWebhook: (input: {
    readonly rawBody: Buffer;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly seq?: number | undefined;
    readonly nowMs?: number | undefined;
  }) => {
    readonly guard: WebhookGuardOutcome;
    readonly inbound?: InboundBotMessage | undefined;
  };
  readonly getSentPayloads: () => ReadonlyArray<{
    readonly endpoint: string;
    readonly body: Readonly<Record<string, unknown>>;
  }>;
}

/**
 * Parses OneBot v11 group/private message events, detecting `[CQ:at,qq=<self_id>]` or `@bot` triggers.
 */
export function parseOneBotInboundEvent(event: OneBotV11Event): InboundBotMessage | undefined {
  if (event.post_type !== "message") return undefined;
  const raw = (event.raw_message ?? "").trim();
  if (!raw) return undefined;

  const selfId = event.self_id !== undefined ? String(event.self_id) : "";
  const cqMention = selfId ? `[CQ:at,qq=${selfId}]` : "";
  const mentionsBot =
    event.message_type === "private" ||
    (cqMention.length > 0 && raw.includes(cqMention)) ||
    /@bot\b/iu.test(raw);

  const cleanedText = raw
    .replace(cqMention, "")
    .replace(/@bot\b/giu, "")
    .trim();

  const conversationKey =
    event.message_type === "group" && event.group_id !== undefined
      ? `qq:group:${event.group_id}`
      : `qq:private:${event.user_id ?? "unknown"}`;

  return {
    channelId: NAPCAT_QQ_MANIFEST.id,
    conversationKey,
    senderId: String(event.user_id ?? "unknown"),
    senderName: event.sender?.nickname ?? `QQ:${event.user_id ?? "unknown"}`,
    text: cleanedText || raw,
    mentionsBot,
    rawEventId: String(event.message_id ?? Date.now()),
    receivedAt: new Date().toISOString(),
  };
}

/**
 * NapCatQQ loopback OneBot v11 channel runtime (Blueprint §8.3 / Matrix 4 & 6).
 * Enforces loopback-only HTTP endpoints audited through Egress Guard L1.
 */
export function createNapCatChannelRuntime(options: {
  readonly oneBotBaseUrl?: string | undefined;
  readonly resolveSecret: (secretRef: string) => string | undefined;
  readonly egressGuard?: EgressGuardController | undefined;
  readonly transport?: (
    endpoint: string,
    body: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>>,
  ) => Promise<{ readonly ok: boolean; readonly messageId?: string }>;
}): NapCatChannelRuntime {
  const baseUrl = (options.oneBotBaseUrl ?? "http://127.0.0.1:3000").replace(/\/+$/u, "");
  const parsedBase = new URL(baseUrl);
  if (parsedBase.hostname !== "127.0.0.1" && parsedBase.hostname !== "localhost") {
    throw new Error(
      `NapCatQQ channel only allows loopback endpoints (got ${parsedBase.hostname}). Enable L3 firewall mode for remote hosts.`,
    );
  }

  const webhookGuard = createWebhookRouteGuard({
    contribution: NAPCAT_WEBHOOK_CONTRIBUTION,
    resolveSecret: options.resolveSecret,
  });

  const sentPayloads: Array<{
    readonly endpoint: string;
    readonly body: Readonly<Record<string, unknown>>;
  }> = [];

  const channelAdapter: BotChannelAdapter = {
    channelId: NAPCAT_QQ_MANIFEST.id,
    sendReply: async (reply: OutboundBotReply) => {
      const isGroup = reply.conversationKey.startsWith("qq:group:");
      const targetId = Number.parseInt(reply.conversationKey.split(":")[2] ?? "0", 10);
      const endpoint = isGroup ? `${baseUrl}/send_group_msg` : `${baseUrl}/send_private_msg`;
      const body = isGroup
        ? { group_id: targetId, message: reply.text }
        : { user_id: targetId, message: reply.text };

      // Audit loopback outbound traffic in Egress Guard L1.
      if (options.egressGuard) {
        const decision = evaluateHostPolicy(parsedBase.hostname, options.egressGuard.getPolicy());
        options.egressGuard.recordAudit({
          layer: "dispatcher",
          host: parsedBase.hostname,
          port: parsedBase.port ? Number.parseInt(parsedBase.port, 10) : 80,
          verdict: decision.verdict,
          reason: decision.reason,
          pluginId: NAPCAT_QQ_MANIFEST.id,
          origin: "host-js",
        });
        if (!decision.allowed) {
          throw new Error(`Egress Guard denied NapCat loopback call: ${decision.reason}`);
        }
      }

      const token = options.resolveSecret("bytedock.napcat.webhook_token");
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      sentPayloads.push({ endpoint, body });

      if (options.transport) {
        const res = await options.transport(endpoint, body, headers);
        return { delivered: res.ok, ...(res.messageId ? { messageId: res.messageId } : {}) };
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return { delivered: response.ok };
    },
  };

  return {
    channelAdapter,
    handleWebhook: (input) => {
      let parsed: OneBotV11Event | undefined;
      try {
        parsed = JSON.parse(input.rawBody.toString("utf8")) as OneBotV11Event;
      } catch {
        parsed = undefined;
      }
      const guard = webhookGuard.verify({
        route: NAPCAT_WEBHOOK_CONTRIBUTION.route,
        rawBody: input.rawBody,
        headers: input.headers,
        replayKey: parsed?.message_id !== undefined ? `ob:${parsed.message_id}` : undefined,
        seq: input.seq,
        nowMs: input.nowMs,
      });
      if (!guard.allowed) {
        return { guard };
      }
      const inbound = parsed ? parseOneBotInboundEvent(parsed) : undefined;
      return { guard, inbound };
    },
    getSentPayloads: () => sentPayloads.slice(),
  };
}

export const napCatChannelServerPlugin = defineServerPlugin({
  manifest: NAPCAT_QQ_MANIFEST,
  activate: Effect.fn("pluginNapCatQq.activate")(function* (ctx: PluginServerContext) {
    yield* ctx.hooks.register("egress.request.before", () => Effect.succeed({ verdict: "pass" }), {
      priority: 10,
      onError: "deny",
      timeoutMs: 2_000,
    });
  }),
});

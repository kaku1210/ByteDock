// @effect-diagnostics nodeBuiltinImport:off -- Bots Core persists SOUL.md, MEMORY.md, and isolated-sqlite indices via Node builtins.
// @effect-diagnostics globalDate:off -- Memory append and decision gate records stamp wall-clock ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { openIsolatedPluginSqlite } from "@bytedock/plugin-kernel";
import type { ByteDockPluginManifest } from "@bytedock/plugin-sdk/manifest";
import { defineServerPlugin, type PluginServerContext } from "@bytedock/plugin-sdk/server";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

export interface BotProfile {
  readonly botId: string;
  readonly name: string;
  readonly threadId: string;
  readonly soulMarkdown: string;
  readonly soulHash: string;
  readonly memoryFilePath: string;
  readonly channelBindings: ReadonlyArray<string>;
}

export interface InboundBotMessage {
  readonly channelId: string;
  readonly conversationKey: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly mentionsBot: boolean;
  readonly rawEventId: string;
  readonly receivedAt: string;
}

export interface OutboundBotReply {
  readonly channelId: string;
  readonly conversationKey: string;
  readonly botId: string;
  readonly threadId: string;
  readonly text: string;
  readonly replyToEventId?: string | undefined;
}

export interface BotChannelAdapter {
  readonly channelId: string;
  readonly sendReply: (
    reply: OutboundBotReply,
  ) => Promise<{ readonly delivered: boolean; readonly messageId?: string }>;
}

export interface DecisionGateItem {
  readonly gateId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly status: "pending" | "approved" | "rejected";
  readonly selectedOption?: string | undefined;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
}

export interface OutboxNotificationPayload {
  readonly kind: "decision-gate";
  readonly gateId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  readonly surfaces: readonly ["web", "desktop-tray", "mobile-readonly"];
}

export interface BotsCoreRuntime {
  readonly registerChannel: (adapter: BotChannelAdapter) => () => void;
  readonly ensureBot: (input: {
    readonly botId: string;
    readonly name: string;
    readonly soulMarkdown: string;
    readonly conversationKey: string;
  }) => BotProfile;
  readonly buildStableSoulPrefix: (botId: string) => {
    readonly id: string;
    readonly hash: string;
    readonly body: string;
  };
  readonly appendMemory: (
    botId: string,
    entry: string,
  ) => { readonly lineCount: number; readonly filePath: string };
  readonly readMemory: (botId: string) => string;
  readonly handleInboundMessage: (
    msg: InboundBotMessage,
    executeAgentTurn: (input: {
      readonly bot: BotProfile;
      readonly prompt: string;
      readonly soulPrefixHash: string;
    }) => Promise<string>,
  ) => Promise<{
    readonly handled: boolean;
    readonly bot?: BotProfile;
    readonly reply?: OutboundBotReply;
  }>;
  readonly openDecisionGate: (input: {
    readonly botId: string;
    readonly question: string;
    readonly options: ReadonlyArray<string>;
    readonly emitOutbox: (notification: OutboxNotificationPayload) => void;
  }) => DecisionGateItem;
  readonly resolveDecisionGate: (gateId: string, selectedOption: string) => DecisionGateItem;
  readonly listBots: () => ReadonlyArray<BotProfile>;
  readonly listDecisionGates: () => ReadonlyArray<DecisionGateItem>;
  readonly close: () => void;
}

export const BOTS_CORE_MANIFEST: ByteDockPluginManifest = {
  id: "builtin.bots-core",
  name: "ByteDock Bots Core",
  version: "0.1.0",
  apiVersion: "0.1",
  execution: "trusted-worker",
  trust: "builtin",
  entry: { server: "./src/index.ts" },
  permissions: {
    rpcScopes: ["plugins:bots:read", "plugins:bots:write"],
    storage: "isolated-sqlite",
    hooks: [
      { name: "agent.open.before", onError: "pass", timeoutMs: 2000 },
      { name: "agent.turn.before", onError: "pass", timeoutMs: 300 },
      { name: "agent.compact.before", onError: "pass", timeoutMs: 2000 },
    ],
  },
  contributes: {
    panels: [
      {
        id: "bots-manager",
        titleI18n: "bots.panel.title",
        icon: "bot",
        mode: "declarative",
        defaultArea: "right",
      },
    ],
    commands: [{ id: "bot.new", titleI18n: "bots.command.new" }],
    timelineRenderers: [{ id: "decision-gate-card", matchType: "plugin-card" }],
  },
};

function sha256(text: string): string {
  return NodeCrypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Bots Core engine: SOUL.md enters deterministic prefixes, MEMORY.md is strictly append-only,
 * and Decision Gates dispatch across Web, Desktop tray, and Mobile read-only outbox.
 */
export function createBotsCoreRuntime(options: { readonly dataDir: string }): BotsCoreRuntime {
  const botsDir = NodePath.join(options.dataDir, "bots");
  NodeFS.mkdirSync(botsDir, { recursive: true });

  const isolatedDb = openIsolatedPluginSqlite(options.dataDir, BOTS_CORE_MANIFEST.id);
  isolatedDb.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_gates (
      gate_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL,
      selected_option TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);

  const channels = new Map<string, BotChannelAdapter>();
  const bots = new Map<string, BotProfile>();
  const conversationToBot = new Map<string, string>();
  const gates = new Map<string, DecisionGateItem>();

  const ensureBot: BotsCoreRuntime["ensureBot"] = (input) => {
    const existing = bots.get(input.botId);
    if (existing) {
      conversationToBot.set(input.conversationKey, existing.botId);
      if (!existing.channelBindings.includes(input.conversationKey)) {
        const updated: BotProfile = {
          ...existing,
          channelBindings: [...existing.channelBindings, input.conversationKey],
        };
        bots.set(input.botId, updated);
        return updated;
      }
      return existing;
    }

    const botFolder = NodePath.join(botsDir, input.botId.replace(/[^a-zA-Z0-9._-]/gu, "_"));
    NodeFS.mkdirSync(botFolder, { recursive: true });
    const soulPath = NodePath.join(botFolder, "SOUL.md");
    const memoryFilePath = NodePath.join(botFolder, "MEMORY.md");
    NodeFS.writeFileSync(soulPath, input.soulMarkdown, "utf8");
    if (!NodeFS.existsSync(memoryFilePath)) {
      NodeFS.writeFileSync(memoryFilePath, `# ${input.name} Memory\n\n`, "utf8");
    }

    const profile: BotProfile = {
      botId: input.botId,
      name: input.name,
      threadId: `bot-thread-${input.botId}`,
      soulMarkdown: input.soulMarkdown,
      soulHash: sha256(input.soulMarkdown),
      memoryFilePath,
      channelBindings: [input.conversationKey],
    };
    bots.set(input.botId, profile);
    conversationToBot.set(input.conversationKey, input.botId);
    return profile;
  };

  const buildStableSoulPrefix = (botId: string) => {
    const bot = bots.get(botId);
    if (!bot) {
      throw new Error(`Unknown botId: ${botId}`);
    }
    return {
      id: `soul:${bot.botId}`,
      hash: bot.soulHash,
      body: bot.soulMarkdown,
    };
  };

  const appendMemory = (botId: string, entry: string) => {
    const bot = bots.get(botId);
    if (!bot) throw new Error(`Unknown botId: ${botId}`);
    const nowIso = new Date().toISOString();
    const line = `- [${nowIso}] ${entry.trim()}\n`;
    NodeFS.appendFileSync(bot.memoryFilePath, line, "utf8");
    isolatedDb.db
      .prepare("INSERT INTO memory_entries (bot_id, content, created_at) VALUES (?, ?, ?)")
      .run(botId, entry.trim(), nowIso);
    const lines = NodeFS.readFileSync(bot.memoryFilePath, "utf8")
      .split(/\r?\n/u)
      .filter((l) => l.startsWith("- ["));
    return { lineCount: lines.length, filePath: bot.memoryFilePath };
  };

  const readMemory = (botId: string) => {
    const bot = bots.get(botId);
    if (!bot || !NodeFS.existsSync(bot.memoryFilePath)) return "";
    return NodeFS.readFileSync(bot.memoryFilePath, "utf8");
  };

  const handleInboundMessage: BotsCoreRuntime["handleInboundMessage"] = async (
    msg,
    executeAgentTurn,
  ) => {
    if (!msg.mentionsBot) {
      return { handled: false };
    }
    const boundBotId = conversationToBot.get(msg.conversationKey) ?? `bot-${msg.channelId}`;
    const bot =
      bots.get(boundBotId) ??
      ensureBot({
        botId: boundBotId,
        name: `ByteDock Assistant (${msg.channelId})`,
        soulMarkdown: "# SOUL\nYou are a ByteDock engineering assistant connected via local IM.",
        conversationKey: msg.conversationKey,
      });

    const soulPrefix = buildStableSoulPrefix(bot.botId);
    const replyText = await executeAgentTurn({
      bot,
      prompt: msg.text,
      soulPrefixHash: soulPrefix.hash,
    });

    const reply: OutboundBotReply = {
      channelId: msg.channelId,
      conversationKey: msg.conversationKey,
      botId: bot.botId,
      threadId: bot.threadId,
      text: replyText,
      replyToEventId: msg.rawEventId,
    };

    const adapter = channels.get(msg.channelId);
    if (adapter) {
      await adapter.sendReply(reply);
    }

    appendMemory(bot.botId, `${msg.senderName}: ${msg.text.slice(0, 120)}`);
    return { handled: true, bot, reply };
  };

  const openDecisionGate: BotsCoreRuntime["openDecisionGate"] = (input) => {
    const bot = bots.get(input.botId);
    if (!bot) throw new Error(`Unknown botId: ${input.botId}`);
    const gateId = `gate-${NodeCrypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();
    const item: DecisionGateItem = {
      gateId,
      botId: bot.botId,
      threadId: bot.threadId,
      question: input.question,
      options: input.options,
      status: "pending",
      createdAt: nowIso,
    };
    gates.set(gateId, item);
    isolatedDb.db
      .prepare(
        "INSERT INTO decision_gates (gate_id, bot_id, thread_id, question, options_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        gateId,
        bot.botId,
        bot.threadId,
        input.question,
        JSON.stringify(input.options),
        "pending",
        nowIso,
      );

    input.emitOutbox({
      kind: "decision-gate",
      gateId,
      botId: bot.botId,
      threadId: bot.threadId,
      title: `[Decision Gate] ${bot.name}`,
      body: input.question,
      surfaces: ["web", "desktop-tray", "mobile-readonly"],
    });
    return item;
  };

  const resolveDecisionGate: BotsCoreRuntime["resolveDecisionGate"] = (gateId, selectedOption) => {
    const existing = gates.get(gateId);
    if (!existing) throw new Error(`Unknown decision gate: ${gateId}`);
    const nowIso = new Date().toISOString();
    const updated: DecisionGateItem = {
      ...existing,
      status: selectedOption.toLowerCase() === "reject" ? "rejected" : "approved",
      selectedOption,
      resolvedAt: nowIso,
    };
    gates.set(gateId, updated);
    isolatedDb.db
      .prepare(
        "UPDATE decision_gates SET status = ?, selected_option = ?, resolved_at = ? WHERE gate_id = ?",
      )
      .run(updated.status, selectedOption, nowIso, gateId);
    appendMemory(existing.botId, `Decision ${gateId} resolved: ${selectedOption}`);
    return updated;
  };

  return {
    registerChannel: (adapter) => {
      channels.set(adapter.channelId, adapter);
      return () => {
        if (channels.get(adapter.channelId) === adapter) {
          channels.delete(adapter.channelId);
        }
      };
    },
    ensureBot,
    buildStableSoulPrefix,
    appendMemory,
    readMemory,
    handleInboundMessage,
    openDecisionGate,
    resolveDecisionGate,
    listBots: () => [...bots.values()],
    listDecisionGates: () => [...gates.values()],
    close: () => {
      isolatedDb.db.close();
    },
  };
}

/** Declarative 12-primitive panel tree for the Bots Manager right-panel slot. */
export function buildBotsManagerPanelTree(input: {
  readonly botCount: number;
  readonly activeChannelCount: number;
  readonly pendingGateCount: number;
  readonly latestMemoryLine?: string | undefined;
}): JsonNode {
  return {
    k: "bots-manager-root",
    t: "Stack",
    p: { gap: "md" },
    c: [
      {
        k: "bots-kpi-card",
        t: "Card",
        p: {
          titleI18n: "bots.panel.overview",
          kpiColumns: 4,
          kpi: [
            { labelI18n: "bots.kpi.activeBots", value: input.botCount, tone: "info" },
            { labelI18n: "bots.kpi.channels", value: input.activeChannelCount, tone: "success" },
            {
              labelI18n: "bots.kpi.pendingGates",
              value: input.pendingGateCount,
              tone: input.pendingGateCount > 0 ? "warning" : "neutral",
            },
            { labelI18n: "bots.kpi.billing", value: "0 extra", tone: "success" },
          ],
        },
      },
      {
        k: "bots-actions",
        t: "Row",
        p: { justify: "between", gap: "sm" },
        c: [
          {
            k: "bots-new-btn",
            t: "Button",
            p: {
              labelI18n: "bots.action.create",
              on: { action: "bot.new", ns: "plugins.builtin.bots-core.createBot" },
            },
          },
          {
            k: "bots-memory-badge",
            t: "Badge",
            p: {
              tone: "info",
              i18n: input.latestMemoryLine ? "bots.memory.synced" : "bots.memory.empty",
            },
          },
        ],
      },
    ],
  };
}

export const botsCoreServerPlugin = defineServerPlugin({
  manifest: BOTS_CORE_MANIFEST,
  activate: Effect.fn("pluginBotsCore.activate")(function* (ctx: PluginServerContext) {
    yield* ctx.hooks.register("agent.turn.before", () => Effect.succeed({ verdict: "pass" }), {
      priority: 20,
      onError: "pass",
      timeoutMs: 300,
    });
    yield* ctx.hooks.register("agent.compact.before", () => Effect.succeed({ verdict: "pass" }), {
      priority: 20,
      onError: "pass",
      timeoutMs: 2_000,
    });
  }),
});

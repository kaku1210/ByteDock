// @effect-diagnostics nodeBuiltinImport:off -- BotsCoreService persists isolated SOUL.md, MEMORY.md, bots.json, and decision-gates.json under <stateDir>/bots/.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as PluginKernel from "@bytedock/plugin-kernel";

class BotsCoreError extends Schema.TaggedError<BotsCoreError>()("BotsCoreError", {
  message: Schema.String,
}) {}

const isBotsCoreError = Schema.is(BotsCoreError);

function toBotsCoreError(err: unknown): BotsCoreError {
  return isBotsCoreError(err)
    ? err
    : new BotsCoreError({ message: err instanceof Error ? err.message : String(err) });
}

const BOTS_CORE_PLUGIN_ID = "builtin.bots-core";
const BOT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MAX_DECISION_GATES = 200;
const MAX_MEMORY_TAIL_LINES = 20;
const MAX_HANDOFF_CHARS = 2_000;
const MAX_SOUL_CHARS = 32_000;
const MAX_MEMORY_ENTRY_CHARS = 4_000;

const DEFAULT_SOUL_MARKDOWN = `# ByteDock Assistant Soul

- Act as a careful, truthful engineering assistant running inside ByteDock.
- Respect ByteDock security boundaries: never echo plaintext secrets and never bypass host approvals.
- Keep responses concise, structured, and grounded in observed tool output.
`;

export interface BotProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly boundProjectId: string | null;
  readonly boundThreadId: string | null;
  readonly soulPrefixHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotDetailView extends BotProfileRecord {
  readonly soulMarkdown: string;
  readonly memoryTail: string;
  readonly memoryLineCount: number;
}

export interface BotDecisionGate {
  readonly gateId: string;
  readonly botId: string;
  readonly threadId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: string;
  readonly createdBy: string;
  readonly resolvedAt?: string | undefined;
  readonly resolvedBy?: string | undefined;
  readonly resolvedVia?: string | undefined;
  readonly note?: string | undefined;
}

export interface BotsCoreStateSnapshot {
  readonly botsDir: string;
  readonly bots: ReadonlyArray<BotDetailView>;
  readonly decisionGates: ReadonlyArray<BotDecisionGate>;
  readonly pendingDecisionGates: number;
}

export interface BotsCoreService {
  readonly attachKernelHooks: (
    kernel: PluginKernel.PluginKernelService,
    revision: number,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly syncConfig: (config: Readonly<Record<string, unknown>>) => void;
  readonly getState: () => BotsCoreStateSnapshot;
  readonly getSummary: () => {
    readonly botCount: number;
    readonly activeBotCount: number;
    readonly boundThreadCount: number;
    readonly pendingDecisionGates: number;
    readonly botsDir: string;
  };
  readonly getDefaultOrActiveBot: (preferredBotId?: string | undefined) => BotDetailView | null;
  readonly findBotByThreadId: (threadId: string) => BotDetailView | null;
  readonly upsertBot: (input: {
    readonly id: string;
    readonly name: string;
    readonly enabled?: boolean | undefined;
    readonly boundProjectId?: string | null | undefined;
    readonly boundThreadId?: string | null | undefined;
    readonly soulMarkdown?: string | undefined;
  }) => Effect.Effect<BotDetailView, BotsCoreError>;
  readonly deleteBot: (
    botId: string,
  ) => Effect.Effect<{ readonly deleted: boolean }, BotsCoreError>;
  readonly updateSoul: (input: {
    readonly botId: string;
    readonly soulMarkdown: string;
  }) => Effect.Effect<BotDetailView, BotsCoreError>;
  readonly appendMemory: (input: {
    readonly botId: string;
    readonly entry: string;
    readonly source?: string | undefined;
  }) => Effect.Effect<
    { readonly botId: string; readonly memoryTail: string; readonly memoryLineCount: number },
    BotsCoreError
  >;
  readonly openGate: (input: {
    readonly botId?: string | undefined;
    readonly threadId?: string | null | undefined;
    readonly title: string;
    readonly summary: string;
    readonly createdBy: string;
  }) => Effect.Effect<BotDecisionGate, BotsCoreError>;
  readonly resolveGate: (input: {
    readonly gateId: string;
    readonly decision: "approved" | "rejected";
    readonly resolvedBy: string;
    readonly resolvedVia: string;
    readonly note?: string | undefined;
  }) => Effect.Effect<BotDecisionGate, BotsCoreError>;
  readonly listGates: (
    status?: "pending" | "approved" | "rejected" | undefined,
  ) => ReadonlyArray<BotDecisionGate>;
}

function isoFromMs(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function hashSoul(markdown: string): string {
  return NodeCrypto.createHash("sha256").update(markdown, "utf8").digest("hex");
}

const RESERVED_BOT_IDS = new Set(["bots.json", "decision-gates.json"]);
const WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function isValidBotId(id: string): boolean {
  if (!BOT_ID_RE.test(id)) return false;
  if (id.includes("..") || id.includes("/") || id.includes("\\")) return false;
  if (id.endsWith(".")) return false;
  if (RESERVED_BOT_IDS.has(id.toLowerCase())) return false;
  if (WINDOWS_RESERVED_DEVICE_RE.test(id)) return false;
  return true;
}

function assertValidBotId(rawId: string): string {
  const id = rawId.trim();
  if (!isValidBotId(id)) {
    throw new Error(
      `Invalid bot id "${rawId}". Must match ^[a-z0-9][a-z0-9._-]{0,47}$ without trailing dot, reserved filenames, or path traversal.`,
    );
  }
  return id;
}

function resolveInsideBotsDir(botsDir: string, ...segments: ReadonlyArray<string>): string {
  const resolvedRoot = NodePath.resolve(botsDir);
  const candidate = NodePath.resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
    throw new Error("Bot storage path escaped isolated <stateDir>/bots directory.");
  }
  return candidate;
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = NodePath.dirname(targetPath);
  NodeFS.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  NodeFS.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  NodeFS.renameSync(tmpPath, targetPath);
}

function extractMemoryTail(raw: string): { readonly tail: string; readonly lineCount: number } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const tailLines = lines.slice(-MAX_MEMORY_TAIL_LINES);
  let tail = tailLines.join("\n");
  if (tail.length > MAX_HANDOFF_CHARS) {
    tail = tail.slice(tail.length - MAX_HANDOFF_CHARS);
  }
  return { tail, lineCount: lines.length };
}

function buildDeterministicSoulBlock(bot: BotProfileRecord, soulMarkdown: string): string {
  return `[ByteDock Bot Soul | bot=${bot.id} | sha256=${bot.soulPrefixHash}]\n${soulMarkdown.trimEnd()}`;
}

/**
 * Isolated host runtime for builtin.bots-core under <stateDir>/bots/.
 * Keeps an in-memory cache for zero-disk-I/O agent.turn.before hot paths and
 * provides deterministic SOUL.md prefix injection, append-only MEMORY.md,
 * post-compact one-shot handoff, and Decision Gate persistence.
 */
export function makeBotsCoreService(options: {
  readonly stateDir: string;
  readonly emitEvent: (
    kind: string,
    payload: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly initialNowMs?: number | undefined;
}): BotsCoreService {
  const botsDir = NodePath.join(options.stateDir, "bots");
  const botsIndexPath = resolveInsideBotsDir(botsDir, "bots.json");
  const gatesPath = resolveInsideBotsDir(botsDir, "decision-gates.json");

  NodeFS.mkdirSync(botsDir, { recursive: true });

  const botsById = new Map<string, BotProfileRecord>();
  const soulByBotId = new Map<string, string>();
  const memoryByBotId = new Map<string, string>();
  const boundBotIdByThreadId = new Map<string, string>();
  const pendingHandoffByThreadId = new Map<string, string>();
  let gates: Array<BotDecisionGate> = [];
  let soulPrefixGuard = true;

  const rebuildThreadIndex = () => {
    boundBotIdByThreadId.clear();
    for (const bot of botsById.values()) {
      if (bot.enabled && bot.boundThreadId) {
        boundBotIdByThreadId.set(bot.boundThreadId, bot.id);
      }
    }
  };

  const persistBotsIndex = () => {
    const sorted = [...botsById.values()].sort((a, b) => a.id.localeCompare(b.id));
    atomicWriteFileSync(botsIndexPath, `${JSON.stringify(sorted, null, 2)}\n`);
  };

  const persistGates = (nextGates: ReadonlyArray<BotDecisionGate>) => {
    const bounded = nextGates.slice(0, MAX_DECISION_GATES);
    atomicWriteFileSync(gatesPath, `${JSON.stringify(bounded, null, 2)}\n`);
    gates = bounded;
  };

  const ensureBotFilesLoaded = (bot: BotProfileRecord): BotProfileRecord => {
    const botRoot = resolveInsideBotsDir(botsDir, bot.id);
    const soulPath = resolveInsideBotsDir(botsDir, bot.id, "SOUL.md");
    const memoryPath = resolveInsideBotsDir(botsDir, bot.id, "MEMORY.md");
    NodeFS.mkdirSync(botRoot, { recursive: true });

    let soulMarkdown = DEFAULT_SOUL_MARKDOWN;
    if (NodeFS.existsSync(soulPath)) {
      soulMarkdown = NodeFS.readFileSync(soulPath, "utf8");
    } else {
      atomicWriteFileSync(soulPath, soulMarkdown);
    }

    let memoryRaw = `# MEMORY (${bot.id})\n`;
    if (NodeFS.existsSync(memoryPath)) {
      memoryRaw = NodeFS.readFileSync(memoryPath, "utf8");
    } else {
      atomicWriteFileSync(memoryPath, memoryRaw);
    }

    const computedHash = hashSoul(soulMarkdown);
    const normalized: BotProfileRecord =
      bot.soulPrefixHash === computedHash ? bot : { ...bot, soulPrefixHash: computedHash };
    botsById.set(normalized.id, normalized);
    soulByBotId.set(normalized.id, soulMarkdown);
    memoryByBotId.set(normalized.id, memoryRaw);
    return normalized;
  };

  // Load existing profiles or bootstrap the default bot profile.
  const loadFromDisk = () => {
    let loadedProfiles: Array<BotProfileRecord> = [];
    if (NodeFS.existsSync(botsIndexPath)) {
      try {
        const parsed = JSON.parse(NodeFS.readFileSync(botsIndexPath, "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const rec = item as Record<string, unknown>;
            if (typeof rec.id !== "string" || !isValidBotId(rec.id)) continue;
            loadedProfiles.push({
              id: rec.id,
              name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : rec.id,
              enabled: rec.enabled !== false,
              boundProjectId:
                typeof rec.boundProjectId === "string" && rec.boundProjectId.trim()
                  ? rec.boundProjectId.trim()
                  : null,
              boundThreadId:
                typeof rec.boundThreadId === "string" && rec.boundThreadId.trim()
                  ? rec.boundThreadId.trim()
                  : null,
              soulPrefixHash: typeof rec.soulPrefixHash === "string" ? rec.soulPrefixHash : "",
              createdAt: typeof rec.createdAt === "string" ? rec.createdAt : isoFromMs(0),
              updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : isoFromMs(0),
            });
          }
        }
      } catch {
        loadedProfiles = [];
      }
    }

    if (loadedProfiles.length === 0) {
      const bootIso = isoFromMs(options.initialNowMs ?? 0);
      loadedProfiles = [
        {
          id: "default",
          name: "ByteDock Default Bot",
          enabled: true,
          boundProjectId: null,
          boundThreadId: null,
          soulPrefixHash: hashSoul(DEFAULT_SOUL_MARKDOWN),
          createdAt: bootIso,
          updatedAt: bootIso,
        },
      ];
    }

    for (const profile of loadedProfiles) {
      ensureBotFilesLoaded(profile);
    }
    persistBotsIndex();
    rebuildThreadIndex();

    if (NodeFS.existsSync(gatesPath)) {
      try {
        const parsed = JSON.parse(NodeFS.readFileSync(gatesPath, "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          gates = parsed
            .filter((item): item is BotDecisionGate => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return false;
              const rec = item as Record<string, unknown>;
              return (
                typeof rec.gateId === "string" &&
                typeof rec.botId === "string" &&
                typeof rec.title === "string" &&
                typeof rec.summary === "string" &&
                (rec.status === "pending" || rec.status === "approved" || rec.status === "rejected")
              );
            })
            .slice(0, MAX_DECISION_GATES);
        }
      } catch {
        gates = [];
      }
    }
  };

  loadFromDisk();

  const toBotDetail = (bot: BotProfileRecord): BotDetailView => {
    const soulMarkdown = soulByBotId.get(bot.id) ?? DEFAULT_SOUL_MARKDOWN;
    const memoryRaw = memoryByBotId.get(bot.id) ?? "";
    const { tail, lineCount } = extractMemoryTail(memoryRaw);
    return {
      ...bot,
      soulMarkdown,
      memoryTail: tail,
      memoryLineCount: lineCount,
    };
  };

  const getState: BotsCoreService["getState"] = () => {
    const bots = [...botsById.values()].sort((a, b) => a.id.localeCompare(b.id)).map(toBotDetail);
    const pendingDecisionGates = gates.filter((g) => g.status === "pending").length;
    return {
      botsDir,
      bots,
      decisionGates: gates.slice(),
      pendingDecisionGates,
    };
  };

  const getSummary: BotsCoreService["getSummary"] = () => {
    const allBots = [...botsById.values()];
    return {
      botCount: allBots.length,
      activeBotCount: allBots.filter((b) => b.enabled).length,
      boundThreadCount: allBots.filter((b) => b.enabled && b.boundThreadId !== null).length,
      pendingDecisionGates: gates.filter((g) => g.status === "pending").length,
      botsDir,
    };
  };

  const getDefaultOrActiveBot: BotsCoreService["getDefaultOrActiveBot"] = (preferredBotId) => {
    if (preferredBotId) {
      const exact = botsById.get(preferredBotId);
      if (exact) return toBotDetail(exact);
    }
    const enabledBound = [...botsById.values()].find((b) => b.enabled && b.boundThreadId !== null);
    if (enabledBound) return toBotDetail(enabledBound);
    const def = botsById.get("default");
    if (def) return toBotDetail(def);
    const first = botsById.values().next().value;
    return first ? toBotDetail(first) : null;
  };

  const findBotByThreadId: BotsCoreService["findBotByThreadId"] = (threadId) => {
    const botId = boundBotIdByThreadId.get(threadId);
    if (!botId) return null;
    const bot = botsById.get(botId);
    return bot ? toBotDetail(bot) : null;
  };

  const upsertBot: BotsCoreService["upsertBot"] = Effect.fn("BotsCoreService.upsertBot")(
    function* (input) {
      const id = yield* Effect.try({
        try: () => assertValidBotId(input.id),
        catch: toBotsCoreError,
      });
      const name = input.name.trim();
      if (!name || name.length > 80) {
        return yield* new BotsCoreError({ message: "Bot name must be 1 to 80 characters." });
      }
      const nowIso = isoFromMs(yield* Clock.currentTimeMillis);
      const existing = botsById.get(id);

      const boundThreadId =
        input.boundThreadId === undefined
          ? (existing?.boundThreadId ?? null)
          : input.boundThreadId && input.boundThreadId.trim().length > 0
            ? input.boundThreadId.trim()
            : null;
      const boundProjectId =
        boundThreadId === null
          ? null
          : input.boundProjectId === undefined
            ? (existing?.boundProjectId ?? null)
            : input.boundProjectId && input.boundProjectId.trim().length > 0
              ? input.boundProjectId.trim()
              : null;

      let soulMarkdown = soulByBotId.get(id) ?? DEFAULT_SOUL_MARKDOWN;
      if (input.soulMarkdown !== undefined) {
        if (input.soulMarkdown.length > MAX_SOUL_CHARS) {
          return yield* new BotsCoreError({
            message: `SOUL.md exceeds maximum allowed size (${MAX_SOUL_CHARS} characters).`,
          });
        }
        soulMarkdown = input.soulMarkdown;
      }

      const record: BotProfileRecord = {
        id,
        name,
        enabled: input.enabled ?? existing?.enabled ?? true,
        boundProjectId,
        boundThreadId,
        soulPrefixHash: hashSoul(soulMarkdown),
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };

      yield* Effect.try({
        try: () => {
          const botRoot = resolveInsideBotsDir(botsDir, id);
          const soulPath = resolveInsideBotsDir(botsDir, id, "SOUL.md");
          const memoryPath = resolveInsideBotsDir(botsDir, id, "MEMORY.md");
          NodeFS.mkdirSync(botRoot, { recursive: true });
          if (input.soulMarkdown !== undefined || !NodeFS.existsSync(soulPath)) {
            atomicWriteFileSync(soulPath, soulMarkdown);
          }
          if (!NodeFS.existsSync(memoryPath)) {
            const initialMem = `# MEMORY (${id})\n`;
            atomicWriteFileSync(memoryPath, initialMem);
            memoryByBotId.set(id, initialMem);
          }
          botsById.set(id, record);
          soulByBotId.set(id, soulMarkdown);
          persistBotsIndex();
          rebuildThreadIndex();
        },
        catch: toBotsCoreError,
      });

      yield* options.emitEvent("bots-updated", {
        botId: id,
        action: existing ? "updated" : "created",
        pendingDecisionGates: gates.filter((g) => g.status === "pending").length,
      });

      return toBotDetail(record);
    },
  );

  const deleteBot: BotsCoreService["deleteBot"] = Effect.fn("BotsCoreService.deleteBot")(
    function* (rawBotId) {
      const id = yield* Effect.try({
        try: () => assertValidBotId(rawBotId),
        catch: toBotsCoreError,
      });
      if (id === "default") {
        return yield* new BotsCoreError({
          message: 'The built-in "default" bot profile cannot be deleted.',
        });
      }
      if (!botsById.has(id)) {
        return { deleted: false };
      }
      yield* Effect.try({
        try: () => {
          botsById.delete(id);
          soulByBotId.delete(id);
          memoryByBotId.delete(id);
          persistBotsIndex();
          rebuildThreadIndex();
          const botRoot = resolveInsideBotsDir(botsDir, id);
          if (NodeFS.existsSync(botRoot)) {
            NodeFS.rmSync(botRoot, { recursive: true, force: true });
          }
        },
        catch: toBotsCoreError,
      });
      yield* options.emitEvent("bots-updated", {
        botId: id,
        action: "deleted",
        pendingDecisionGates: gates.filter((g) => g.status === "pending").length,
      });
      return { deleted: true };
    },
  );

  const updateSoul: BotsCoreService["updateSoul"] = Effect.fn("BotsCoreService.updateSoul")(
    function* (input) {
      const id = yield* Effect.try({
        try: () => assertValidBotId(input.botId),
        catch: toBotsCoreError,
      });
      const existing = botsById.get(id);
      if (!existing) {
        return yield* new BotsCoreError({ message: `Bot "${id}" does not exist.` });
      }
      if (input.soulMarkdown.length > MAX_SOUL_CHARS) {
        return yield* new BotsCoreError({
          message: `SOUL.md exceeds maximum allowed size (${MAX_SOUL_CHARS} characters).`,
        });
      }
      const nowIso = isoFromMs(yield* Clock.currentTimeMillis);
      const updated: BotProfileRecord = {
        ...existing,
        soulPrefixHash: hashSoul(input.soulMarkdown),
        updatedAt: nowIso,
      };
      yield* Effect.try({
        try: () => {
          const soulPath = resolveInsideBotsDir(botsDir, id, "SOUL.md");
          atomicWriteFileSync(soulPath, input.soulMarkdown);
          botsById.set(id, updated);
          soulByBotId.set(id, input.soulMarkdown);
          persistBotsIndex();
        },
        catch: toBotsCoreError,
      });
      yield* options.emitEvent("bots-updated", {
        botId: id,
        action: "soul-updated",
        soulPrefixHash: updated.soulPrefixHash,
      });
      return toBotDetail(updated);
    },
  );

  const appendMemory: BotsCoreService["appendMemory"] = Effect.fn("BotsCoreService.appendMemory")(
    function* (input) {
      const id = yield* Effect.try({
        try: () => assertValidBotId(input.botId),
        catch: toBotsCoreError,
      });
      if (!botsById.has(id)) {
        return yield* new BotsCoreError({ message: `Bot "${id}" does not exist.` });
      }
      const cleanEntry = input.entry.replace(/\r?\n/g, " ").trim();
      if (!cleanEntry || cleanEntry.length > MAX_MEMORY_ENTRY_CHARS) {
        return yield* new BotsCoreError({
          message: `Memory entry must be 1 to ${MAX_MEMORY_ENTRY_CHARS} characters.`,
        });
      }
      const nowIso = isoFromMs(yield* Clock.currentTimeMillis);
      const cleanSource = input.source
        ?.replace(/[\r\n]+/g, " ")
        .trim()
        .slice(0, 64);
      const tag = cleanSource ? `[${cleanSource}] ` : "";
      const line = `- ${nowIso} ${tag}${cleanEntry}\n`;

      const nextRaw = yield* Effect.try({
        try: () => {
          const memoryPath = resolveInsideBotsDir(botsDir, id, "MEMORY.md");
          if (!NodeFS.existsSync(memoryPath)) {
            atomicWriteFileSync(memoryPath, `# MEMORY (${id})\n`);
          }
          NodeFS.appendFileSync(memoryPath, line, { encoding: "utf8", mode: 0o600 });
          const updatedContent = NodeFS.readFileSync(memoryPath, "utf8");
          memoryByBotId.set(id, updatedContent);
          return updatedContent;
        },
        catch: toBotsCoreError,
      });

      const { tail, lineCount } = extractMemoryTail(nextRaw);
      yield* options.emitEvent("bots-updated", {
        botId: id,
        action: "memory-appended",
        memoryLineCount: lineCount,
      });
      return {
        botId: id,
        memoryTail: tail,
        memoryLineCount: lineCount,
      };
    },
  );

  const openGate: BotsCoreService["openGate"] = Effect.fn("BotsCoreService.openGate")(
    function* (input) {
      const botId = yield* Effect.try({
        try: () => assertValidBotId(input.botId ?? "default"),
        catch: toBotsCoreError,
      });
      if (!botsById.has(botId)) {
        return yield* new BotsCoreError({ message: `Bot "${botId}" does not exist.` });
      }
      const title = input.title.trim();
      const summary = input.summary.trim();
      if (!title || title.length > 160) {
        return yield* new BotsCoreError({
          message: "Decision gate title must be 1 to 160 characters.",
        });
      }
      if (!summary || summary.length > 2_000) {
        return yield* new BotsCoreError({
          message: "Decision gate summary must be 1 to 2000 characters.",
        });
      }
      const nowIso = isoFromMs(yield* Clock.currentTimeMillis);
      const gate: BotDecisionGate = {
        gateId: `gate-${NodeCrypto.randomBytes(6).toString("hex")}`,
        botId,
        threadId: input.threadId ?? botsById.get(botId)?.boundThreadId ?? null,
        title,
        summary,
        status: "pending",
        createdAt: nowIso,
        createdBy: input.createdBy.trim() || "system",
      };
      const nextGates = [gate, ...gates].slice(0, MAX_DECISION_GATES);
      yield* Effect.try({
        try: () => persistGates(nextGates),
        catch: toBotsCoreError,
      });
      yield* options.emitEvent("decision-gate-created", {
        gateId: gate.gateId,
        botId: gate.botId,
        title: gate.title,
        pendingDecisionGates: gates.filter((g) => g.status === "pending").length,
      });
      return gate;
    },
  );

  const resolveGate: BotsCoreService["resolveGate"] = Effect.fn("BotsCoreService.resolveGate")(
    function* (input) {
      const gateId = input.gateId.trim();
      const idx = gates.findIndex((g) => g.gateId === gateId);
      if (idx < 0) {
        return yield* new BotsCoreError({
          message: `Decision gate "${gateId}" was not found.`,
        });
      }
      const current = gates[idx]!;
      if (current.status !== "pending") {
        return yield* new BotsCoreError({
          message: `Decision gate "${gateId}" is already ${current.status}.`,
        });
      }
      const nowIso = isoFromMs(yield* Clock.currentTimeMillis);
      const resolved: BotDecisionGate = {
        ...current,
        status: input.decision,
        resolvedAt: nowIso,
        resolvedBy: input.resolvedBy.trim() || "user",
        resolvedVia: input.resolvedVia.trim() || "host-client",
        ...(input.note?.trim() ? { note: input.note.trim().slice(0, 500) } : {}),
      };
      const nextGates = gates.map((g, i) => (i === idx ? resolved : g));
      yield* Effect.try({
        try: () => persistGates(nextGates),
        catch: toBotsCoreError,
      });
      yield* options.emitEvent("decision-gate-resolved", {
        gateId: resolved.gateId,
        botId: resolved.botId,
        status: resolved.status,
        resolvedVia: resolved.resolvedVia,
        pendingDecisionGates: gates.filter((g) => g.status === "pending").length,
      });
      return resolved;
    },
  );

  const listGates: BotsCoreService["listGates"] = (status) =>
    status ? gates.filter((g) => g.status === status) : gates.slice();

  const attachKernelHooks: BotsCoreService["attachKernelHooks"] = Effect.fn(
    "BotsCoreService.attachKernelHooks",
  )(function* (kernel, revision) {
    yield* kernel.hooks.register({
      pluginId: BOTS_CORE_PLUGIN_ID,
      revision,
      name: "agent.turn.before",
      priority: 20,
      onError: "pass",
      timeoutMs: 150,
      handler: (invocation) =>
        Effect.sync(() => {
          if (!soulPrefixGuard) return { verdict: "pass" } as const;
          const payload = invocation.input as { readonly threadId?: unknown } | null;
          if (!payload || typeof payload.threadId !== "string" || payload.threadId.length === 0) {
            return { verdict: "pass" } as const;
          }
          const botId = boundBotIdByThreadId.get(payload.threadId);
          if (!botId) return { verdict: "pass" } as const;
          const bot = botsById.get(botId);
          if (!bot || !bot.enabled) return { verdict: "pass" } as const;
          const soul = soulByBotId.get(botId);
          if (!soul) return { verdict: "pass" } as const;

          const basePrefix = buildDeterministicSoulBlock(bot, soul);
          const oneShotHandoff = pendingHandoffByThreadId.get(payload.threadId);
          if (oneShotHandoff) {
            pendingHandoffByThreadId.delete(payload.threadId);
            return {
              verdict: "pass",
              contribution: {
                appendContext: `${basePrefix}\n\n${oneShotHandoff}`,
              },
            } as const;
          }
          return {
            verdict: "pass",
            contribution: {
              appendContext: basePrefix,
            },
          } as const;
        }),
    });

    yield* kernel.hooks.register({
      pluginId: BOTS_CORE_PLUGIN_ID,
      revision,
      name: "agent.compact.before",
      priority: 20,
      onError: "pass",
      timeoutMs: 250,
      handler: (invocation) =>
        Effect.sync(() => {
          const payload = invocation.input as { readonly threadId?: unknown } | null;
          if (!payload || typeof payload.threadId !== "string" || payload.threadId.length === 0) {
            return { verdict: "pass" } as const;
          }
          const botId = boundBotIdByThreadId.get(payload.threadId);
          if (!botId) return { verdict: "pass" } as const;
          const bot = botsById.get(botId);
          if (!bot || !bot.enabled) return { verdict: "pass" } as const;

          const { tail } = extractMemoryTail(memoryByBotId.get(botId) ?? "");
          const handoffSummary = [
            `[ByteDock Bot Compaction Handoff | bot=${bot.id} | soulSha256=${bot.soulPrefixHash}]`,
            tail ? `Recent MEMORY.md:\n${tail}` : "Recent MEMORY.md: (empty)",
          ].join("\n");
          // Arm one-shot handoff for the immediately following regular turn so adapters
          // that skip appContext on /compact slash commands still preserve bot memory.
          pendingHandoffByThreadId.set(payload.threadId, handoffSummary);
          return {
            verdict: "pass",
            contribution: {
              handoffSummary,
            },
          } as const;
        }),
    });
  });

  const syncConfig: BotsCoreService["syncConfig"] = (config) => {
    soulPrefixGuard = config.soulPrefixGuard !== false;
  };

  return {
    attachKernelHooks,
    syncConfig,
    getState,
    getSummary,
    getDefaultOrActiveBot,
    findBotByThreadId,
    upsertBot,
    deleteBot,
    updateSoul,
    appendMemory,
    openGate,
    resolveGate,
    listGates,
  };
}

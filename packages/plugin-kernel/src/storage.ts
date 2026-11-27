// @effect-diagnostics nodeBuiltinImport:off -- Four-tier storage manages SQLite, atomic YAML, and hash-chained JSONL files.
// @effect-diagnostics globalDate:off -- Synchronous SQLite/JSONL storage helpers take injectable nowMs with wall-clock fallback.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PLUGIN_KV_MAX_VALUE_BYTES = 65_536;
export const PLUGIN_KV_DEFAULT_QUOTA_BYTES = 32 * 1024 * 1024;
export const AUDIT_JSONL_ROTATE_BYTES = 64 * 1024 * 1024;

export class KvLimitExceededError extends Schema.TaggedError<KvLimitExceededError>()(
  "KvLimitExceededError",
  {
    pluginId: Schema.String,
    reason: Schema.Literals(["value-too-large", "quota-exceeded"]),
    actualBytes: Schema.Number,
    limitBytes: Schema.Number,
  },
) {}

export type AuditChainState = "verified" | "rotated-unverified" | "broken";

export interface PluginKvEntry {
  readonly pluginId: string;
  readonly ns: string;
  readonly key: string;
  readonly jsonValue: string;
  readonly expiresAt: number | null;
}

export interface PluginKvPool {
  readonly get: (pluginId: string, ns: string, key: string, nowMs?: number) => string | undefined;
  readonly set: (
    pluginId: string,
    ns: string,
    key: string,
    jsonValue: string,
    expiresAt?: number | null,
  ) => Effect.Effect<void, KvLimitExceededError>;
  readonly delete: (pluginId: string, ns: string, key: string) => void;
  readonly purgePlugin: (pluginId: string) => number;
  readonly sweepExpired: (nowMs?: number) => number;
  readonly usageBytes: (pluginId: string) => number;
  readonly close: () => void;
}

/**
 * Tier-2 bounded metadata store (plugin_kv).
 * Enforces <=64KB per value and per-plugin byte quota without ever sharing EventSink's transaction.
 */
export function openPluginKvPool(
  dbPath: string,
  options?: { readonly defaultQuotaBytes?: number | undefined },
): PluginKvPool {
  const defaultQuotaBytes = options?.defaultQuotaBytes ?? PLUGIN_KV_DEFAULT_QUOTA_BYTES;
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS plugin_kv (
      plugin_id TEXT NOT NULL,
      ns TEXT NOT NULL,
      key TEXT NOT NULL,
      json_value TEXT NOT NULL CHECK (length(CAST(json_value AS BLOB)) <= 65536),
      expires_at INTEGER,
      PRIMARY KEY (plugin_id, ns, key)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_kv_expires ON plugin_kv (expires_at) WHERE expires_at IS NOT NULL;
  `);

  const usageBytes = (pluginId: string): number => {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(length(CAST(json_value AS BLOB))), 0) AS total FROM plugin_kv WHERE plugin_id = ?",
      )
      .get(pluginId) as { readonly total?: number } | undefined;
    return Number(row?.total ?? 0);
  };

  const set = Effect.fn("PluginKvPool.set")(function* (
    pluginId: string,
    ns: string,
    key: string,
    jsonValue: string,
    expiresAt: number | null = null,
  ) {
    const bytes = Buffer.byteLength(jsonValue, "utf8");
    if (bytes > PLUGIN_KV_MAX_VALUE_BYTES) {
      return yield* new KvLimitExceededError({
        pluginId,
        reason: "value-too-large",
        actualBytes: bytes,
        limitBytes: PLUGIN_KV_MAX_VALUE_BYTES,
      });
    }
    const existing = db
      .prepare(
        "SELECT length(CAST(json_value AS BLOB)) AS prevBytes FROM plugin_kv WHERE plugin_id = ? AND ns = ? AND key = ?",
      )
      .get(pluginId, ns, key) as { readonly prevBytes?: number } | undefined;
    const projected = usageBytes(pluginId) - Number(existing?.prevBytes ?? 0) + bytes;
    if (projected > defaultQuotaBytes) {
      return yield* new KvLimitExceededError({
        pluginId,
        reason: "quota-exceeded",
        actualBytes: projected,
        limitBytes: defaultQuotaBytes,
      });
    }
    db.prepare(
      `INSERT INTO plugin_kv (plugin_id, ns, key, json_value, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id, ns, key) DO UPDATE SET
         json_value = excluded.json_value,
         expires_at = excluded.expires_at`,
    ).run(pluginId, ns, key, jsonValue, expiresAt);
  });

  return {
    get: (pluginId, ns, key, nowMs = Date.now()) => {
      const row = db
        .prepare(
          "SELECT json_value, expires_at FROM plugin_kv WHERE plugin_id = ? AND ns = ? AND key = ?",
        )
        .get(pluginId, ns, key) as
        | { readonly json_value: string; readonly expires_at: number | null }
        | undefined;
      if (!row) return undefined;
      if (row.expires_at !== null && row.expires_at <= nowMs) return undefined;
      return row.json_value;
    },
    set,
    delete: (pluginId, ns, key) => {
      db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND ns = ? AND key = ?").run(
        pluginId,
        ns,
        key,
      );
    },
    purgePlugin: (pluginId) => {
      const res = db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ?").run(pluginId);
      return Number(res.changes);
    },
    sweepExpired: (nowMs = Date.now()) => {
      const res = db
        .prepare("DELETE FROM plugin_kv WHERE expires_at IS NOT NULL AND expires_at <= ?")
        .run(nowMs);
      return Number(res.changes);
    },
    usageBytes,
    close: () => {
      db.close();
    },
  };
}

/**
 * Tier-3 isolated SQLite database per plugin (~/.bytedock/plugins-data/<pluginId>.sqlite).
 * Separate connection and separate WAL so plugin queries never contend with statev2.sqlite.
 */
export function openIsolatedPluginSqlite(
  pluginsDataDir: string,
  pluginId: string,
): { readonly dbPath: string; readonly db: NodeSqlite.DatabaseSync } {
  const safeId = pluginId.replace(/[^a-zA-Z0-9._-]/g, "_");
  NodeFS.mkdirSync(pluginsDataDir, { recursive: true });
  const dbPath = NodePath.join(pluginsDataDir, `${safeId}.sqlite`);
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return { dbPath, db };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface HashChainedAuditRecord<TPayload = unknown> {
  readonly seq: number;
  readonly prevHash: string;
  readonly eventHash: string;
  readonly ts: number;
  readonly payload: TPayload;
}

export interface HashChainedAuditWriter {
  readonly append: <TPayload>(payload: TPayload) => HashChainedAuditRecord<TPayload>;
  readonly verify: () => {
    readonly state: AuditChainState;
    readonly count: number;
    readonly tailHash: string;
  };
  readonly filePath: string;
}

/**
 * Tier-4 append-only hash-chained JSONL audit log (ADR-05).
 * Chains eventHash = sha256(prevHash || seq || canonicalJson(payload)) with explicit rotation check.
 */
export function openHashChainedAuditLog(input: {
  readonly filePath: string;
  readonly streamId: string;
  readonly genesisSeed?: string | undefined;
  readonly rotateBytes?: number | undefined;
  readonly kvPool?: PluginKvPool | undefined;
}): HashChainedAuditWriter {
  const rotateBytes = input.rotateBytes ?? AUDIT_JSONL_ROTATE_BYTES;
  const genesisHash = NodeCrypto.createHash("sha256")
    .update(`${input.streamId}|${input.genesisSeed ?? "bytedock-v1"}`)
    .digest("hex");

  NodeFS.mkdirSync(NodePath.dirname(input.filePath), { recursive: true });

  const readExisting = (): ReadonlyArray<HashChainedAuditRecord> => {
    if (!NodeFS.existsSync(input.filePath)) return [];
    const raw = NodeFS.readFileSync(input.filePath, "utf8").trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).map((line: string) => JSON.parse(line) as HashChainedAuditRecord);
  };

  let existing = readExisting();
  let nextSeq = existing.length > 0 ? (existing[existing.length - 1]?.seq ?? 0) + 1 : 1;
  let prevHash =
    existing.length > 0 ? (existing[existing.length - 1]?.eventHash ?? genesisHash) : genesisHash;

  return {
    filePath: input.filePath,
    append: <TPayload>(payload: TPayload) => {
      if (
        NodeFS.existsSync(input.filePath) &&
        NodeFS.statSync(input.filePath).size >= rotateBytes
      ) {
        const archivePath = `${input.filePath}.${Date.now()}.bak`;
        // Persist tail hash pointer into plugin_kv ns=audit-index BEFORE rotating file (ADR-05).
        if (input.kvPool) {
          Effect.runSync(
            input.kvPool.set(
              "kernel",
              "audit-index",
              input.streamId,
              JSON.stringify({ tailHash: prevHash, seq: nextSeq - 1, rotatedTo: archivePath }),
            ),
          );
        }
        NodeFS.renameSync(input.filePath, archivePath);
      }

      const seq = nextSeq++;
      const eventHash = NodeCrypto.createHash("sha256")
        .update(`${prevHash}|${seq}|${canonicalJson(payload)}`)
        .digest("hex");
      const record: HashChainedAuditRecord<TPayload> = {
        seq,
        prevHash,
        eventHash,
        ts: Date.now(),
        payload,
      };
      NodeFS.appendFileSync(input.filePath, `${JSON.stringify(record)}\n`, "utf8");
      prevHash = eventHash;
      return record;
    },
    verify: () => {
      existing = readExisting();
      const indexRaw = input.kvPool?.get("kernel", "audit-index", input.streamId);
      const indexedTail = indexRaw
        ? (JSON.parse(indexRaw) as { readonly tailHash?: string }).tailHash
        : undefined;
      let expectedPrev = indexedTail ?? genesisHash;
      if (existing.length === 0) {
        return {
          state: indexedTail ? "rotated-unverified" : "verified",
          count: 0,
          tailHash: expectedPrev,
        };
      }
      for (const rec of existing) {
        if (rec.prevHash !== expectedPrev) {
          return { state: "broken", count: existing.length, tailHash: rec.eventHash };
        }
        const recomputed = NodeCrypto.createHash("sha256")
          .update(`${rec.prevHash}|${rec.seq}|${canonicalJson(rec.payload)}`)
          .digest("hex");
        if (recomputed !== rec.eventHash) {
          return { state: "broken", count: existing.length, tailHash: rec.eventHash };
        }
        expectedPrev = rec.eventHash;
      }
      return { state: "verified", count: existing.length, tailHash: expectedPrev };
    },
  };
}

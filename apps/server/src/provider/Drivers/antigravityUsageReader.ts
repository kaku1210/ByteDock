// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime, and worker_threads offloads sync node:sqlite + protobuf decoding off the event loop.
import * as NodeFSP from "node:fs/promises";
import * as NodeWorkerThreads from "node:worker_threads";

import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

function fields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? new Map<number, FieldValue[]>() : fields(bytes);
};
const timestamp = (value: Fields) => {
  const seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;
};

/** Creation time in a persisted Antigravity step's metadata, in epoch milliseconds. */
export function readAntigravityStepTimestamp(metadata: Uint8Array): number | null {
  return timestamp(nested(fields(metadata), 1));
}

// Offline fallback for records without names. New names are learned from the scanned metadata.
// Cross-checked against ccusage's Antigravity parser and mrexodia/agent-cost-dashboard.
const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
  1537: "gemini-pro-orchestrator-neon",
};

// Effort and routing variants share the base model's price.
export const antigravityRateModel = (model: string) => {
  const base = model.replace(
    /-(?:extra-low|low|medium|xhigh|high|tiered|control|thinking|agent|orchestrator)$/,
    "",
  );
  return /^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
    ? "gemini-3.5-flash"
    : model === "gemini-3.7-flash-safety-le"
      ? "gemini-3.7-flash"
      : model === "gemini-pro-orchestrator-neon"
        ? "gemini-4-neon"
        : model === "gemini-pro-orchestrator-g1-pro"
          ? "gemini-4-argon"
          : base === "gemini-3-flash"
            ? "gemini-3-flash-preview"
            : base;
};

function withRateModel(record: UsageRecord): UsageRecord {
  const rateModel = antigravityRateModel(record.model);
  return rateModel === record.model ? record : { ...record, rateModel };
}

function isConcreteModel(model: string): boolean {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

function rememberModel(models: Map<number, string | null>, id: number, model: string | null) {
  const previous = models.get(id);
  models.set(id, previous === undefined || previous === model ? model : null);
}

interface CompactUsage {
  readonly modelId: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly keys: readonly string[];
}

interface Metadata {
  readonly model: string;
  readonly modelId: number;
  readonly executionId: string;
  readonly timestampMs: number | null;
  readonly startTimestampMs: number | null;
  readonly usages: readonly CompactUsage[];
}

interface RowMetadataEntry {
  readonly rowId: number;
  readonly idx: number;
  readonly entry: Metadata;
}

interface UsageCandidate {
  record: UsageRecord;
  modelId: number;
  modelQuality: number;
  keys: readonly string[];
  timestampQuality: number;
}

interface IncrementalCursor {
  readonly genCount: number;
  readonly genMaxRowId: number;
  readonly stepCount: number;
  readonly stepMaxRowId: number;
  readonly nullStepRowIds: readonly number[];
  readonly trajectoryTimestamp: number | null;
  readonly generations: readonly RowMetadataEntry[];
  readonly steps: readonly RowMetadataEntry[];
}

interface WorkerReadRequest {
  readonly id: number;
  readonly path: string;
  readonly incremental?: {
    readonly genCount: number;
    readonly genMaxRowId: number;
    readonly stepCount: number;
    readonly stepMaxRowId: number;
    readonly nullStepRowIds: readonly number[];
    readonly hasTrajectoryTimestamp: boolean;
  };
}

interface WorkerReadPayload {
  readonly empty: boolean;
  readonly incremental: boolean;
  readonly genCount: number;
  readonly genMaxRowId: number;
  readonly stepCount: number;
  readonly stepMaxRowId: number;
  readonly nullStepRowIds: readonly number[];
  readonly trajectoryTimestamp: number | null;
  readonly generations: readonly RowMetadataEntry[];
  readonly steps: readonly RowMetadataEntry[];
}

type WorkerReadResponse =
  | { readonly id: number; readonly ok: true; readonly data: WorkerReadPayload | null }
  | { readonly id: number; readonly ok: false; readonly error: string };

class AntigravityDatabaseDecodeError extends Schema.TaggedError<AntigravityDatabaseDecodeError>()(
  "AntigravityDatabaseDecodeError",
  { path: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Antigravity usage could not be decoded from ${this.path}.`;
  }
}

/** Databases at or above this size use incremental rowid scanning on subsequent changes. */
const INCREMENTAL_MIN_BYTES = 2 * 1024 * 1024;
/** Re-check a small tail window on incremental scans in case the latest turn row updated in-place. */
const INCREMENTAL_TAIL_RECHECK_ROWS = 4;
const WORKER_IDLE_TIMEOUT_MS = 30_000;

// Inline worker source runs off the main event loop across dev, vp pack bundles, server.asar, and SEA builds.
const ANTIGRAVITY_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const decoder = new TextDecoder("utf-8", { fatal: true });
const GENERATION_PAGE_ROWS = 16;
const STEP_PAGE_ROWS = 128;
const TAIL_RECHECK_ROWS = ${INCREMENTAL_TAIL_RECHECK_ROWS};

function fields(bytes) {
  let offset = 0;
  const result = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number);
    if (entries === undefined) result.set(number, [value]);
    else entries.push(value);
  }
  return result;
}

const numberAt = (value, key) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value, key) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value, key) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? new Map() : fields(bytes);
};
const textAt = (value, key) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? "" : decoder.decode(bytes).trim();
};
const timestamp = (value) => {
  const seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1000000) : null;
};

function modelName(name) {
  if (!name) return "";
  const normalized = name
    .toLowerCase()
    .replace(/\\s*\\(([^)]*)\\)\\s*$/, "-$1")
    .replace(/\\s+/g, "-");
  if (normalized.startsWith("claude-")) {
    return normalized
      .replace(/^claude-(\\d+(?:\\.\\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
      .replaceAll(".", "-");
  }
  return normalized;
}

function isConcreteModel(model) {
  return (
    /^(?:gemini-\\d|claude-(?:sonnet|opus|haiku)-\\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

function compactUsage(usageFields) {
  const outputTokens = Math.max(
    numberAt(usageFields, 3),
    numberAt(usageFields, 9) + numberAt(usageFields, 10),
  );
  const keys = [];
  for (const key of [11, 12, 7]) {
    const id = textAt(usageFields, key);
    if (id) keys.push("antigravity:" + key + ":" + id);
  }
  return {
    modelId: numberAt(usageFields, 1),
    uncachedInputTokens: numberAt(usageFields, 2),
    cachedInputTokens: numberAt(usageFields, 5),
    cacheCreationTokens: numberAt(usageFields, 4),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, numberAt(usageFields, 9)),
    keys,
  };
}

function resolveRowUsages(primaryUsage, attemptUsages) {
  if (primaryUsage === undefined) return attemptUsages;
  if (attemptUsages.length === 0) return [primaryUsage];
  let uncached = 0;
  let cached = 0;
  let cacheCreation = 0;
  let output = 0;
  let reasoning = 0;
  for (const attempt of attemptUsages) {
    uncached += attempt.uncachedInputTokens;
    cached += attempt.cachedInputTokens;
    cacheCreation += attempt.cacheCreationTokens;
    output += attempt.outputTokens;
    reasoning += attempt.reasoningTokens;
  }
  const attemptsEqualPrimary =
    uncached === primaryUsage.uncachedInputTokens &&
    cached === primaryUsage.cachedInputTokens &&
    cacheCreation === primaryUsage.cacheCreationTokens &&
    output === primaryUsage.outputTokens &&
    reasoning === primaryUsage.reasoningTokens;
  if (!attemptsEqualPrimary) {
    return [primaryUsage, ...attemptUsages];
  }
  if (attemptUsages.length === 1) {
    const attempt = attemptUsages[0];
    const keys = [...new Set([...primaryUsage.keys, ...attempt.keys])];
    return [
      {
        ...primaryUsage,
        modelId: primaryUsage.modelId || attempt.modelId,
        keys,
      },
    ];
  }
  return attemptUsages;
}

function decodeMetadata(bytes, step) {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) {
    throw new Error("Missing Antigravity generation metadata");
  }
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usageBytes = bytesAt(data, step ? 9 : 4);
  const primaryUsageFields = usageBytes === undefined ? undefined : fields(usageBytes);
  const primaryUsage =
    primaryUsageFields === undefined ? undefined : compactUsage(primaryUsageFields);
  const attemptUsages = [];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) attemptUsages.push(compactUsage(fields(retryUsage)));
  }
  const usages = resolveRowUsages(primaryUsage, attemptUsages);
  const names = [textAt(model, step ? 12 : 19), textAt(model, step ? 8 : 21)].map(modelName);
  const startTimestampMs = step
    ? timestamp(nested(data, 1))
    : timestamp(nested(nested(data, 9), 4));
  return {
    model:
      names.find(isConcreteModel) ?? names.find((name) => name && !/^model[_-]/.test(name)) ?? "",
    modelId:
      numberAt(model, step ? 1 : 3) ||
      (primaryUsageFields === undefined ? 0 : numberAt(primaryUsageFields, 1)),
    executionId: step ? textAt(data, 12) : textAt(root, 4),
    timestampMs: step ? (timestamp(nested(data, 8)) ?? startTimestampMs) : startTimestampMs,
    startTimestampMs,
    usages,
  };
}

function assertBlob(value) {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Antigravity metadata blob");
  return value;
}

function tableStats(db, table) {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt, COALESCE(MAX(rowid), -1) AS max_id FROM " + table)
    .get();
  return {
    count: Number(row?.cnt ?? 0),
    maxRowId: Number(row?.max_id ?? -1),
  };
}

function readPagedRows(db, query, pageRows, step, startAfter, nullRowIdsOut) {
  const stmt = db.prepare(query);
  const entries = [];
  let after = startAfter;
  while (true) {
    const rows = stmt.all(after, pageRows);
    for (const row of rows) {
      if (step && row.data === null) {
        if (nullRowIdsOut !== null) nullRowIdsOut.push(Number(row.row_id));
        continue;
      }
      if (typeof row.idx !== "number") throw new Error("Invalid Antigravity metadata idx");
      entries.push({
        rowId: Number(row.row_id),
        idx: row.idx,
        entry: decodeMetadata(assertBlob(row.data), step),
      });
    }
    if (rows.length < pageRows) break;
    after = Number(rows[rows.length - 1].row_id);
  }
  return entries;
}

function readSpecificStepRowIds(db, rowIds, stillNullOut) {
  if (rowIds.length === 0) return [];
  const entries = [];
  const stmt = db.prepare("SELECT rowid AS row_id, idx, metadata AS data FROM steps WHERE rowid = ?");
  for (const rowId of rowIds) {
    const row = stmt.get(rowId);
    if (!row) continue;
    if (row.data === null) {
      stillNullOut.push(Number(row.row_id));
      continue;
    }
    if (typeof row.idx !== "number") throw new Error("Invalid Antigravity metadata idx");
    entries.push({
      rowId: Number(row.row_id),
      idx: row.idx,
      entry: decodeMetadata(assertBlob(row.data), true),
    });
  }
  return entries;
}

function readDatabaseFile(req) {
  const db = new DatabaseSync(req.path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA busy_timeout = 100");
    db.exec("BEGIN");
    try {
      const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const tables = new Set(tableRows.map((row) => row.name));
      if (tables.size === 0) {
        return {
          empty: true,
          incremental: false,
          genCount: 0,
          genMaxRowId: -1,
          stepCount: 0,
          stepMaxRowId: -1,
          nullStepRowIds: [],
          trajectoryTimestamp: null,
          generations: [],
          steps: [],
        };
      }
      if (!tables.has("gen_metadata") && !tables.has("steps")) {
        return null;
      }

      const genStats = tables.has("gen_metadata")
        ? tableStats(db, "gen_metadata")
        : { count: 0, maxRowId: -1 };
      const stepStats = tables.has("steps")
        ? tableStats(db, "steps")
        : { count: 0, maxRowId: -1 };

      const inc = req.incremental;
      const canIncremental =
        inc !== undefined &&
        genStats.count >= inc.genCount &&
        genStats.maxRowId >= inc.genMaxRowId &&
        stepStats.count >= inc.stepCount &&
        stepStats.maxRowId >= inc.stepMaxRowId;

      let trajectoryTimestamp = null;
      if (tables.has("trajectory_metadata_blob") && (!canIncremental || !inc.hasTrajectoryTimestamp)) {
        const trajRows = db.prepare("SELECT data FROM trajectory_metadata_blob").all();
        for (const row of trajRows) {
          if (trajectoryTimestamp === null) {
            trajectoryTimestamp = timestamp(nested(fields(assertBlob(row.data)), 2));
          }
        }
      }

      const nullStepRowIds = [];
      let generations = [];
      let steps = [];

      if (canIncremental) {
        if (tables.has("gen_metadata")) {
          const genStart = Math.max(-1, inc.genMaxRowId - TAIL_RECHECK_ROWS);
          generations = readPagedRows(
            db,
            "SELECT rowid AS row_id, idx, data FROM gen_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?",
            GENERATION_PAGE_ROWS,
            false,
            genStart,
            null,
          );
        }
        if (tables.has("steps")) {
          const stepStart = Math.max(-1, inc.stepMaxRowId - TAIL_RECHECK_ROWS);
          const recheckNulls = inc.nullStepRowIds.filter((id) => id <= stepStart);
          const resolvedNulls = readSpecificStepRowIds(db, recheckNulls, nullStepRowIds);
          const tailAndNew = readPagedRows(
            db,
            "SELECT rowid AS row_id, idx, metadata AS data FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
            STEP_PAGE_ROWS,
            true,
            stepStart,
            nullStepRowIds,
          );
          steps = resolvedNulls.concat(tailAndNew);
        }
      } else {
        if (tables.has("gen_metadata")) {
          generations = readPagedRows(
            db,
            "SELECT rowid AS row_id, idx, data FROM gen_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?",
            GENERATION_PAGE_ROWS,
            false,
            -1,
            null,
          );
        }
        if (tables.has("steps")) {
          steps = readPagedRows(
            db,
            "SELECT rowid AS row_id, idx, metadata AS data FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
            STEP_PAGE_ROWS,
            true,
            -1,
            nullStepRowIds,
          );
        }
      }

      return {
        empty: false,
        incremental: canIncremental,
        genCount: genStats.count,
        genMaxRowId: genStats.maxRowId,
        stepCount: stepStats.count,
        stepMaxRowId: stepStats.maxRowId,
        nullStepRowIds,
        trajectoryTimestamp,
        generations,
        steps,
      };
    } finally {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
  } finally {
    db.close();
  }
}

parentPort.on("message", (req) => {
  try {
    const data = readDatabaseFile(req);
    parentPort.postMessage({ id: req.id, ok: true, data });
  } catch (err) {
    parentPort.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
`;

interface PendingWorkerJob {
  readonly resolve: (value: WorkerReadPayload | null) => void;
  readonly reject: (reason: unknown) => void;
}

class AntigravityWorkerClient {
  private worker: NodeWorkerThreads.Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingWorkerJob>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private clearIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleShutdown() {
    this.clearIdleTimer();
    if (this.pending.size > 0 || this.worker === null) return;
    // @effect-diagnostics-next-line globalTimers:off - Plain Worker idle shutdown timer outside Effect runtime.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0 && this.worker !== null) {
        const w = this.worker;
        this.worker = null;
        void w.terminate();
      }
    }, WORKER_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private failAll(error: Error) {
    for (const [, job] of this.pending) {
      job.reject(error);
    }
    this.pending.clear();
  }

  private ensureWorker(): NodeWorkerThreads.Worker {
    if (this.worker !== null) return this.worker;
    const worker = new NodeWorkerThreads.Worker(ANTIGRAVITY_WORKER_SOURCE, { eval: true });
    worker.unref();
    worker.on("message", (msg: WorkerReadResponse) => {
      const job = this.pending.get(msg.id);
      if (!job) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        job.resolve(msg.data);
      } else {
        job.reject(new Error(msg.error));
      }
      this.scheduleIdleShutdown();
    });
    worker.on("error", (err) => {
      if (this.worker === worker) this.worker = null;
      this.clearIdleTimer();
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      this.clearIdleTimer();
      if (this.pending.size > 0) {
        this.failAll(new Error(`Antigravity usage worker exited unexpectedly (code=${code})`));
      }
    });
    this.worker = worker;
    return worker;
  }

  read(request: Omit<WorkerReadRequest, "id">): Promise<WorkerReadPayload | null> {
    this.clearIdleTimer();
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads Worker.postMessage has no targetOrigin parameter.
      worker.postMessage({ ...request, id });
    });
  }
}

const sharedAntigravityWorker = new AntigravityWorkerClient();

function mergeRowEntries(
  previous: readonly RowMetadataEntry[],
  updates: readonly RowMetadataEntry[],
): RowMetadataEntry[] {
  if (updates.length === 0) return [...previous];
  const byRowId = new Map<number, RowMetadataEntry>();
  for (const item of previous) byRowId.set(item.rowId, item);
  for (const item of updates) byRowId.set(item.rowId, item);
  return [...byRowId.values()].sort((a, b) => a.idx - b.idx || a.rowId - b.rowId);
}

function buildDatabaseResult(
  sessionId: string,
  generations: readonly RowMetadataEntry[],
  steps: readonly RowMetadataEntry[],
  trajectoryTimestamp: number | null,
  fallbackTimestamp: number,
) {
  const models = new Map<number, string | null>();
  for (const { entry } of generations) {
    if (entry.modelId > 0 && isConcreteModel(entry.model)) {
      rememberModel(models, entry.modelId, entry.model);
    }
  }
  for (const { entry } of steps) {
    if (entry.modelId > 0 && isConcreteModel(entry.model)) {
      rememberModel(models, entry.modelId, entry.model);
    }
  }
  return {
    candidates: usageCandidates(
      sessionId,
      generations,
      steps,
      trajectoryTimestamp,
      fallbackTimestamp,
    ),
    models,
  };
}

async function readDatabase(
  path: string,
  sessionId: string,
  fallbackTimestamp: number,
  fileSizeBytes: number,
  previousCursor?: IncrementalCursor,
): Promise<{ data: DecodedDatabase; cursor: IncrementalCursor | undefined }> {
  const useIncremental = previousCursor !== undefined && fileSizeBytes >= INCREMENTAL_MIN_BYTES;
  const payload = await sharedAntigravityWorker.read({
    path,
    ...(useIncremental
      ? {
          incremental: {
            genCount: previousCursor.genCount,
            genMaxRowId: previousCursor.genMaxRowId,
            stepCount: previousCursor.stepCount,
            stepMaxRowId: previousCursor.stepMaxRowId,
            nullStepRowIds: previousCursor.nullStepRowIds,
            hasTrajectoryTimestamp: previousCursor.trajectoryTimestamp !== null,
          },
        }
      : {}),
  });

  if (payload === null) {
    return { data: null, cursor: undefined };
  }
  if (payload.empty) {
    return {
      data: { candidates: [] as UsageCandidate[], models: new Map<number, string | null>() },
      cursor: undefined,
    };
  }

  const generations =
    payload.incremental && previousCursor !== undefined
      ? mergeRowEntries(previousCursor.generations, payload.generations)
      : [...payload.generations].sort((a, b) => a.idx - b.idx || a.rowId - b.rowId);
  const steps =
    payload.incremental && previousCursor !== undefined
      ? mergeRowEntries(previousCursor.steps, payload.steps)
      : [...payload.steps].sort((a, b) => a.idx - b.idx || a.rowId - b.rowId);
  const trajectoryTimestamp =
    payload.incremental && previousCursor !== undefined
      ? (previousCursor.trajectoryTimestamp ?? payload.trajectoryTimestamp)
      : payload.trajectoryTimestamp;

  const data = buildDatabaseResult(
    sessionId,
    generations,
    steps,
    trajectoryTimestamp,
    fallbackTimestamp,
  );
  const cursor: IncrementalCursor | undefined =
    fileSizeBytes >= INCREMENTAL_MIN_BYTES
      ? {
          genCount: payload.genCount,
          genMaxRowId: payload.genMaxRowId,
          stepCount: payload.stepCount,
          stepMaxRowId: payload.stepMaxRowId,
          nullStepRowIds: payload.nullStepRowIds,
          trajectoryTimestamp,
          generations,
          steps,
        }
      : undefined;

  return { data, cursor };
}

const KEYLESS_PAIR_TIMESTAMP_TOLERANCE_MS = 5_000;

function totalsEqual(left: UsageRecord["totals"], right: UsageRecord["totals"]): boolean {
  return (
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheCreationTokens === right.cacheCreationTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens
  );
}

function usageCandidates(
  sessionId: string,
  generations: ReadonlyArray<{ idx: number; entry: Metadata }>,
  steps: ReadonlyArray<{ idx: number; entry: Metadata }>,
  trajectoryTimestamp: number | null,
  fallbackTimestamp: number,
): UsageCandidate[] {
  const records: UsageCandidate[] = [];
  const keylessSteps: Array<{
    readonly candidateIndex: number;
    readonly index: number;
    readonly usageIndex: number;
    readonly executionId: string;
    readonly startTimestampMs: number;
    readonly modelId: number;
    readonly totals: UsageRecord["totals"];
    matched: boolean;
  }> = [];
  const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry]));
  for (const [source, entries] of [
    ["step", steps],
    ["generation", generations],
  ] as const) {
    for (const [index, { idx, entry }] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const modelId = usage.modelId || entry.modelId;
        const generation = source === "step" ? generationModels.get(idx) : undefined;
        // A retry can use a different model than its enclosing generation or step.
        const matches = (meta: Metadata) => modelId === 0 || meta.modelId === modelId;
        const model =
          matches(entry) && entry.model
            ? entry.model
            : generation && matches(generation)
              ? generation.model
              : "";
        const totals = {
          uncachedInputTokens: usage.uncachedInputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
        };
        if (
          totals.uncachedInputTokens +
            totals.cachedInputTokens +
            totals.cacheCreationTokens +
            usage.outputTokens ===
          0
        )
          continue;
        const keys = [...usage.keys];
        const candidateIndex = records.length;
        if (keys.length === 0 && entry.startTimestampMs !== null) {
          if (source === "step") {
            keylessSteps.push({
              candidateIndex,
              index,
              usageIndex,
              executionId: entry.executionId,
              startTimestampMs: entry.startTimestampMs,
              modelId,
              totals,
              matched: false,
            });
          } else {
            // Pair keyless gen_metadata entries 1-to-1 with their matching step record so
            // historical Antigravity rows without response IDs are not counted twice.
            let bestStep: (typeof keylessSteps)[number] | undefined;
            let bestDiff = KEYLESS_PAIR_TIMESTAMP_TOLERANCE_MS + 1;
            for (const stepCandidate of keylessSteps) {
              if (stepCandidate.matched) continue;
              if (!totalsEqual(stepCandidate.totals, totals)) continue;
              if (
                stepCandidate.executionId &&
                entry.executionId &&
                stepCandidate.executionId !== entry.executionId
              ) {
                continue;
              }
              if (stepCandidate.modelId > 0 && modelId > 0 && stepCandidate.modelId !== modelId) {
                continue;
              }
              const diff = Math.abs(stepCandidate.startTimestampMs - entry.startTimestampMs);
              if (diff <= KEYLESS_PAIR_TIMESTAMP_TOLERANCE_MS && diff < bestDiff) {
                bestDiff = diff;
                bestStep = stepCandidate;
              }
            }
            if (bestStep !== undefined) {
              bestStep.matched = true;
              const pairKey = `antigravity:${sessionId}:pair:${bestStep.index}:${bestStep.usageIndex}`;
              records[bestStep.candidateIndex] = {
                ...records[bestStep.candidateIndex]!,
                keys: [...records[bestStep.candidateIndex]!.keys, pairKey],
              };
              keys.push(pairKey);
            }
          }
        }
        const record: UsageRecord = {
          provider: "antigravity",
          sessionId,
          timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
          model,
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: usage.keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
        };
        records.push({
          record,
          modelId,
          modelQuality: isConcreteModel(model) ? 4 : model ? 1 : 0,
          keys,
          timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
        });
      }
    }
  }
  return records;
}

type DecodedDatabase = {
  readonly candidates: UsageCandidate[];
  readonly models: Map<number, string | null>;
} | null;

interface CachedDatabase {
  readonly fingerprint: string;
  readonly data: DecodedDatabase;
  readonly cursor?: IncrementalCursor | undefined;
}

const inFlightByCache = new WeakMap<
  Map<string, CachedDatabase>,
  Map<string, Promise<DecodedDatabase>>
>();

/** Fingerprint canonical DB/WAL paths by size, mtime and ctime; WAL holds new rows, and ctime catches restored mtimes. */
export const makeAntigravityUsageCache = () => new Map<string, CachedDatabase>();

export const readAntigravityUsage = Effect.fn("readAntigravityUsage")(function* (
  conversationsDirectories: string | readonly string[],
  sinceMs: number,
  cache?: Map<string, CachedDatabase>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const roots =
    typeof conversationsDirectories === "string"
      ? [conversationsDirectories]
      : conversationsDirectories;
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    canonicalRoots.push(
      yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => pathService.resolve(root))),
    );
  }
  const files: Array<{ root: string; path: string; records: UsageRecord[] }> = [];
  const errors: string[] = [];
  const models = new Map<number, string | null>();
  const pending: Array<{ data: NonNullable<DecodedDatabase>; fileIndex: number }> = [];
  const identities = new Map<string, number>();
  const groups: Array<
    UsageCandidate & { parent: number; size: number; owner: number; fileIndex: number }
  > = [];
  const find = (index: number): number => {
    let root = index;
    while (groups[root]!.parent !== root) root = groups[root]!.parent;
    while (index !== root) {
      const parent = groups[index]!.parent;
      groups[index]!.parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left: number, right: number): number => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
    const target = groups[a]!;
    const source = groups[b]!;
    const first = target.owner < source.owner ? target : source;
    const bestModel =
      source.modelQuality === target.modelQuality
        ? first
        : source.modelQuality > target.modelQuality
          ? source
          : target;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.record.timestampMs < target.record.timestampMs)
        ? source
        : target;
    const x = target.record.totals;
    const y = source.record.totals;
    target.record = {
      ...first.record,
      model: bestModel.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
      },
    };
    target.timestampQuality = bestTime.timestampQuality;
    target.modelQuality = bestModel.modelQuality;
    target.owner = first.owner;
    target.fileIndex = first.fileIndex;
    target.size += source.size;
    source.parent = a;
    return a;
  };
  const append = (candidate: UsageCandidate, fileIndex: number) => {
    const index = groups.length;
    groups.push({ ...candidate, parent: index, size: 1, owner: index, fileIndex });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) merge(index, existing);
      identities.set(key, index);
    }
  };
  const visited = new Set<string>();
  const inFlight =
    cache === undefined
      ? undefined
      : (inFlightByCache.get(cache) ??
        (() => {
          const map = new Map<string, Promise<DecodedDatabase>>();
          inFlightByCache.set(cache, map);
          return map;
        })());

  const readFile = Effect.fn("readAntigravityUsage.readFile")(function* (path: string) {
    const canonical = yield* fileSystem.realPath(path);
    if (visited.has(canonical)) return null;
    visited.add(canonical);
    const fingerprintOf = (file: string) =>
      Effect.tryPromise({
        try: () => NodeFSP.stat(file),
        catch: (cause) => new AntigravityDatabaseDecodeError({ path: file, cause }),
      }).pipe(
        Effect.map((stat) => ({ stat, part: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` })),
      );
    const { stat, part } = yield* fingerprintOf(path);
    const wal = yield* fingerprintOf(`${path}-wal`).pipe(Effect.option);
    const fingerprint = `${part}/${wal._tag === "Some" ? wal.value.part : "-"}`;
    const cached = cache?.get(canonical);
    if (cached?.fingerprint === fingerprint) return cached.data;

    const existingFlight = inFlight?.get(`${canonical}\0${fingerprint}`);
    if (existingFlight !== undefined) {
      return yield* Effect.tryPromise({
        try: () => existingFlight,
        catch: (cause) => new AntigravityDatabaseDecodeError({ path, cause }),
      });
    }

    const runRead = readDatabase(
      path,
      pathService.basename(path, ".db"),
      stat.mtimeMs,
      stat.size,
      cached?.cursor,
    ).then((result) => {
      cache?.set(canonical, { fingerprint, data: result.data, cursor: result.cursor });
      return result.data;
    });

    const flightKey = `${canonical}\0${fingerprint}`;
    inFlight?.set(flightKey, runRead);
    try {
      return yield* Effect.tryPromise({
        try: () => runRead,
        catch: (cause) => new AntigravityDatabaseDecodeError({ path, cause }),
      });
    } finally {
      if (inFlight?.get(flightKey) === runRead) {
        inFlight.delete(flightKey);
      }
    }
  });

  const walk = Effect.fn("antigravityUsageReader.walk")(function* (
    directory: string,
    root: string,
  ): Effect.fn.Return<void> {
    const dirents = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(directory, { withFileTypes: true }),
      catch: (cause) => new AntigravityDatabaseDecodeError({ path: directory, cause }),
    }).pipe(
      Effect.catch((err) => {
        const cause = err.cause;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause
            ? (cause as { code?: unknown }).code
            : undefined;
        if (code !== "ENOENT") errors.push(directory);
        return Effect.succeed(null);
      }),
    );
    if (dirents === null) return;
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      // Like a directory listing's entry types: symlinks are neither files nor directories.
      if (dirent.isSymbolicLink()) continue;
      const entryPath = pathService.join(directory, dirent.name);
      if (dirent.isDirectory()) {
        yield* walk(entryPath, root);
      } else if (dirent.name.endsWith(".db") && (dirent.isFile() || !dirent.isFIFO())) {
        const data = yield* readFile(entryPath).pipe(
          Effect.catch(() => {
            errors.push(entryPath);
            return Effect.succeed(null);
          }),
        );
        if (data === null) continue;
        for (const [id, model] of data.models) {
          rememberModel(models, id, model);
        }
        const fileIndex = files.length;
        files.push({ root, path: entryPath, records: [] });
        pending.push({ data, fileIndex });
      }
    }
  });

  for (const root of roots) yield* walk(root, root);
  if (cache !== undefined) {
    const belongsToScannedRoot = (key: string) =>
      canonicalRoots.some(
        (root) =>
          key === root ||
          key.startsWith(`${root}${pathService.sep}`) ||
          (pathService.sep === "\\" &&
            key.toLowerCase().startsWith(`${root.toLowerCase()}${pathService.sep}`)),
      );
    for (const key of cache.keys()) {
      if (!visited.has(key) && belongsToScannedRoot(key)) {
        cache.delete(key);
      }
    }
  }
  for (const { data, fileIndex } of pending) {
    for (const [index, candidate] of data.candidates.entries()) {
      const learned = models.get(candidate.modelId);
      const fallback = learned === null ? undefined : MODEL_IDS[candidate.modelId];
      const model =
        (candidate.modelQuality === 4 ? candidate.record.model : "") ||
        learned ||
        fallback ||
        candidate.record.model ||
        (candidate.modelId > 0 ? `antigravity-model-${candidate.modelId}` : "antigravity-unknown");
      append(
        {
          ...candidate,
          record: { ...candidate.record, model },
          modelQuality:
            candidate.modelQuality === 4 ? 4 : learned ? 3 : fallback ? 2 : candidate.modelQuality,
        },
        fileIndex,
      );
      if (index % 256 === 255) yield* Effect.yieldNow;
    }
  }
  for (const [index, group] of groups.entries()) {
    if (group.parent === index && group.record.timestampMs >= sinceMs) {
      files[group.fileIndex]!.records.push(withRateModel(group.record));
    }
  }
  return { files, errors };
});

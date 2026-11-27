// @effect-diagnostics nodeBuiltinImport:off -- node:fs and node:sqlite read native session task logs read-only without following symlinks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { decodeAntigravityStepToolCall } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;
const RUN_COMMAND_STEP_TYPE = 21;
const GENERIC_STEP_TYPE = 132;
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_STEP_SCAN_ROWS = 400;
const LOCATE_POLL_MS = 500;
const TAIL_POLL_MS = 250;
const MAX_READ_BYTES = 256 * 1024;

function findCommandStepIndex(databasePath: string, toolCallId: string): number | undefined {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    const hasSteps =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
        .get() !== undefined;
    if (!hasSteps) return undefined;
    const columns = new Set(
      database
        .prepare("PRAGMA table_info(steps)")
        .all()
        .flatMap((row) =>
          row !== null && typeof row === "object" && "name" in row && typeof row.name === "string"
            ? [row.name]
            : [],
        ),
    );
    if (!columns.has("idx") || !columns.has("step_type")) return undefined;
    const hasMetadata = columns.has("metadata");
    const hasPayload = columns.has("step_payload");
    if (!hasMetadata && !hasPayload) return undefined;
    const selectColumns = [
      "idx",
      "step_type AS stepType",
      hasMetadata
        ? "CASE WHEN length(metadata) <= ? THEN metadata END AS metadata"
        : "NULL AS metadata",
      hasPayload
        ? "CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload"
        : "NULL AS step_payload",
    ].join(", ");
    const bindArgs: Array<number> = [];
    if (hasMetadata) bindArgs.push(MAX_STEP_BYTES);
    if (hasPayload) bindArgs.push(MAX_STEP_BYTES);
    bindArgs.push(RUN_COMMAND_STEP_TYPE, GENERIC_STEP_TYPE, MAX_STEP_SCAN_ROWS);
    const rows = database
      .prepare(
        `SELECT ${selectColumns}
         FROM steps
         WHERE step_type IN (?, ?)
         ORDER BY idx DESC
         LIMIT ?`,
      )
      .iterate(...bindArgs);
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const stepType = "stepType" in row ? Number(row.stepType) : 0;
      const idx = "idx" in row ? Number(row.idx) : -1;
      if (!Number.isInteger(idx) || idx < 0) continue;
      const metadata =
        "metadata" in row && row.metadata instanceof Uint8Array ? row.metadata : undefined;
      const payload =
        "step_payload" in row && row.step_payload instanceof Uint8Array
          ? row.step_payload
          : undefined;
      const toolCall = decodeAntigravityStepToolCall({ metadata, payload });
      if (stepType === GENERIC_STEP_TYPE && toolCall?.name !== "run_command") {
        continue;
      }
      if (toolCall?.id === toolCallId) {
        return idx;
      }
    }
    return undefined;
  } finally {
    database.close();
  }
}

async function resolveTaskLogPath(
  profileDirectory: string,
  sessionId: string,
  toolCallId: string,
  cachedStepIndex: number | undefined,
): Promise<{ readonly stepIndex: number | undefined; readonly logPath: string | undefined }> {
  const profileRoot = await antigravityProfileRoot(profileDirectory);
  if (profileRoot === undefined) return { stepIndex: cachedStepIndex, logPath: undefined };
  let stepIndex = cachedStepIndex;
  if (stepIndex === undefined) {
    const databasePath = (
      await antigravityManagedPath(
        profileRoot,
        ["antigravity-acp", "conversations", `${sessionId}.db`],
        "file",
      )
    )?.path;
    if (databasePath === undefined) return { stepIndex: undefined, logPath: undefined };
    stepIndex = findCommandStepIndex(databasePath, toolCallId);
    if (stepIndex === undefined) return { stepIndex: undefined, logPath: undefined };
  }
  const logEntry = await antigravityManagedPath(
    profileRoot,
    ["antigravity-acp", "brain", sessionId, ".system_generated", "tasks", `task-${stepIndex}.log`],
    "file",
  );
  return { stepIndex, logPath: logEntry?.path };
}

type Utf8Decoder = InstanceType<typeof TextDecoder>;

async function readLogDelta(
  filePath: string,
  offset: number,
  decoder: Utf8Decoder,
): Promise<{
  readonly nextOffset: number;
  readonly nextDecoder: Utf8Decoder;
  readonly chunk: string;
}> {
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { nextOffset: offset, nextDecoder: decoder, chunk: "" };
    }
    const size = Number(stat.size);
    let currentOffset = offset;
    let currentDecoder = decoder;
    if (size < currentOffset) {
      currentOffset = 0;
      currentDecoder = new TextDecoder("utf-8", { fatal: false });
    }
    if (size <= currentOffset) {
      return { nextOffset: currentOffset, nextDecoder: currentDecoder, chunk: "" };
    }
    const start = size - currentOffset > MAX_READ_BYTES ? size - MAX_READ_BYTES : currentOffset;
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead <= 0) {
      return { nextOffset: currentOffset, nextDecoder: currentDecoder, chunk: "" };
    }
    const bytes = buffer.subarray(0, bytesRead);
    const skipped = start > currentOffset;
    let first = 0;
    if (skipped) {
      currentDecoder = new TextDecoder("utf-8", { fatal: false });
      while (first < bytes.length && ((bytes[first] ?? 0) & 0xc0) === 0x80) first += 1;
    }
    const text =
      (skipped ? "\n" : "") + currentDecoder.decode(bytes.subarray(first), { stream: true });
    return {
      nextOffset: start + bytesRead,
      nextDecoder: currentDecoder,
      chunk: text,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Tails `agy`'s background task log (`brain/<session>/.system_generated/tasks/task-<idx>.log`)
 * while a `run_command` tool call stays active. Fails closed on missing or linked paths so
 * live tailing never interrupts command execution.
 */
export const tailAntigravityCommandOutput = Effect.fn("AntigravityTaskOutputTail.tail")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly stop: Deferred.Deferred<void>;
    readonly onChunk: (chunk: string) => Effect.Effect<void>;
  }) {
    if (!NATIVE_ID.test(input.sessionId) || input.toolCallId.trim().length === 0) return;
    const waitOrStop = (durationMs: number) =>
      Deferred.await(input.stop).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: durationMs,
          orElse: () => Effect.succeed(false),
        }),
      );

    let stepIndex: number | undefined;
    let logPath: string | undefined;
    while (logPath === undefined) {
      const located = yield* Effect.promise(() =>
        resolveTaskLogPath(
          input.profileDirectory,
          input.sessionId,
          input.toolCallId,
          stepIndex,
        ).catch(() => ({ stepIndex, logPath: undefined })),
      );
      stepIndex = located.stepIndex;
      logPath = located.logPath;
      if (logPath !== undefined) break;
      if (yield* waitOrStop(LOCATE_POLL_MS)) return;
    }

    let offset = 0;
    let decoder = new TextDecoder("utf-8", { fatal: false });
    let last = yield* Deferred.isDone(input.stop);
    while (true) {
      const read = yield* Effect.promise(() =>
        readLogDelta(logPath, offset, decoder).catch(() => ({
          nextOffset: offset,
          nextDecoder: decoder,
          chunk: "",
        })),
      );
      offset = read.nextOffset;
      decoder = read.nextDecoder;
      if (read.chunk.length > 0) {
        yield* input.onChunk(read.chunk);
      }
      if (last) {
        const rest = decoder.decode();
        if (rest.length > 0) yield* input.onChunk(rest);
        return;
      }
      last = yield* waitOrStop(TAIL_POLL_MS);
    }
  },
);

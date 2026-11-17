// @effect-diagnostics nodeBuiltinImport:off -- native conversation databases are opened read-only.
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { readAntigravityStepTimestamp } from "../provider/Drivers/antigravityUsageReader.ts";
import type { AgentSessionThreadMessage } from "./AgentSessionScanner.ts";

const Summary = Schema.Struct({
  conversation_id: Schema.String.check(Schema.isUUID(4)),
  title: Schema.String,
  workspace_uris: Schema.String,
  last_modified_time: Schema.String,
});
const decodeSummary = Schema.decodeUnknownSync(Summary);
const decodeWorkspaces = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeOffsets = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
);
const decodeChunk = Schema.decodeUnknownSync(
  Schema.Struct({
    chunk_index: Schema.Int,
    archived: Schema.Int,
    user_body: Schema.String,
    agent_body: Schema.String,
    user_step_byte_offsets: Schema.NullOr(Schema.Union([Schema.String, Schema.Uint8Array])),
    agent_step_byte_offsets: Schema.NullOr(Schema.Union([Schema.String, Schema.Uint8Array])),
  }),
);
const decodeStep = Schema.decodeUnknownSync(
  Schema.Struct({
    step_type: Schema.Int,
    metadata: Schema.Uint8Array,
  }),
);
const decodeHistorySize = Schema.decodeUnknownSync(Schema.Struct({ bytes: Schema.Number }));
const MAX_SESSIONS = 5000;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES = 200;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class AntigravityHistoryReadError extends Schema.TaggedError<AntigravityHistoryReadError>()(
  "AntigravityHistoryReadError",
  { filePath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not read Antigravity history at ${this.filePath}.`;
  }
}

/** Desktop main-conversation metadata; children remain in the original app. */
export interface AntigravityHistoryEntry {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly filePath: string;
  readonly updatedAt: string;
}

/** Read the desktop catalog without starting or authenticating the ACP runtime. */
export const scanAntigravityHistory = Effect.fn("AntigravityHistory.scan")(function* (
  directory: string,
  unassignedWorkspaceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(directory, "conversation_summaries.db");
  if (!(yield* fs.exists(filePath))) return { entries: [], truncated: false };
  return yield* Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
      try {
        const summaries = db
          .prepare(
            "SELECT conversation_id,title,workspace_uris,last_modified_time FROM conversation_summaries WHERE parent_conversation_id IS NULL OR parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT ?",
          )
          .all(MAX_SESSIONS + 1);
        const entries = summaries.slice(0, MAX_SESSIONS).map((row): AntigravityHistoryEntry => {
          const summary = decodeSummary(row);
          const workspaces = decodeWorkspaces(summary.workspace_uris || "[]");
          const workspace = workspaces[0];
          const cwd =
            workspace === undefined ? unassignedWorkspaceRoot : NodeURL.fileURLToPath(workspace);
          const updatedAt = DateTime.formatIso(
            DateTime.makeUnsafe(summary.last_modified_time.replace(" ", "T")),
          );
          return {
            id: summary.conversation_id,
            title: summary.title,
            cwd,
            filePath: path.join(directory, "conversations", `${summary.conversation_id}.db`),
            updatedAt,
          };
        });
        return { entries, truncated: summaries.length > MAX_SESSIONS };
      } finally {
        db.close();
      }
    },
    catch: (cause) => new AntigravityHistoryReadError({ filePath, cause }),
  });
});

/** Read indexed visible text and validate each role and timestamp against its native step. */
export const readAntigravityHistory = Effect.fn("AntigravityHistory.read")(function* (
  entry: AntigravityHistoryEntry,
) {
  const path = yield* Path.Path;
  const filePath = path.join(
    path.dirname(path.dirname(entry.filePath)),
    "conversation_summaries.db",
  );
  return yield* Effect.try({
    try: () => {
      const index = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
      try {
        const trajectory = new NodeSqlite.DatabaseSync(entry.filePath, { readOnly: true });
        try {
          index.exec("BEGIN");
          trajectory.exec("BEGIN");
          const { bytes: historyBytes } = decodeHistorySize(
            index
              .prepare(
                "SELECT COALESCE(SUM(length(CAST(user_body AS BLOB)) + length(CAST(agent_body AS BLOB)) + COALESCE(length(user_step_byte_offsets),0) + COALESCE(length(agent_step_byte_offsets),0)),0) AS bytes FROM conversations_fts WHERE conversation_id = ? AND chunk_index >= 0",
              )
              .get(entry.id),
          );
          if (historyBytes > MAX_HISTORY_BYTES)
            throw new Error("Antigravity visible history exceeds 32 MiB");
          const step = trajectory.prepare("SELECT step_type,metadata FROM steps WHERE idx = ?");
          const messages = new Map<number, AgentSessionThreadMessage>();
          let archived = false;
          for (const row of index
            .prepare(
              "SELECT chunk_index,archived,user_body,agent_body,user_step_byte_offsets,agent_step_byte_offsets FROM conversations_fts WHERE conversation_id = ? ORDER BY chunk_index",
            )
            .iterate(entry.id)) {
            const chunk = decodeChunk(row);
            archived ||= chunk.archived !== 0;
            if (chunk.chunk_index < 0) continue;
            for (const [role, body, rawOffsets, expectedType] of [
              ["user", chunk.user_body, chunk.user_step_byte_offsets, 14],
              ["assistant", chunk.agent_body, chunk.agent_step_byte_offsets, 15],
            ] as const) {
              const encoded = new TextEncoder().encode(body);
              const offsets = decodeOffsets(
                rawOffsets instanceof Uint8Array ? utf8.decode(rawOffsets) : rawOffsets || "[]",
              );
              if (offsets.length === 0 && body.trim())
                throw new Error("Antigravity text has no indexed step offsets");
              if (offsets.length > 0 && offsets[0]?.[1] !== 0)
                throw new Error("Antigravity offsets omit leading text");
              for (const [position, [stepId, start]] of offsets.entries()) {
                const end = offsets[position + 1]?.[1] ?? encoded.length;
                if (start < 0 || end < start || end > encoded.length || messages.has(stepId)) {
                  throw new Error("Invalid or overlapping Antigravity text offsets");
                }
                const text = utf8.decode(encoded.subarray(start, end)).replace(/\n+$/, "");
                if (!text.trim()) continue;
                const stored = decodeStep(step.get(stepId));
                if (stored.step_type !== expectedType)
                  throw new Error("Antigravity indexed role differs from its native step");
                const timestamp = readAntigravityStepTimestamp(stored.metadata);
                if (timestamp === null)
                  throw new Error("Antigravity message has no creation timestamp");
                messages.set(stepId, {
                  role,
                  text,
                  createdAt: DateTime.formatIso(DateTime.makeUnsafe(timestamp)),
                });
              }
            }
          }
          const ordered = [...messages].sort(([a], [b]) => a - b).map(([, message]) => message);
          const firstUser = ordered.find((message) => message.role === "user");
          const selected =
            ordered.length <= MAX_MESSAGES
              ? ordered
              : firstUser === undefined
                ? ordered.slice(-MAX_MESSAGES)
                : [
                    firstUser,
                    ...ordered
                      .filter((message) => message !== firstUser)
                      .slice(-(MAX_MESSAGES - 1)),
                  ];
          return {
            messages: selected,
            archived,
            omittedMessageCount: ordered.length - selected.length,
          };
        } finally {
          trajectory.close();
        }
      } finally {
        index.close();
      }
    },
    catch: (cause) => new AntigravityHistoryReadError({ filePath: entry.filePath, cause }),
  });
});

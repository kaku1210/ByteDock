// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite builds a temporary native Antigravity session database for tests.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import { tailAntigravityCommandOutput } from "./AntigravityTaskOutputTail.ts";

const SESSION_ID = "aca17e09-5ef5-45f2-bf01-95e37b8129cd";
const TOOL_CALL_ID = "call_6947489780464557052";
const GENERIC_STEP_TYPE = 132;

function encodeVarint(value: number): Uint8Array {
  const bytes: Array<number> = [];
  let next = value;
  while (next >= 0x80) {
    bytes.push((next & 0x7f) | 0x80);
    next = Math.floor(next / 128);
  }
  bytes.push(next);
  return Uint8Array.from(bytes);
}

function encodeLengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  const key = encodeVarint(field * 8 + 2);
  const length = encodeVarint(payload.byteLength);
  const out = new Uint8Array(key.byteLength + length.byteLength + payload.byteLength);
  out.set(key, 0);
  out.set(length, key.byteLength);
  out.set(payload, key.byteLength + length.byteLength);
  return out;
}

function encodeToolCallMetadata(id: string, name: string): Uint8Array {
  const encoder = new TextEncoder();
  const idField = encodeLengthDelimited(1, encoder.encode(id));
  const nameField = encodeLengthDelimited(2, encoder.encode(name));
  const toolCall = new Uint8Array(idField.byteLength + nameField.byteLength);
  toolCall.set(idField, 0);
  toolCall.set(nameField, idField.byteLength);
  return encodeLengthDelimited(4, toolCall);
}

describe("tailAntigravityCommandOutput", () => {
  it.live(
    "resolves step idx from native SQLite and streams incremental task-<idx>.log chunks",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const profileDirectory = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-agy-task-tail-",
          });
          const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
          const tasksDir = path.join(
            profileDirectory,
            "antigravity-acp",
            "brain",
            SESSION_ID,
            ".system_generated",
            "tasks",
          );
          yield* fs.makeDirectory(conversations, { recursive: true });
          const dbPath = path.join(conversations, `${SESSION_ID}.db`);
          const database = new NodeSqlite.DatabaseSync(dbPath);
          try {
            database.exec(
              "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB)",
            );
            database
              .prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)")
              .run(606, GENERIC_STEP_TYPE, 2, encodeToolCallMetadata(TOOL_CALL_ID, "run_command"));
          } finally {
            database.close();
          }

          const chunks = yield* Queue.unbounded<string>();
          const stop = yield* Deferred.make<void>();
          const fiber = yield* tailAntigravityCommandOutput({
            profileDirectory,
            sessionId: SESSION_ID,
            toolCallId: TOOL_CALL_ID,
            stop,
            onChunk: (chunk) => Queue.offer(chunks, chunk),
          }).pipe(Effect.forkScoped);

          // Log file appears only after the command transitions into a background task.
          yield* fs.makeDirectory(tasksDir, { recursive: true });
          const logFile = path.join(tasksDir, "task-606.log");
          yield* fs.writeFileString(logFile, "Building project...\n");
          assert.equal(yield* Queue.take(chunks), "Building project...\n");

          yield* fs.writeFileString(logFile, "Building project...\nPassed 272/272 tests\n");
          yield* Deferred.succeed(stop, undefined);
          yield* Fiber.join(fiber);
          assert.equal(yield* Queue.take(chunks), "Passed 272/272 tests\n");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});

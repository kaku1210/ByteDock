import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { scanAntigravityHistory, readAntigravityHistory } from "./AntigravityHistory.ts";

it.effect(
  "reads Unicode main-conversation snapshots, preserves archive state and rejects inconsistent native steps",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "antigravity-history-" });
      yield* fs.makeDirectory(path.join(directory, "conversations"));
      const id = "9e69ad8e-9479-4794-b22e-360b860c9aa7";
      const child = "50e6187b-4f15-4d80-a58c-10f5893a85d8";
      const index = yield* Effect.acquireRelease(
        Effect.sync(
          () => new NodeSqlite.DatabaseSync(path.join(directory, "conversation_summaries.db")),
        ),
        (db) => Effect.sync(() => db.close()),
      );
      const trajectory = yield* Effect.acquireRelease(
        Effect.sync(
          () => new NodeSqlite.DatabaseSync(path.join(directory, "conversations", `${id}.db`)),
        ),
        (db) => Effect.sync(() => db.close()),
      );
      index.exec(
        "CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,last_modified_time TEXT,parent_conversation_id TEXT); CREATE TABLE conversations_fts(conversation_id TEXT,chunk_index INTEGER,archived INTEGER,user_body TEXT,agent_body TEXT,user_step_byte_offsets TEXT,agent_step_byte_offsets TEXT)",
      );
      const summary = index.prepare("INSERT INTO conversation_summaries VALUES (?,?,?,?,?)");
      summary.run(
        id,
        "中文会话",
        JSON.stringify([NodeURL.pathToFileURL(directory).href]),
        "2026-11-14 13:28:12.7366675+00:00",
        "",
      );
      summary.run(child, "Internal child", "", "2026-11-14 13:28:12+00:00", id);
      const insert = index.prepare("INSERT INTO conversations_fts VALUES (?,?,?,?,?,?,?)");
      insert.run(id, -1, 1, "", "", null, null);
      insert.run(
        id,
        0,
        1,
        "你好\n第二条",
        "已完成",
        new TextEncoder().encode("[[0,0],[2,7]]"),
        "[[1,0]]",
      );
      trajectory.exec(
        "CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)",
      );
      // Metadata field 1 is Timestamp{seconds: 1_700_000_000}, shared with native usage parsing.
      const timestamp = new Uint8Array([10, 6, 8, 128, 226, 207, 170, 6]);
      const step = trajectory.prepare("INSERT INTO steps VALUES (?,?,?)");
      step.run(0, 14, timestamp);
      step.run(1, 15, timestamp);
      step.run(2, 14, timestamp);
      const catalog = yield* scanAntigravityHistory(directory, "unused");
      expect(catalog.entries).toHaveLength(1);
      const entry = catalog.entries[0]!;
      expect(entry).toMatchObject({
        id,
        title: "中文会话",
        cwd: directory,
        updatedAt: "2026-11-14T13:28:12.736Z",
      });
      const history = yield* readAntigravityHistory(entry);
      expect(history).toMatchObject({ archived: true, omittedMessageCount: 0 });
      expect(history.messages.map(({ role, text, createdAt }) => [role, text, createdAt])).toEqual([
        ["user", "你好", "2023-11-14T22:13:20.000Z"],
        ["assistant", "已完成", "2023-11-14T22:13:20.000Z"],
        ["user", "第二条", "2023-11-14T22:13:20.000Z"],
      ]);
      summary.run(
        "095140ae-e30d-4437-ac6b-edc2186c6430",
        "No project",
        "",
        "2026-11-15T00:00:00Z",
        "",
      );
      expect((yield* scanAntigravityHistory(directory, directory)).entries[0]?.cwd).toBe(directory);
      trajectory.exec("UPDATE steps SET step_type=15 WHERE idx=0");
      expect(yield* Effect.flip(readAntigravityHistory(entry))).toMatchObject({
        _tag: "AntigravityHistoryReadError",
      });
      trajectory.exec("UPDATE steps SET step_type=14 WHERE idx=0");
      index.exec(
        "UPDATE conversations_fts SET user_step_byte_offsets='[[0,1]]' WHERE chunk_index=0",
      );
      expect(yield* Effect.flip(readAntigravityHistory(entry))).toMatchObject({
        _tag: "AntigravityHistoryReadError",
      });
      index.exec(
        "UPDATE conversations_fts SET user_body=CAST(zeroblob(33554433) AS TEXT) WHERE chunk_index=0",
      );
      expect((yield* Effect.flip(readAntigravityHistory(entry))).cause).toMatchObject({
        message: expect.stringContaining("32 MiB"),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

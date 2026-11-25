import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_worktree_planned_paths (
      thread_id TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      raw_path TEXT NOT NULL,
      run_id TEXT,
      note TEXT,
      declared_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, normalized_path)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS shared_worktree_planned_paths_thread_idx
    ON shared_worktree_planned_paths (thread_id, declared_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_worktree_checkout_policies (
      checkout_key TEXT PRIMARY KEY,
      checkout_path TEXT NOT NULL,
      serialization_mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_worktree_controlled_writes (
      write_id TEXT PRIMARY KEY,
      checkout_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      normalized_path TEXT NOT NULL,
      raw_path TEXT NOT NULL,
      old_normalized_path TEXT,
      old_raw_path TEXT,
      operation TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS shared_worktree_controlled_writes_thread_idx
    ON shared_worktree_controlled_writes (thread_id, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS shared_worktree_controlled_writes_checkout_idx
    ON shared_worktree_controlled_writes (checkout_key, updated_at)
  `;
});

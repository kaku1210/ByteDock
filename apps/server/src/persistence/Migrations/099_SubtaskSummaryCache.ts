import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS subtask_summary_cache (
      parent_thread_id TEXT NOT NULL,
      source_cutoff_key TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      source_run_id TEXT,
      source_ordinal INTEGER,
      source_message_id TEXT,
      source_turn_item_id TEXT,
      model_instance_id TEXT,
      model_slug TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL,
      PRIMARY KEY (parent_thread_id, source_cutoff_key, content_digest, strategy_version)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS subtask_summary_cache_parent_updated_idx
    ON subtask_summary_cache (parent_thread_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS subtask_summary_cache_last_accessed_idx
    ON subtask_summary_cache (last_accessed_at ASC)
  `;
});

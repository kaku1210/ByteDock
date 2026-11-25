import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS subtask_escalation_requests (
      request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_run_id TEXT,
      source_message_id TEXT,
      excerpt TEXT,
      title TEXT,
      task TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      child_thread_id TEXT,
      delegated_task_id TEXT,
      inbox_message_id TEXT,
      inbox_run_id TEXT,
      parent_queue_held INTEGER NOT NULL DEFAULT 0,
      causation_chain_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_reason TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS subtask_escalation_requests_root_idx
    ON subtask_escalation_requests (root_thread_id, status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS subtask_escalation_requests_source_idx
    ON subtask_escalation_requests (source_thread_id, status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS subtask_escalation_requests_child_idx
    ON subtask_escalation_requests (child_thread_id)
  `;
});

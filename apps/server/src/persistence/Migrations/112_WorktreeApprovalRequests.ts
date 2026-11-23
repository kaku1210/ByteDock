import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS worktree_approval_requests (
      request_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_thread_id TEXT,
      parent_run_id TEXT,
      parent_task_id TEXT,
      child_thread_id TEXT NOT NULL,
      child_run_id TEXT,
      base_ref TEXT NOT NULL,
      base_commit_sha TEXT,
      branch TEXT,
      start_from_origin INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      status TEXT NOT NULL,
      approved_worktree_path TEXT,
      approved_branch TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_reason TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS worktree_approval_requests_child_thread_idx
    ON worktree_approval_requests (child_thread_id, child_run_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS worktree_approval_requests_parent_thread_idx
    ON worktree_approval_requests (parent_thread_id, status, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS worktree_approval_requests_parent_task_idx
    ON worktree_approval_requests (parent_task_id, status)
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Direct-child task queries filter by $.lineage.parentThreadId; json_valid keeps malformed rows writable.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_parent_thread_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END
    )
  `;
});

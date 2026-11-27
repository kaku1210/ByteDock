import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bounded plugin metadata store (`plugin_kv`, ADR-05).
 * Enforces a hard 64KB CHECK cap and stays isolated from EventSink transactions.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS plugin_kv (
      plugin_id TEXT NOT NULL,
      ns TEXT NOT NULL,
      key TEXT NOT NULL,
      json_value TEXT NOT NULL CHECK (length(CAST(json_value AS BLOB)) <= 65536),
      expires_at INTEGER,
      PRIMARY KEY (plugin_id, ns, key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_plugin_kv_expires
      ON plugin_kv (expires_at)
      WHERE expires_at IS NOT NULL
  `;
});

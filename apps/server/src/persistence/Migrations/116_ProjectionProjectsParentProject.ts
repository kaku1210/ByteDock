import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "parent_project_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN parent_project_id TEXT
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_parent_project_id
      ON projection_projects(parent_project_id)
  `;
});

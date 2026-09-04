import type { Database } from 'better-sqlite3'

export const applySchemaVersion19 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tasks_content TEXT NOT NULL,
      agent_session_ids_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      dispatches_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_sessions_workspace_created_at
      ON workspace_sessions (workspace_id, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sessions_one_active
      ON workspace_sessions (workspace_id)
      WHERE active = 1;
  `)
}

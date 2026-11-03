import type { Database } from 'better-sqlite3'

export const applySchemaVersion20 = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (columns.size === 0 || columns.has('session_id')) return
  db.exec('ALTER TABLE agent_runs ADD COLUMN session_id TEXT')
}

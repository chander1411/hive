import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { toSessionScopeId } from '../../src/server/session-scope.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'
import { createWorkspaceSessionStore } from '../../src/server/workspace-session-store.js'

describe('workspace session store state', () => {
  test('reads live scoped agent session ids instead of the stale JSON snapshot', () => {
    const db = new Database(':memory:')
    initializeRuntimeDatabase(db)
    const workspaceId = 'ws-1'
    const sessionId = 'session-1'
    const scopeId = toSessionScopeId(workspaceId, sessionId)

    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      workspaceId,
      'Alpha',
      '/tmp/hive-alpha',
      1
    )
    db.prepare(
      `INSERT INTO workspace_sessions (
        id, workspace_id, name, tasks_content, agent_session_ids_json,
        messages_json, dispatches_json, active, created_at, updated_at
      ) VALUES (?, ?, ?, '', '{}', '[]', '[]', 1, ?, ?)`
    ).run(sessionId, workspaceId, 'Session 1', 1, 1)
    db.prepare(
      'INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
    ).run('agent-1', scopeId, 'native-live', 1)

    const store = createWorkspaceSessionStore(db)

    expect(store.getState(workspaceId, sessionId).agentSessionIds).toEqual({
      'agent-1': 'native-live',
    })
    db.close()
  })
})

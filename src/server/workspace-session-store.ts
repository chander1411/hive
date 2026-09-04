import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'
import { ConflictError } from './http-errors.js'

export interface WorkspaceSessionSummary {
  active: boolean
  createdAt: number
  id: string
  name: string
  updatedAt: number
  workspaceId: string
}

export interface WorkspaceSessionState {
  agentSessionIds: Record<string, string>
  tasksContent: string
}

interface WorkspaceSessionRow {
  active: number
  agent_session_ids_json: string
  created_at: number
  dispatches_json: string
  id: string
  messages_json: string
  name: string
  tasks_content: string
  updated_at: number
  workspace_id: string
}

type MessageSnapshot = {
  artifacts: string | null
  created_at: number
  from_agent_id: string | null
  status: string | null
  text: string | null
  to_agent_id: string | null
  type: string
  worker_id: string
}

type DispatchSnapshot = {
  artifacts: string | null
  created_at: number
  delivered_at: number | null
  from_agent_id: string | null
  id: string
  report_text: string | null
  reported_at: number | null
  status: string
  submitted_at: number | null
  text: string
  to_agent_id: string
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T

const toSummary = (row: WorkspaceSessionRow): WorkspaceSessionSummary => ({
  active: row.active === 1,
  createdAt: row.created_at,
  id: row.id,
  name: row.name,
  updatedAt: row.updated_at,
  workspaceId: row.workspace_id,
})

export const createWorkspaceSessionStore = (db: Database) => {
  const readMessages = (workspaceId: string) =>
    db
      .prepare(
        `SELECT worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at
         FROM messages
         WHERE workspace_id = ?
         ORDER BY sequence ASC`
      )
      .all(workspaceId) as MessageSnapshot[]

  const readDispatches = (workspaceId: string) =>
    db
      .prepare(
        `SELECT id, from_agent_id, to_agent_id, text, status, created_at, delivered_at,
                submitted_at, reported_at, report_text, artifacts
         FROM dispatches
         WHERE workspace_id = ?
         ORDER BY sequence ASC`
      )
      .all(workspaceId) as DispatchSnapshot[]

  const getActiveRow = (workspaceId: string) =>
    db
      .prepare('SELECT * FROM workspace_sessions WHERE workspace_id = ? AND active = 1')
      .get(workspaceId) as WorkspaceSessionRow | undefined

  const getRow = (workspaceId: string, sessionId: string) => {
    const row = db
      .prepare('SELECT * FROM workspace_sessions WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, sessionId) as WorkspaceSessionRow | undefined
    if (!row) throw new Error(`Workspace session not found: ${sessionId}`)
    return row
  }

  const snapshotValues = (workspaceId: string, state: WorkspaceSessionState) => ({
    agentSessionIdsJson: JSON.stringify(state.agentSessionIds),
    dispatchesJson: JSON.stringify(readDispatches(workspaceId)),
    messagesJson: JSON.stringify(readMessages(workspaceId)),
    tasksContent: state.tasksContent,
  })

  const ensureActive = (workspaceId: string, state: WorkspaceSessionState) => {
    const current = getActiveRow(workspaceId)
    if (current) return current
    const now = Date.now()
    const snapshot = snapshotValues(workspaceId, state)
    const row: WorkspaceSessionRow = {
      active: 1,
      agent_session_ids_json: snapshot.agentSessionIdsJson,
      created_at: now,
      dispatches_json: snapshot.dispatchesJson,
      id: randomUUID(),
      messages_json: snapshot.messagesJson,
      name: 'Session 1',
      tasks_content: snapshot.tasksContent,
      updated_at: now,
      workspace_id: workspaceId,
    }
    db.prepare(
      `INSERT INTO workspace_sessions (
        id, workspace_id, name, tasks_content, agent_session_ids_json,
        messages_json, dispatches_json, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      row.id,
      workspaceId,
      row.name,
      row.tasks_content,
      row.agent_session_ids_json,
      row.messages_json,
      row.dispatches_json,
      now,
      now
    )
    return row
  }

  const updateSnapshot = (workspaceId: string, sessionId: string, state: WorkspaceSessionState) => {
    const snapshot = snapshotValues(workspaceId, state)
    db.prepare(
      `UPDATE workspace_sessions
       SET tasks_content = ?, agent_session_ids_json = ?, messages_json = ?,
           dispatches_json = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ?`
    ).run(
      snapshot.tasksContent,
      snapshot.agentSessionIdsJson,
      snapshot.messagesJson,
      snapshot.dispatchesJson,
      Date.now(),
      workspaceId,
      sessionId
    )
  }

  const replaceOperationalRows = (workspaceId: string, row: WorkspaceSessionRow) => {
    db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId)
    db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)

    const insertMessage = db.prepare(
      `INSERT INTO messages (
        workspace_id, worker_id, type, from_agent_id, to_agent_id, text, status, artifacts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const message of parseJson<MessageSnapshot[]>(row.messages_json)) {
      insertMessage.run(
        workspaceId,
        message.worker_id,
        message.type,
        message.from_agent_id,
        message.to_agent_id,
        message.text,
        message.status,
        message.artifacts,
        message.created_at
      )
    }

    const insertDispatch = db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status, created_at,
        delivered_at, submitted_at, reported_at, report_text, artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const dispatch of parseJson<DispatchSnapshot[]>(row.dispatches_json)) {
      insertDispatch.run(
        dispatch.id,
        workspaceId,
        dispatch.from_agent_id,
        dispatch.to_agent_id,
        dispatch.text,
        dispatch.status,
        dispatch.created_at,
        dispatch.delivered_at,
        dispatch.submitted_at,
        dispatch.reported_at,
        dispatch.report_text,
        dispatch.artifacts
      )
    }
  }

  return {
    ensureActiveSession(workspaceId: string, state: WorkspaceSessionState) {
      return toSummary(ensureActive(workspaceId, state))
    },
    listSessions(workspaceId: string) {
      return (
        db
          .prepare(
            'SELECT * FROM workspace_sessions WHERE workspace_id = ? ORDER BY created_at ASC, id ASC'
          )
          .all(workspaceId) as WorkspaceSessionRow[]
      ).map(toSummary)
    },
    createSession(
      workspaceId: string,
      currentState: WorkspaceSessionState,
      requestedName?: string
    ) {
      return db.transaction(() => {
        const current = ensureActive(workspaceId, currentState)
        updateSnapshot(workspaceId, current.id, currentState)
        const count = (
          db
            .prepare('SELECT COUNT(*) AS count FROM workspace_sessions WHERE workspace_id = ?')
            .get(workspaceId) as { count: number }
        ).count
        const now = Date.now()
        const id = randomUUID()
        db.prepare('UPDATE workspace_sessions SET active = 0 WHERE workspace_id = ?').run(
          workspaceId
        )
        const name = requestedName?.trim() || `Session ${count + 1}`
        db.prepare(
          `INSERT INTO workspace_sessions (
            id, workspace_id, name, tasks_content, agent_session_ids_json,
            messages_json, dispatches_json, active, created_at, updated_at
          ) VALUES (?, ?, ?, '', '{}', '[]', '[]', 1, ?, ?)`
        ).run(id, workspaceId, name, now, now)
        db.prepare('DELETE FROM messages WHERE workspace_id = ?').run(workspaceId)
        db.prepare('DELETE FROM dispatches WHERE workspace_id = ?').run(workspaceId)
        return toSummary(getRow(workspaceId, id))
      })()
    },
    activateSession(workspaceId: string, sessionId: string, currentState: WorkspaceSessionState) {
      return db.transaction(() => {
        const current = ensureActive(workspaceId, currentState)
        if (current.id === sessionId) {
          updateSnapshot(workspaceId, current.id, currentState)
          return toSummary(getRow(workspaceId, sessionId))
        }
        updateSnapshot(workspaceId, current.id, currentState)
        const target = getRow(workspaceId, sessionId)
        replaceOperationalRows(workspaceId, target)
        db.prepare('UPDATE workspace_sessions SET active = 0 WHERE workspace_id = ?').run(
          workspaceId
        )
        db.prepare(
          'UPDATE workspace_sessions SET active = 1, updated_at = ? WHERE workspace_id = ? AND id = ?'
        ).run(Date.now(), workspaceId, sessionId)
        return toSummary(getRow(workspaceId, sessionId))
      })()
    },
    getState(workspaceId: string, sessionId: string): WorkspaceSessionState {
      const row = getRow(workspaceId, sessionId)
      return {
        agentSessionIds: parseJson<Record<string, string>>(row.agent_session_ids_json),
        tasksContent: row.tasks_content,
      }
    },
    deleteSession(workspaceId: string, sessionId: string) {
      const row = getRow(workspaceId, sessionId)
      if (row.active === 1) throw new ConflictError('The active session cannot be deleted')
      db.prepare('DELETE FROM workspace_sessions WHERE workspace_id = ? AND id = ?').run(
        workspaceId,
        sessionId
      )
    },
    deleteWorkspaceSessions(workspaceId: string) {
      db.prepare('DELETE FROM workspace_sessions WHERE workspace_id = ?').run(workspaceId)
    },
  }
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { buildAgentRunBootstrap } from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import { buildAgentSessionBindingMarker } from '../../src/server/agent-startup-instructions.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'
import type { AgentSummary, WorkspaceSummary } from '../../src/shared/types.js'

const tempDirs: string[] = []
const originalOpenCodeDbPath = process.env.HIVE_OPENCODE_DB_PATH

afterEach(() => {
  if (originalOpenCodeDbPath === undefined) delete process.env.HIVE_OPENCODE_DB_PATH
  else process.env.HIVE_OPENCODE_DB_PATH = originalOpenCodeDbPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const opencodePreset: CommandPresetRecord = {
  args: [],
  command: 'opencode',
  displayName: 'OpenCode',
  env: {},
  id: 'opencode',
  isBuiltin: true,
  resumeArgsTemplate: '--session {session_id}',
  sessionIdCapture: {
    pattern: '~/.local/share/opencode/opencode.db',
    source: 'opencode_session_db',
  },
  yoloArgsTemplate: null,
}

const createSessionStore = (sessionId: string) => {
  const clearLastSessionId = vi.fn()
  const setLastSessionId = vi.fn()
  const store: AgentSessionStore = {
    clearLastSessionId,
    getLastSessionId: () => sessionId,
    setLastSessionId,
  }
  return { clearLastSessionId, setLastSessionId, store }
}

describe('agent run bootstrap OpenCode recovery', () => {
  test('clears a stored session that belongs to another agent and recovers the matching one', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-opencode-bootstrap-'))
    tempDirs.push(root)
    const dbPath = join(root, 'opencode.db')
    const workspacePath = join(root, 'workspace')
    const workspace: WorkspaceSummary = { id: 'ws-1', name: 'Alpha', path: workspacePath }
    const agent: AgentSummary = {
      description: 'You are a Coder.',
      id: 'agent-a',
      name: 'Alice',
      pendingTaskCount: 0,
      role: 'coder',
      status: 'idle',
      workspaceId: workspace.id,
    }
    const hiveSessionId = 'hive-1'
    const ownMarker = buildAgentSessionBindingMarker({ agent, sessionId: hiveSessionId, workspace })
    const otherMarker = buildAgentSessionBindingMarker({
      agent: { ...agent, id: 'agent-b', name: 'Bob' },
      sessionId: hiveSessionId,
      workspace,
    })

    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        time_archived INTEGER,
        time_updated INTEGER
      );

      CREATE TABLE part (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `)
    const insertSession = db.prepare(
      'INSERT INTO session (id, directory, time_archived, time_updated) VALUES (?, ?, NULL, ?)'
    )
    const insertPart = db.prepare('INSERT INTO part (session_id, data) VALUES (?, ?)')
    insertSession.run('ses-wrong', workspacePath, 2)
    insertPart.run('ses-wrong', JSON.stringify({ type: 'text', text: otherMarker }))
    insertSession.run('ses-correct', workspacePath, 1)
    insertPart.run('ses-correct', JSON.stringify({ type: 'text', text: ownMarker }))
    db.close()
    process.env.HIVE_OPENCODE_DB_PATH = dbPath

    const { clearLastSessionId, setLastSessionId, store } = createSessionStore('ses-wrong')
    const bootstrap = buildAgentRunBootstrap(
      workspace,
      agent.id,
      { args: [], command: 'opencode', commandPresetId: 'opencode' },
      store,
      (id) => (id === 'opencode' ? opencodePreset : undefined),
      agent,
      false,
      hiveSessionId
    )

    expect(clearLastSessionId).toHaveBeenCalledWith(workspace.id, agent.id)
    expect(setLastSessionId).toHaveBeenCalledWith(workspace.id, agent.id, 'ses-correct')
    expect(bootstrap.startConfig.resumedSessionId).toBe('ses-correct')
    expect(bootstrap.startConfig.args).toEqual(['--session', 'ses-correct'])
  })
})

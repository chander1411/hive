import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { resetSessionCaptureCoordinatorForTests } from '../../src/server/claude-session-coordinator.js'
import { findExistingSessionIdForCapture } from '../../src/server/session-capture.js'
import {
  captureOpenCodeSessionId,
  findOpenCodeSessionId,
  hasOpenCodeSession,
} from '../../src/server/session-capture-opencode.js'

const tempDirs: string[] = []
const originalOpenCodeDbPath = process.env.HIVE_OPENCODE_DB_PATH

const marker = (agentId: string) =>
  `Hive session binding: workspace_id=ws-1; agent_id=${agentId}; session_id=hive-1`

afterEach(() => {
  resetSessionCaptureCoordinatorForTests()
  if (originalOpenCodeDbPath === undefined) delete process.env.HIVE_OPENCODE_DB_PATH
  else process.env.HIVE_OPENCODE_DB_PATH = originalOpenCodeDbPath
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const createOpenCodeDb = () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-opencode-markers-'))
  tempDirs.push(root)
  const dbPath = join(root, 'opencode.db')
  const cwd = join(root, 'workspace')
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
  insertSession.run('ses-agent-b', cwd, 2)
  insertPart.run('ses-agent-b', JSON.stringify({ type: 'text', text: marker('agent-b') }))
  insertSession.run('ses-agent-a', cwd, 1)
  insertPart.run('ses-agent-a', JSON.stringify({ type: 'text', text: marker('agent-a') }))
  db.close()
  process.env.HIVE_OPENCODE_DB_PATH = dbPath
  return { cwd, dbPath }
}

describe('OpenCode session capture ownership', () => {
  test('verifies a stored session against the agent binding marker', () => {
    const { cwd, dbPath } = createOpenCodeDb()

    expect(
      hasOpenCodeSession(cwd, 'ses-agent-a', undefined, {
        contentIncludes: marker('agent-a'),
      })
    ).toBe(true)
    expect(
      hasOpenCodeSession(cwd, 'ses-agent-a', undefined, {
        contentIncludes: marker('agent-b'),
      })
    ).toBe(false)
    expect(findOpenCodeSessionId(cwd, undefined, { contentIncludes: marker('agent-a') })).toBe(
      'ses-agent-a'
    )
    expect(
      findExistingSessionIdForCapture(
        cwd,
        { pattern: '~/.local/share/opencode/opencode.db', source: 'opencode_session_db' },
        { contentIncludes: marker('agent-b') }
      )
    ).toBe('ses-agent-b')

    const db = new Database(dbPath, { readonly: true })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session').get()).toEqual({ count: 2 })
    db.close()
  })

  test('assigns each concurrent capture the session carrying its own marker', async () => {
    const { cwd, dbPath } = createOpenCodeDb()
    const knownSessionIds = new Set<string>()
    const agentASessions: string[] = []
    const agentBSessions: string[] = []

    await Promise.all([
      captureOpenCodeSessionId(
        cwd,
        knownSessionIds,
        (sessionId) => agentASessions.push(sessionId),
        2000,
        10,
        dbPath,
        { contentIncludes: marker('agent-a') }
      ),
      captureOpenCodeSessionId(
        cwd,
        knownSessionIds,
        (sessionId) => agentBSessions.push(sessionId),
        2000,
        10,
        dbPath,
        { contentIncludes: marker('agent-b') }
      ),
    ])

    expect(agentASessions).toEqual(['ses-agent-a'])
    expect(agentBSessions).toEqual(['ses-agent-b'])
  })
})

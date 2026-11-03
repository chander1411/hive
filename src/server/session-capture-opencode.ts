import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { captureSessionIdWithCoordinator } from './claude-session-coordinator.js'

type ContentDiscriminator = { contentIncludes: string | readonly string[] }

const toMarkers = (discriminator: ContentDiscriminator | undefined) =>
  discriminator
    ? Array.isArray(discriminator.contentIncludes)
      ? discriminator.contentIncludes
      : [discriminator.contentIncludes]
    : []

const expandHome = (path: string) =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

const getDefaultOpenCodeDbPath = () =>
  process.env.HIVE_OPENCODE_DB_PATH ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')

export const getOpenCodeDbPath = (pattern?: string) =>
  pattern === '~/.local/share/opencode/opencode.db' || !pattern
    ? getDefaultOpenCodeDbPath()
    : expandHome(pattern)

const listSessionIds = (cwd: string, dbPath = getDefaultOpenCodeDbPath()) => {
  if (!existsSync(dbPath)) return []
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { fileMustExist: true, readonly: true })
    return (
      db
        .prepare(
          `SELECT id FROM session
           WHERE directory = ? AND time_archived IS NULL
           ORDER BY rowid ASC`
        )
        .all(cwd) as Array<{ id: string }>
    ).map((row) => row.id)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

const sessionContainsMarkers = (dbPath: string, sessionId: string, markers: readonly string[]) => {
  if (markers.length === 0 || !existsSync(dbPath)) return false
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { fileMustExist: true, readonly: true })
    const statement = db.prepare('SELECT 1 FROM part WHERE session_id = ? AND data LIKE ? LIMIT 1')
    return markers.some((marker) => statement.get(sessionId, `%${marker}%`) !== undefined)
  } catch {
    return false
  } finally {
    db?.close()
  }
}

export const hasOpenCodeSession = (
  cwd: string,
  sessionId: string,
  pattern?: string,
  discriminator?: ContentDiscriminator
) => {
  const dbPath = getOpenCodeDbPath(pattern)
  if (!listSessionIds(cwd, dbPath).includes(sessionId)) return false
  const markers = toMarkers(discriminator)
  return markers.length === 0 || sessionContainsMarkers(dbPath, sessionId, markers)
}

export const findOpenCodeSessionId = (
  cwd: string,
  pattern?: string,
  discriminator?: ContentDiscriminator
) => {
  const markers = toMarkers(discriminator)
  if (markers.length === 0) return undefined
  const dbPath = getOpenCodeDbPath(pattern)
  const sessionIds = listSessionIds(cwd, dbPath)
  for (const sessionId of sessionIds.reverse()) {
    if (sessionContainsMarkers(dbPath, sessionId, markers)) return sessionId
  }
  return undefined
}

export const snapshotOpenCodeSessionIds = (cwd: string, dbPath = getDefaultOpenCodeDbPath()) =>
  new Set(listSessionIds(cwd, dbPath))

export const captureOpenCodeSessionId = async (
  cwd: string,
  knownSessionIds: Set<string>,
  onCapture: (sessionId: string) => void,
  timeoutMs = 5000,
  intervalMs = 100,
  dbPath = getDefaultOpenCodeDbPath(),
  discriminator?: ContentDiscriminator
) => {
  const markers = toMarkers(discriminator)
  await captureSessionIdWithCoordinator({
    intervalMs,
    knownSessionIds,
    listSessionIds: () => listSessionIds(cwd, dbPath),
    onCapture,
    projectKey: `${dbPath}:${cwd}`,
    timeoutMs,
    ...(markers.length > 0
      ? {
          matchesSessionId: (sessionId: string) =>
            sessionContainsMarkers(dbPath, sessionId, markers),
        }
      : {}),
  })
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildProtocolDoc } from './hive-team-guidance.js'

interface TasksFileService {
  archiveAndResetTasks: (workspacePath: string) => { archivedPath: string | null; content: string }
  readTasks: (workspacePath: string) => string
  writeTasks: (workspacePath: string, content: string) => void
  readSessionTasks: (workspacePath: string, sessionId: string, initial?: string) => string
  writeSessionTasks: (workspacePath: string, sessionId: string, content: string) => void
  deleteSessionTasks: (workspacePath: string, sessionId: string) => void
}

export const HIVE_DIR_NAME = '.hive'
export const TASKS_FILE_NAME = 'tasks.md'
export const TASKS_RELATIVE_PATH = `${HIVE_DIR_NAME}/${TASKS_FILE_NAME}`
export const PROTOCOL_FILE_NAME = 'PROTOCOL.md'
export const PROTOCOL_RELATIVE_PATH = `${HIVE_DIR_NAME}/${PROTOCOL_FILE_NAME}`
export const TASKS_HISTORY_DIR_NAME = 'history'
export const getSessionTasksRelativePath = (sessionId: string) =>
  `${HIVE_DIR_NAME}/sessions/${sessionId}/${TASKS_FILE_NAME}`

export const getTasksFilePath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR_NAME, TASKS_FILE_NAME)

export const getSessionTasksFilePath = (workspacePath: string, sessionId: string) =>
  join(workspacePath, getSessionTasksRelativePath(sessionId))

export const getProtocolFilePath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR_NAME, PROTOCOL_FILE_NAME)

const getLegacyTasksFilePath = (workspacePath: string) => join(workspacePath, TASKS_FILE_NAME)

const ensureTasksDir = (workspacePath: string) => {
  mkdirSync(dirname(getTasksFilePath(workspacePath)), { recursive: true })
}

export const ensureTasksFile = (workspacePath: string) => {
  ensureTasksDir(workspacePath)
  const tasksFilePath = getTasksFilePath(workspacePath)
  if (existsSync(tasksFilePath)) {
    return readFileSync(tasksFilePath, 'utf8')
  }

  const legacyTasksFilePath = getLegacyTasksFilePath(workspacePath)
  const content = existsSync(legacyTasksFilePath) ? readFileSync(legacyTasksFilePath, 'utf8') : ''
  writeFileSync(tasksFilePath, content, 'utf8')
  return content
}

/**
 * Always overwrites `.hive/PROTOCOL.md` with the freshly-built protocol doc.
 * The doc is marked auto-generated so user edits are not expected; rewriting
 * on every workspace open means a Hive version bump that changes the rules
 * propagates without manual intervention.
 */
export const ensureProtocolFile = (workspacePath: string) => {
  ensureTasksDir(workspacePath)
  const protocolFilePath = getProtocolFilePath(workspacePath)
  const desired = buildProtocolDoc()
  const current = existsSync(protocolFilePath) ? readFileSync(protocolFilePath, 'utf8') : null
  if (current === desired) return desired
  writeFileSync(protocolFilePath, desired, 'utf8')
  return desired
}

const getTasksArchivePath = (workspacePath: string, timestamp: Date) => {
  const filename = `tasks-${timestamp.toISOString().replaceAll(':', '-').replaceAll('.', '-')}.md`
  return join(workspacePath, HIVE_DIR_NAME, TASKS_HISTORY_DIR_NAME, filename)
}

export const createTasksFileService = ({ now = () => new Date() } = {}): TasksFileService => {
  return {
    archiveAndResetTasks(workspacePath) {
      const content = ensureTasksFile(workspacePath)
      let archivedPath: string | null = null
      if (content.trim()) {
        archivedPath = getTasksArchivePath(workspacePath, now())
        mkdirSync(dirname(archivedPath), { recursive: true })
        writeFileSync(archivedPath, content, { encoding: 'utf8', flag: 'wx' })
      }
      this.writeTasks(workspacePath, '')
      return { archivedPath, content: '' }
    },

    readTasks(workspacePath) {
      return ensureTasksFile(workspacePath)
    },

    writeTasks(workspacePath, content) {
      ensureTasksDir(workspacePath)
      writeFileSync(getTasksFilePath(workspacePath), content, 'utf8')
    },
    readSessionTasks(workspacePath, sessionId, initial = '') {
      const path = getSessionTasksFilePath(workspacePath, sessionId)
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, initial, 'utf8')
      }
      return readFileSync(path, 'utf8')
    },
    writeSessionTasks(workspacePath, sessionId, content) {
      const path = getSessionTasksFilePath(workspacePath, sessionId)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
    },
    deleteSessionTasks(workspacePath, sessionId) {
      rmSync(dirname(getSessionTasksFilePath(workspacePath, sessionId)), {
        force: true,
        recursive: true,
      })
    },
  }
}

export type { TasksFileService }

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import chokidar, { type FSWatcher } from 'chokidar'

import {
  ensureProtocolFile,
  ensureTasksFile,
  getSessionTasksFilePath,
  getTasksFilePath,
} from './tasks-file.js'

const DEBOUNCE_MS = 100

export interface TasksFileWatcher {
  close: () => Promise<void>
  start: (workspaceId: string, workspacePath: string, sessionId?: string) => Promise<void>
  stop: (workspaceId: string) => Promise<void>
}

export const createTasksFileWatcher = ({
  onTasksUpdated,
}: {
  onTasksUpdated: (workspaceId: string, content: string) => void
}): TasksFileWatcher => {
  const watchers = new Map<string, FSWatcher>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const clearTimer = (workspaceId: string) => {
    const timer = timers.get(workspaceId)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(workspaceId)
  }

  const emitCurrentContent = async (
    workspaceId: string,
    workspacePath: string,
    sessionId?: string
  ) => {
    const tasksPath = sessionId
      ? getSessionTasksFilePath(workspacePath, sessionId)
      : getTasksFilePath(workspacePath)
    try {
      const content = existsSync(tasksPath) ? await readFile(tasksPath, 'utf8') : ''
      onTasksUpdated(workspaceId, content)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      onTasksUpdated(workspaceId, '')
    }
  }

  const stop = async (workspaceId: string) => {
    clearTimer(workspaceId)
    const watcher = watchers.get(workspaceId)
    watchers.delete(workspaceId)
    await watcher?.close()
  }

  return {
    close: async () => {
      await Promise.all(Array.from(watchers.keys(), (workspaceId) => stop(workspaceId)))
    },
    start: async (workspaceId, workspacePath, sessionId) => {
      await stop(workspaceId)
      ensureTasksFile(workspacePath)
      ensureProtocolFile(workspacePath)
      const watcher = chokidar.watch(
        sessionId
          ? getSessionTasksFilePath(workspacePath, sessionId)
          : getTasksFilePath(workspacePath),
        {
          ignoreInitial: true,
        }
      )
      const scheduleEmit = () => {
        clearTimer(workspaceId)
        timers.set(
          workspaceId,
          setTimeout(() => {
            timers.delete(workspaceId)
            void emitCurrentContent(workspaceId, workspacePath, sessionId)
          }, DEBOUNCE_MS)
        )
      }
      watcher.on('add', scheduleEmit)
      watcher.on('change', scheduleEmit)
      watcher.on('unlink', scheduleEmit)
      watchers.set(workspaceId, watcher)
      await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
    },
    stop,
  }
}

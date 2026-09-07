import type { AgentRunStorePort } from './agent-runtime-ports.js'
import type { MessageLogHandle, MessageLogRecord, RecoveryMessage } from './message-log-store.js'
import type { PromptLanguage } from './prompt-language.js'
import { createRestartPolicy } from './restart-policy.js'
import type { TasksFileService } from './tasks-file.js'
import type { WorkspaceStore } from './workspace-store.js'

// Narrow helper keeps runtime-store under the hard line cap.
export const buildRuntimeRestartPolicy = ({
  agentRunStore,
  messageLogStore,
  tasksFileService,
  workspaceStore,
  getPromptLanguage,
}: {
  agentRunStore: Pick<AgentRunStorePort, 'listAgentRuns'>
  messageLogStore: {
    deleteMessage: (handle: MessageLogHandle) => void
    insertMessage: (record: MessageLogRecord) => MessageLogHandle
    listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  }
  tasksFileService: Pick<TasksFileService, 'readSessionTasks' | 'readTasks'>
  workspaceStore: Pick<WorkspaceStore, 'getWorkspaceSnapshot'>
  getPromptLanguage: () => PromptLanguage
}) =>
  createRestartPolicy({
    deleteMessage: messageLogStore.deleteMessage,
    getWorkspaceSnapshot: workspaceStore.getWorkspaceSnapshot,
    insertMessage: messageLogStore.insertMessage,
    listAgentRuns: agentRunStore.listAgentRuns,
    listMessagesForRecovery: messageLogStore.listMessagesForRecovery,
    readTasks: (workspacePath, sessionId) =>
      sessionId
        ? tasksFileService.readSessionTasks(workspacePath, sessionId)
        : tasksFileService.readTasks(workspacePath),
    getPromptLanguage,
  })

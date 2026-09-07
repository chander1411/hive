import type { WorkspaceSummary } from '../shared/types.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import { buildRecoverySummary } from './recovery-summary.js'
import {
  findPreviousRun,
  type RestartPolicyInput,
  writeSystemMessage,
} from './restart-policy-support.js'
import { createSystemRecoverySummaryMessage } from './runtime-message-builders.js'
import { toSessionScopeId } from './session-scope.js'

const RECOVERY_WINDOW_MS = 60 * 60 * 1000

export interface RestartPolicy {
  injectPostStartMessage: (input: {
    agentId: string
    runId: string
    startConfig: AgentLaunchConfigInput
    sessionId?: string | undefined
    workspace: WorkspaceSummary
    writeToRun: (runId: string, text: string) => void
  }) => boolean
}

export const createNoopRestartPolicy = (): RestartPolicy => ({
  injectPostStartMessage() {
    return false
  },
})

export const createRestartPolicy = ({
  deleteMessage,
  getWorkspaceSnapshot,
  insertMessage,
  listAgentRuns,
  listMessagesForRecovery,
  readTasks,
  getPromptLanguage = () => 'zh',
}: RestartPolicyInput): RestartPolicy => ({
  injectPostStartMessage({ agentId, runId, sessionId, startConfig, workspace, writeToRun }) {
    const previousRun = findPreviousRun(listAgentRuns(agentId), runId)
    if (!previousRun) return false

    const snapshot = getWorkspaceSnapshot(workspace.id)
    const agent = snapshot.agents.find((item) => item.id === agentId)
    if (!agent) return false
    const workers = snapshot.agents.filter(
      (item) => item.role !== 'orchestrator' && item.id !== agentId
    )
    const tasksContent = readTasks(snapshot.summary.path, sessionId)
    const scopeId = toSessionScopeId(workspace.id, sessionId)

    if (startConfig.resumedSessionId) return true

    const text = buildRecoverySummary({
      agent,
      allTaskMessages: listMessagesForRecovery(scopeId, 0),
      messages: listMessagesForRecovery(scopeId, Date.now() - RECOVERY_WINDOW_MS),
      tasksContent,
      workers,
      workspace,
      language: getPromptLanguage(),
    })
    writeSystemMessage({
      deleteMessage,
      insertMessage,
      record: {
        ...createSystemRecoverySummaryMessage(workspace.id, agentId, text),
        workspaceId: scopeId,
      },
      runId,
      text,
      writeToRun,
    })
    return true
  },
})

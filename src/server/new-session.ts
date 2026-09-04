import { relative } from 'node:path'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { ConflictError } from './http-errors.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import type { WorkspaceSessionSummary } from './workspace-session-store.js'
import { getOrchestratorId } from './workspace-store-support.js'

export interface SessionActivationResult {
  archivedTasksPath: string | null
  run: LiveAgentRun
  session: WorkspaceSessionSummary
}

export const createWorkspaceSessionOperations = (
  services: RuntimeStoreServices,
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: { hivePort: string }
  ) => Promise<LiveAgentRun>
) => {
  const operations = new Map<string, Promise<SessionActivationResult>>()

  const getCurrentState = (workspaceId: string) => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    return {
      agentSessionIds: Object.fromEntries(
        workspace.agents.flatMap((agent) => {
          const sessionId = services.agentRuntime.getLastSessionId(workspaceId, agent.id)
          return sessionId ? [[agent.id, sessionId]] : []
        })
      ),
      tasksContent: services.tasksFileService.readTasks(workspace.summary.path),
    }
  }

  const stopWorkspaceAgents = async (workspaceId: string) => {
    const agents = [...services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents]
    await Promise.all(
      agents.map((agent) => services.agentRuntime.stopAgentAndWait(workspaceId, agent.id))
    )
    return agents
  }

  const restoreAgentState = (
    workspaceId: string,
    agents: Array<{ id: string }>,
    agentSessionIds: Record<string, string>
  ) => {
    for (const agent of agents) {
      services.agentRuntime.clearAgentFreshStart(workspaceId, agent.id)
      services.agentRuntime.clearLastSessionId(workspaceId, agent.id)
      const sessionId = agentSessionIds[agent.id]
      if (sessionId) services.agentRuntime.setLastSessionId(workspaceId, agent.id, sessionId)
    }
    services.workspaceStore.resetAgentsForNewSession(workspaceId)
    for (const dispatch of services.dispatchLedgerStore.listOpenDispatchKinds()) {
      if (
        dispatch.workspace_id === workspaceId &&
        services.workspaceStore.hasAgent(workspaceId, dispatch.worker_id)
      ) {
        services.workspaceStore.markTaskDispatched(workspaceId, dispatch.worker_id)
      }
    }
  }

  const executeNew = async (
    workspaceId: string,
    hivePort: string,
    name?: string
  ): Promise<SessionActivationResult> => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const orchestratorId = getOrchestratorId(workspaceId)
    const agents = await stopWorkspaceAgents(workspaceId)
    const currentState = getCurrentState(workspaceId)
    const session = services.workspaceSessionStore.createSession(workspaceId, currentState, name)

    for (const agent of agents) {
      services.agentRuntime.clearLastSessionId(workspaceId, agent.id)
      services.agentRuntime.markAgentForFreshStart(workspaceId, agent.id)
    }

    const { archivedPath } = services.tasksFileService.archiveAndResetTasks(workspace.summary.path)
    services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
    services.messageLogStore.deleteWorkspaceMessages(workspaceId)
    services.workspaceStore.resetAgentsForNewSession(workspaceId)

    const run = await startAgent(workspaceId, orchestratorId, { hivePort })
    return {
      archivedTasksPath: archivedPath
        ? relative(workspace.summary.path, archivedPath).replaceAll('\\', '/')
        : null,
      run,
      session,
    }
  }

  const executeSwitch = async (
    workspaceId: string,
    sessionId: string,
    hivePort: string
  ): Promise<SessionActivationResult> => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const agents = await stopWorkspaceAgents(workspaceId)
    const target = services.workspaceSessionStore.activateSession(
      workspaceId,
      sessionId,
      getCurrentState(workspaceId)
    )
    const state = services.workspaceSessionStore.getState(workspaceId, target.id)
    restoreAgentState(workspaceId, agents, state.agentSessionIds)
    services.tasksFileService.writeTasks(workspace.summary.path, state.tasksContent)
    const run = await startAgent(workspaceId, getOrchestratorId(workspaceId), { hivePort })
    return { archivedTasksPath: null, run, session: { ...target, active: true } }
  }

  const runExclusive = (workspaceId: string, operation: () => Promise<SessionActivationResult>) => {
    if (operations.has(workspaceId)) {
      throw new ConflictError('A session operation is already running for this workspace')
    }
    const promise = operation().finally(() => {
      if (operations.get(workspaceId) === promise) operations.delete(workspaceId)
    })
    operations.set(workspaceId, promise)
    return promise
  }

  return {
    ensureActiveSession(workspaceId: string) {
      return services.workspaceSessionStore.ensureActiveSession(
        workspaceId,
        getCurrentState(workspaceId)
      )
    },
    listSessions(workspaceId: string) {
      services.workspaceSessionStore.ensureActiveSession(workspaceId, getCurrentState(workspaceId))
      return services.workspaceSessionStore.listSessions(workspaceId)
    },
    startNewSession: (workspaceId: string, hivePort: string, name?: string) =>
      runExclusive(workspaceId, () => executeNew(workspaceId, hivePort, name)),
    switchSession: (workspaceId: string, sessionId: string, hivePort: string) =>
      runExclusive(workspaceId, () => executeSwitch(workspaceId, sessionId, hivePort)),
    deleteSession(workspaceId: string, sessionId: string) {
      if (operations.has(workspaceId)) {
        throw new ConflictError('A session operation is already running for this workspace')
      }
      services.workspaceSessionStore.deleteSession(workspaceId, sessionId)
    },
  }
}

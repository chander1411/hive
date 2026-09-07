import { relative } from 'node:path'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { ConflictError } from './http-errors.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'
import { toSessionScopeId } from './session-scope.js'
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
    input: { hivePort: string; sessionId?: string }
  ) => Promise<LiveAgentRun>
) => {
  const operations = new Map<string, Promise<SessionActivationResult>>()

  const getCurrentState = (workspaceId: string) => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const activeSessionId = services.workspaceSessionStore
      .listSessions(workspaceId)
      .find((session) => session.active)?.id
    const sessionScopeId = toSessionScopeId(workspaceId, activeSessionId)
    return {
      agentSessionIds: Object.fromEntries(
        workspace.agents.flatMap((agent) => {
          const sessionId = services.agentRuntime.getLastSessionId(sessionScopeId, agent.id)
          return sessionId ? [[agent.id, sessionId]] : []
        })
      ),
      tasksContent: activeSessionId
        ? services.tasksFileService.readSessionTasks(
            workspace.summary.path,
            activeSessionId,
            services.tasksFileService.readTasks(workspace.summary.path)
          )
        : services.tasksFileService.readTasks(workspace.summary.path),
    }
  }

  const restoreAgentState = (
    workspaceId: string,
    sessionId: string,
    agents: Array<{ id: string }>,
    agentSessionIds: Record<string, string>
  ) => {
    const scopeId = toSessionScopeId(workspaceId, sessionId)
    for (const agent of agents) {
      services.agentRuntime.clearAgentFreshStart(workspaceId, `${sessionId}:${agent.id}`)
      services.agentRuntime.clearLastSessionId(scopeId, agent.id)
      const nativeSessionId = agentSessionIds[agent.id]
      if (nativeSessionId) {
        services.agentRuntime.setLastSessionId(scopeId, agent.id, nativeSessionId)
      }
    }
    services.workspaceStore.resetAgentsForNewSession(workspaceId)
    const sessionScopeId = toSessionScopeId(workspaceId, sessionId)
    for (const dispatch of services.dispatchLedgerStore.listOpenDispatchKinds()) {
      if (
        dispatch.workspace_id === sessionScopeId &&
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
    const agents = [...workspace.agents]
    const currentState = getCurrentState(workspaceId)
    const session = services.workspaceSessionStore.createSession(workspaceId, currentState, name)

    for (const agent of agents) {
      services.agentRuntime.clearLastSessionId(toSessionScopeId(workspaceId, session.id), agent.id)
      services.agentRuntime.markAgentForFreshStart(workspaceId, `${session.id}:${agent.id}`)
    }

    const { archivedPath } = services.tasksFileService.archiveAndResetTasks(workspace.summary.path)
    services.tasksFileService.writeSessionTasks(workspace.summary.path, session.id, '')
    await services.tasksFileWatcher.start(workspaceId, workspace.summary.path, session.id)
    services.workspaceStore.resetAgentsForNewSession(workspaceId)

    const run = await startAgent(workspaceId, orchestratorId, { hivePort, sessionId: session.id })
    return {
      archivedTasksPath: archivedPath
        ? relative(workspace.summary.path, archivedPath).replaceAll('\\', '/')
        : null,
      run,
      session: { ...session, running: true },
    }
  }

  const executeSwitch = async (
    workspaceId: string,
    sessionId: string,
    hivePort: string
  ): Promise<SessionActivationResult> => {
    const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
    const agents = [...workspace.agents]
    const target = services.workspaceSessionStore.activateSession(
      workspaceId,
      sessionId,
      getCurrentState(workspaceId)
    )
    const state = services.workspaceSessionStore.getState(workspaceId, target.id)
    restoreAgentState(workspaceId, target.id, agents, state.agentSessionIds)
    const tasksContent = services.tasksFileService.readSessionTasks(
      workspace.summary.path,
      target.id,
      state.tasksContent
    )
    services.tasksFileService.writeTasks(workspace.summary.path, tasksContent)
    await services.tasksFileWatcher.start(workspaceId, workspace.summary.path, target.id)
    const run = await startAgent(workspaceId, getOrchestratorId(workspaceId), {
      hivePort,
      sessionId: target.id,
    })
    return {
      archivedTasksPath: null,
      run,
      session: { ...target, active: true, running: true },
    }
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
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      const state = getCurrentState(workspaceId)
      const session = services.workspaceSessionStore.ensureActiveSession(workspaceId, state)
      services.tasksFileService.readSessionTasks(
        workspace.summary.path,
        session.id,
        state.tasksContent
      )
      return session
    },
    listSessions(workspaceId: string) {
      services.workspaceSessionStore.ensureActiveSession(workspaceId, getCurrentState(workspaceId))
      return services.workspaceSessionStore.listSessions(workspaceId)
    },
    startNewSession: (workspaceId: string, hivePort: string, name?: string) =>
      runExclusive(workspaceId, () => executeNew(workspaceId, hivePort, name)),
    switchSession: (workspaceId: string, sessionId: string, hivePort: string) =>
      runExclusive(workspaceId, () => executeSwitch(workspaceId, sessionId, hivePort)),
    async deleteSession(workspaceId: string, sessionId: string) {
      if (operations.has(workspaceId)) {
        throw new ConflictError('A session operation is already running for this workspace')
      }
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      await services.agentRuntime.stopSessionAndWait(workspaceId, sessionId)
      services.workspaceSessionStore.deleteSession(workspaceId, sessionId)
      services.tasksFileService.deleteSessionTasks(workspace.summary.path, sessionId)
    },
  }
}

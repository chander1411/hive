import type { AgentSummary, TeamListItem, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import type { RecoveryMessage } from './message-log-store.js'
import { createWorkspaceSessionOperations, type SessionActivationResult } from './new-session.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRuntimeStoreLifecycle, createRuntimeStoreServices } from './runtime-store-helpers.js'
import { fromSessionScopeId, toSessionScopeId } from './session-scope.js'
import type { SettingsStore } from './settings-store.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
} from './team-operations.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import type { WorkspaceSessionSummary } from './workspace-session-store.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'

interface RuntimeStore {
  close: () => Promise<void>
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  listWorkspaceSessions: (workspaceId: string) => WorkspaceSessionSummary[]
  getActiveWorkspaceSessionId: (workspaceId: string) => string
  deleteWorkspaceSession: (workspaceId: string, sessionId: string) => Promise<void>
  startNewSession: (
    workspaceId: string,
    input: StartAgentOptions & { name?: string }
  ) => Promise<SessionActivationResult>
  switchWorkspaceSession: (
    workspaceId: string,
    sessionId: string,
    input: StartAgentOptions
  ) => Promise<SessionActivationResult>
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  recordUserInput: (
    workspaceId: string,
    orchestratorId: string,
    text: string,
    sessionId?: string
  ) => void
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => ReportTaskResult
  statusTask: (workspaceId: string, workerId: string, input?: StatusTaskInput) => ReportTaskResult
  cancelTask: (workspaceId: string, dispatchId: string, input: CancelTaskInput) => ReportTaskResult
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  listWorkers: (workspaceId: string, sessionId?: string) => TeamListItem[]
  getLastPtyLineForAgent: (
    workspaceId: string,
    agentId: string,
    sessionId?: string
  ) => string | null
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => TerminalRunSummary[]
  closeWorkspaceShell: (workspaceId: string, runId: string) => boolean
  startWorkspaceShell: (workspaceId: string) => Promise<LiveAgentRun>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  autostartConfiguredAgents: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  startWorkspaceWatch: (workspaceId: string) => Promise<void>
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (
    workspaceId: string,
    agentId: string,
    sessionId?: string
  ) => LiveAgentRun | undefined
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => () => void
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  peekAgentToken: (agentId: string, sessionId?: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  settings: SettingsStore
  writeRunInput: (runId: string, input: Buffer | string) => void
  getUiToken: () => string
  stopAgentRun: (runId: string) => void
  validateAgentToken: (agentId: string, token: string | undefined, sessionId?: string) => boolean
  validateUiToken: (token: string | undefined) => boolean
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
}

interface StartAgentOptions {
  hivePort: string
  sessionId?: string | undefined
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager ? { agentManager: options.agentManager, services } : { services }
  )
  const sessionOperations = createWorkspaceSessionOperations(services, lifecycle.startAgent)
  const runDataMutation = (mutation: () => void) => {
    if (!services.db) {
      mutation()
      return
    }
    services.db.transaction(mutation)()
  }
  const activeSessionId = (workspaceId: string) =>
    sessionOperations.ensureActiveSession(workspaceId).id
  return {
    close: lifecycle.close,
    createWorkspace: (path, name) => {
      const workspace = services.workspaceStore.createWorkspace(path, name)
      sessionOperations.ensureActiveSession(workspace.id)
      void lifecycle.startWorkspaceWatch(workspace.id)
      return workspace
    },
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    listWorkspaceSessions: (workspaceId) => {
      const agents = services.workspaceStore.getWorkspaceSnapshot(workspaceId).agents
      return sessionOperations.listSessions(workspaceId).map((session) => ({
        ...session,
        running: agents.some((agent) =>
          Boolean(services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id, session.id))
        ),
      }))
    },
    getActiveWorkspaceSessionId: activeSessionId,
    deleteWorkspaceSession: sessionOperations.deleteSession,
    startNewSession: (workspaceId, input) =>
      sessionOperations.startNewSession(workspaceId, input.hivePort, input.name),
    switchWorkspaceSession: (workspaceId, sessionId, input) =>
      sessionOperations.switchSession(workspaceId, sessionId, input.hivePort),
    deleteWorkspace: async (workspaceId) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      lifecycle.deleteWorkspaceShell(workspaceId)
      await services.agentRuntime.stopWorkspaceAndWait(workspaceId)
      for (const agent of workspace.agents) {
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
      }
      await services.tasksFileWatcher.stop(workspaceId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
        services.workspaceSessionStore.deleteWorkspaceSessions(workspaceId)
        services.workspaceStore.deleteWorkspace(workspaceId)
      })
      if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
        services.settings.setAppState('active_workspace_id', null)
      }
    },
    addWorker: (workspaceId, input) => services.workspaceStore.addWorker(workspaceId, input),
    renameWorker: (workspaceId, workerId, name) =>
      services.workspaceStore.renameWorker(workspaceId, workerId, name),
    deleteWorker: (workspaceId, workerId) => {
      services.agentRuntime.stopAgentAcrossSessions(workspaceId, workerId)
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
        services.workspaceStore.deleteWorker(workspaceId, workerId)
      })
    },
    recordUserInput: (workspaceId, orchestratorId, text, sessionId) =>
      services.teamOps.recordUserInput(
        workspaceId,
        orchestratorId,
        text,
        sessionId ?? activeSessionId(workspaceId)
      ),
    cancelTask: (workspaceId, dispatchId, input) =>
      services.teamOps.cancelTask(workspaceId, dispatchId, {
        ...input,
        sessionId: input.sessionId ?? activeSessionId(workspaceId),
      }),
    dispatchTask: (workspaceId, workerId, text, input = {}) =>
      services.teamOps.dispatchTask(workspaceId, workerId, text, {
        ...input,
        sessionId: input.sessionId ?? activeSessionId(workspaceId),
      }),
    dispatchTaskByWorkerName: (workspaceId, workerName, text, input = {}) =>
      services.teamOps.dispatchTaskByWorkerName(workspaceId, workerName, text, {
        ...input,
        sessionId: input.sessionId ?? activeSessionId(workspaceId),
      }),
    reportTask: (workspaceId, workerId, input = {}) =>
      services.teamOps.reportTask(workspaceId, workerId, {
        ...input,
        sessionId: input.sessionId ?? activeSessionId(workspaceId),
      }),
    statusTask: (workspaceId, workerId, input = {}) =>
      services.teamOps.statusTask(workspaceId, workerId, {
        ...input,
        sessionId: input.sessionId ?? activeSessionId(workspaceId),
      }),
    listDispatches: (workspaceId, options) =>
      services.dispatchLedgerStore
        .listWorkspaceDispatches(
          toSessionScopeId(workspaceId, activeSessionId(workspaceId)),
          options
        )
        .map((dispatch) => ({ ...dispatch, workspaceId })),
    listWorkers: (workspaceId, requestedSessionId) => {
      const sessionId = requestedSessionId ?? activeSessionId(workspaceId)
      const scopeId = toSessionScopeId(workspaceId, sessionId)
      const openDispatches = services.dispatchLedgerStore
        .listWorkspaceDispatches(scopeId, { limit: 10_000 })
        .filter((dispatch) => dispatch.status === 'queued' || dispatch.status === 'submitted')
      return services.workspaceStore.listWorkers(workspaceId).map((worker) => {
        const pendingTaskCount = openDispatches.filter(
          (dispatch) => dispatch.toAgentId === worker.id
        ).length
        const run = services.agentRuntime.getActiveRunByAgentId(workspaceId, worker.id, sessionId)
        return {
          ...worker,
          pendingTaskCount,
          status: run
            ? pendingTaskCount > 0
              ? 'working'
              : 'idle'
            : pendingTaskCount > 0 && worker.status !== 'stopped'
              ? 'working'
              : 'stopped',
        }
      })
    },
    getLastPtyLineForAgent: (workspaceId, agentId, requestedSessionId) =>
      services.workerOutputTracker?.getLastPtyLine(
        workspaceId,
        agentId,
        requestedSessionId ?? activeSessionId(workspaceId)
      ) ?? null,
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    closeWorkspaceShell: lifecycle.closeWorkspaceShell,
    configureAgentLaunch: lifecycle.configureAgentLaunch,
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: (workspaceId, agentId, input) =>
      lifecycle.startAgent(workspaceId, agentId, {
        ...input,
        sessionId: input.sessionId ?? activeSessionId(workspaceId),
      }),
    autostartConfiguredAgents: lifecycle.autostartConfiguredAgents,
    startWorkspaceWatch: lifecycle.startWorkspaceWatch,
    startWorkspaceShell: lifecycle.startWorkspaceShell,
    getLiveRun: lifecycle.getLiveRun,
    getActiveRunByAgentId: (workspaceId, agentId, sessionId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId, sessionId),
    registerTasksListener: lifecycle.registerTasksListener,
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) => {
      const parsed = fromSessionScopeId(workspaceId)
      const scopeId = parsed.sessionId
        ? workspaceId
        : toSessionScopeId(workspaceId, activeSessionId(workspaceId))
      return services.messageLogStore.listMessagesForRecovery(scopeId, sinceMs)
    },
    peekAgentToken: (agentId, sessionId) =>
      services.agentRuntime.peekAgentToken(agentId, sessionId),
    pauseTerminalRun: lifecycle.pauseTerminalRun,
    resizeAgentRun: lifecycle.resizeTerminalRun,
    resumeTerminalRun: lifecycle.resumeTerminalRun,
    settings: services.settings,
    writeRunInput: lifecycle.writeRunInput,
    getUiToken: () => services.uiAuth.getToken(),
    stopAgentRun: lifecycle.stopTerminalRun,
    validateAgentToken: (agentId, token, sessionId) =>
      services.agentRuntime.validateAgentToken(agentId, token, sessionId),
    validateUiToken: (token) => services.uiAuth.validate(token),
  }
}

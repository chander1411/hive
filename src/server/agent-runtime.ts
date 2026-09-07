import type { AgentSummary } from '../shared/types.js'
import { createAgentLaunchCache } from './agent-launch-cache.js'
import type { AgentManager } from './agent-manager.js'
import { createAgentRunStarter } from './agent-run-starter.js'
import { syncPersistedRun } from './agent-run-sync.js'
import { getActiveRunByAgent } from './agent-runtime-active-run.js'
import { closeAgentRuntime } from './agent-runtime-close.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { createAgentRuntimeFlowAdapter } from './agent-runtime-flow-adapter.js'
import { listRunsWithFallback } from './agent-runtime-list-runs.js'
import type { AgentRunStorePort, AgentSessionStorePort } from './agent-runtime-ports.js'
import { stopLiveRun } from './agent-runtime-stop-run.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createAgentStdinDispatcher } from './agent-stdin-dispatcher.js'
import { createAgentTokenRegistry } from './agent-tokens.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import { createLiveRunRegistry } from './live-run-registry.js'
import type { PromptLanguage } from './prompt-language.js'
import { createNoopRestartPolicy, type RestartPolicy } from './restart-policy.js'

export const createAgentRuntime = (
  agentManager: AgentManager | undefined,
  agentRunStore: AgentRunStorePort,
  sessionStore: AgentSessionStorePort,
  getCommandPreset: (id: string) => CommandPresetRecord | undefined,
  onAgentExit: (workspaceId: string, agentId: string, sessionId?: string) => void,
  restartPolicy: RestartPolicy = createNoopRestartPolicy(),
  getAgent?: (workspaceId: string, agentId: string) => AgentSummary | undefined,
  getPromptLanguage: () => PromptLanguage = () => 'zh'
): AgentRuntime => {
  const registry = createLiveRunRegistry()
  const launchCache = createAgentLaunchCache(agentRunStore)
  const tokenRegistry = createAgentTokenRegistry()
  const startPromises = new Map<string, Promise<LiveAgentRun>>()
  const freshStartAgents = new Set<string>()
  const sessionGenerations = new Map<string, number>()
  let closing = false
  const requireManager = () => {
    if (!agentManager) throw new Error('Agent manager is required for PTY terminal operations')
    return agentManager
  }
  const flowAdapter = createAgentRuntimeFlowAdapter(requireManager)
  const getAgentKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`
  const runtimeSessionStore: AgentSessionStorePort = {
    ...sessionStore,
    clearLastSessionId(workspaceId, agentId) {
      const key = getAgentKey(workspaceId, agentId)
      sessionGenerations.set(key, (sessionGenerations.get(key) ?? 0) + 1)
      sessionStore.clearLastSessionId(workspaceId, agentId)
    },
    getGeneration(workspaceId, agentId) {
      return sessionGenerations.get(getAgentKey(workspaceId, agentId)) ?? 0
    },
  }

  const syncRun = (run: LiveAgentRun) =>
    agentManager ? syncPersistedRun(run, agentManager.getRun(run.runId), agentRunStore) : run
  const stdinDispatcher = createAgentStdinDispatcher({
    agentManager,
    getLaunchConfig: launchCache.peek,
    getWorkspaceId: launchCache.getWorkspaceId,
    registry,
    syncRun,
    getPromptLanguage,
  })
  const startLiveRun = createAgentRunStarter({
    agentManager,
    registry,
    onAgentExit,
    store: agentRunStore,
    sessionStore: runtimeSessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    getPromptLanguage,
    restartPolicy,
    completeFreshStart: (workspaceId, agentId) => {
      freshStartAgents.delete(getAgentKey(workspaceId, agentId))
    },
    isFreshStart: (workspaceId, agentId) => freshStartAgents.has(getAgentKey(workspaceId, agentId)),
  })

  return {
    clearAgentFreshStart(workspaceId, agentId) {
      freshStartAgents.delete(getAgentKey(workspaceId, agentId))
    },
    clearLastSessionId(workspaceId, agentId) {
      runtimeSessionStore.clearLastSessionId(workspaceId, agentId)
    },
    async close() {
      closing = true
      await Promise.allSettled([...startPromises.values()])
      await closeAgentRuntime(agentManager, registry, syncRun)
    },
    configureAgentLaunch(workspaceId, agentId, input) {
      launchCache.save(workspaceId, agentId, input)
    },
    deleteAgentLaunchConfig(workspaceId, agentId) {
      launchCache.remove(workspaceId, agentId)
    },
    peekAgentLaunchConfig(workspaceId, agentId) {
      return launchCache.peek(workspaceId, agentId)
    },
    getActiveRunByAgentId(workspaceId, agentId, sessionId) {
      return getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspaceId,
        agentId,
        sessionId
      )
    },
    getLiveRun(runId) {
      const run = registry.get(runId)
      if (!run) throw new Error(`Live run not found: ${runId}`)
      return syncRun(run)
    },
    getLastSessionId(workspaceId, agentId) {
      return runtimeSessionStore.getLastSessionId(workspaceId, agentId)
    },
    getPtyOutputBus() {
      return flowAdapter.getOutputBus()
    },
    listAgentRuns(agentId) {
      return listRunsWithFallback(registry, agentRunStore.listAgentRuns(agentId), agentId)
    },
    markAgentForFreshStart(workspaceId, agentId) {
      freshStartAgents.add(getAgentKey(workspaceId, agentId))
    },
    pauseRun(runId) {
      flowAdapter.pauseRun(runId)
    },
    peekAgentToken(agentId, sessionId) {
      if (sessionId) return tokenRegistry.peek(`${sessionId}:${agentId}`)
      const active = registry
        .list()
        .filter((run) => run.agentId === agentId)
        .sort((left, right) => right.startedAt - left.startedAt)
        .find((run) => run.status === 'starting' || run.status === 'running')
      return tokenRegistry.peek(active?.sessionId ? `${active.sessionId}:${agentId}` : agentId)
    },
    resizeAgentRun(runId, cols, rows) {
      flowAdapter.resizeRun(runId, cols, rows)
    },
    resumeRun(runId) {
      flowAdapter.resumeRun(runId)
    },
    setLastSessionId(workspaceId, agentId, sessionId) {
      runtimeSessionStore.setLastSessionId(workspaceId, agentId, sessionId)
    },
    async startAgent(workspace, agentId, input) {
      if (closing) throw new Error('Agent runtime is closing')
      launchCache.setWorkspaceId(agentId, workspace.id)
      const key = `${getAgentKey(workspace.id, agentId)}:${input.sessionId ?? 'legacy'}`
      const activeRun = getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspace.id,
        agentId,
        input.sessionId
      )
      if (activeRun) return activeRun
      const pendingStart = startPromises.get(key)
      if (pendingStart) return pendingStart
      const startPromise = startLiveRun(
        workspace,
        agentId,
        launchCache.get(workspace.id, agentId),
        input.hivePort,
        input.sessionId
      ).finally(() => {
        if (startPromises.get(key) === startPromise) {
          startPromises.delete(key)
        }
      })
      startPromises.set(key, startPromise)
      return startPromise
    },
    stopAgentRun(runId) {
      stopLiveRun(agentManager, registry, syncRun, runId)
    },
    stopAgentAcrossSessions(workspaceId, agentId) {
      for (const run of registry
        .list()
        .filter((item) => item.workspaceId === workspaceId && item.agentId === agentId)) {
        stopLiveRun(agentManager, registry, syncRun, run.runId)
      }
    },
    async stopAgentAndWait(workspaceId, agentId, sessionId) {
      const key = `${getAgentKey(workspaceId, agentId)}:${sessionId ?? 'legacy'}`
      try {
        await startPromises.get(key)
      } catch {
        return
      }
      const activeRun = getActiveRunByAgent(
        registry,
        launchCache.getWorkspaceId,
        syncRun,
        workspaceId,
        agentId,
        sessionId
      )
      if (!activeRun) return
      const exitEntry = registry.getExitEntry(activeRun.runId)
      stopLiveRun(agentManager, registry, syncRun, activeRun.runId)
      await exitEntry?.promise
    },
    async stopSessionAndWait(workspaceId, sessionId) {
      await Promise.allSettled([...startPromises.values()])
      const runs = registry
        .list()
        .filter((run) => run.workspaceId === workspaceId && run.sessionId === sessionId)
      await Promise.all(
        runs.map(async (run) => {
          const exitEntry = registry.getExitEntry(run.runId)
          stopLiveRun(agentManager, registry, syncRun, run.runId)
          await exitEntry?.promise
        })
      )
    },
    async stopWorkspaceAndWait(workspaceId) {
      await Promise.allSettled([...startPromises.values()])
      const runs = registry.list().filter((run) => run.workspaceId === workspaceId)
      await Promise.all(
        runs.map(async (run) => {
          const exitEntry = registry.getExitEntry(run.runId)
          stopLiveRun(agentManager, registry, syncRun, run.runId)
          await exitEntry?.promise
        })
      )
    },
    validateAgentToken(agentId, token, sessionId) {
      if (sessionId) return tokenRegistry.validate(`${sessionId}:${agentId}`, token)
      if (tokenRegistry.validate(agentId, token)) return true
      return registry
        .list()
        .filter((run) => run.agentId === agentId && run.sessionId)
        .some((run) => tokenRegistry.validate(`${run.sessionId}:${agentId}`, token))
    },
    writeReportPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      stdinDispatcher.writeReportPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeStatusPrompt(workspaceId, workerName, _workerId, text, artifacts, input = {}) {
      stdinDispatcher.writeStatusPrompt(workspaceId, workerName, text, artifacts, input)
    },
    writeSendPrompt(
      workspaceId,
      workerId,
      dispatchId,
      fromAgentName,
      workerDescription,
      text,
      sessionId
    ) {
      stdinDispatcher.writeSendPrompt(
        workspaceId,
        workerId,
        dispatchId,
        fromAgentName,
        workerDescription,
        text,
        sessionId
      )
    },
    writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input = {}) {
      stdinDispatcher.writeCancelPrompt(workspaceId, workerId, dispatchId, reason, input)
    },
    writeUserInputPrompt(workspaceId, text, sessionId) {
      stdinDispatcher.writeUserInputPrompt(workspaceId, text, sessionId)
    },
  }
}

export type { AgentRuntime }

import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import { buildAgentRunBootstrap, startAgentRunCapture } from './agent-run-bootstrap.js'
import { handleAgentRunExit } from './agent-run-exit-handler.js'
import type { AgentRunExitContext, AgentRunStarterStorePort } from './agent-run-start-context.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { AgentSessionStorePort } from './agent-runtime-ports.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { buildAgentStartupInstructions } from './agent-startup-instructions.js'
import type { AgentTokenRegistry } from './agent-tokens.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { createPostStartInputWriter, isInteractiveAgentCommand } from './post-start-input-writer.js'
import type { PromptLanguage } from './prompt-language.js'
import type { RestartPolicy } from './restart-policy.js'
import { toSessionScopeId } from './session-scope.js'

interface AgentRunStarterInput {
  agentManager: AgentManager | undefined
  registry: LiveRunRegistry
  onAgentExit: (workspaceId: string, agentId: string, sessionId?: string) => void
  store: AgentRunStarterStorePort
  sessionStore: AgentSessionStorePort
  tokenRegistry: AgentTokenRegistry
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
  getAgent: ((workspaceId: string, agentId: string) => AgentSummary | undefined) | undefined
  getPromptLanguage: () => PromptLanguage
  restartPolicy: RestartPolicy
  completeFreshStart: (workspaceId: string, agentId: string) => void
  isFreshStart: (workspaceId: string, agentId: string) => boolean
}

export const createAgentRunStarter =
  ({
    agentManager,
    registry,
    onAgentExit,
    store,
    sessionStore,
    tokenRegistry,
    getCommandPreset,
    getAgent,
    getPromptLanguage,
    restartPolicy,
    completeFreshStart,
    isFreshStart,
  }: AgentRunStarterInput) =>
  async (
    workspace: WorkspaceSummary,
    agentId: string,
    config: AgentLaunchConfigInput,
    hivePort: string,
    sessionId?: string
  ) => {
    if (!agentManager) throw new Error('Agent manager is required to start agents')

    const agent = getAgent?.(workspace.id, agentId)
    const freshnessAgentId = sessionId ? `${sessionId}:${agentId}` : agentId
    const freshStart = isFreshStart(workspace.id, freshnessAgentId)
    const sessionWorkspaceId = toSessionScopeId(workspace.id, sessionId)
    const scopedNativeSessionId = sessionStore.getLastSessionId(sessionWorkspaceId, agentId)
    const legacyNativeSessionId = freshStart
      ? undefined
      : sessionStore.getLastSessionId(workspace.id, agentId)
    if (sessionId && !scopedNativeSessionId && legacyNativeSessionId) {
      sessionStore.setLastSessionId(sessionWorkspaceId, agentId, legacyNativeSessionId)
    }
    const scopedSessionStore: AgentSessionStorePort = {
      clearLastSessionId: (_workspaceId, id) => {
        sessionStore.clearLastSessionId(sessionWorkspaceId, id)
        if (sessionId) sessionStore.clearLastSessionId(workspace.id, id)
      },
      getGeneration: (_workspaceId, id) =>
        sessionStore.getGeneration?.(sessionWorkspaceId, id) ?? 0,
      getLastSessionId: (_workspaceId, id) => sessionStore.getLastSessionId(sessionWorkspaceId, id),
      setLastSessionId: (_workspaceId, id, nativeSessionId) => {
        sessionStore.setLastSessionId(sessionWorkspaceId, id, nativeSessionId)
        if (sessionId) sessionStore.setLastSessionId(workspace.id, id, nativeSessionId)
      },
    }
    const { sessionCaptureSnapshot, startConfig, startEnv } = buildAgentRunBootstrap(
      workspace,
      agentId,
      config,
      scopedSessionStore,
      getCommandPreset,
      agent,
      freshStart,
      sessionId
    )
    const handledRunExits = new Set<string>()
    const abortedRunIds = new Set<string>()
    const startedAt = Date.now()
    const tokenIdentity = sessionId ? `${sessionId}:${agentId}` : agentId
    const token = tokenRegistry.issue(tokenIdentity)
    const exitContext: AgentRunExitContext = {
      agentId,
      handledRunExits,
      onAgentExit,
      registry,
      sessionStore: scopedSessionStore,
      startConfig,
      store,
      token,
      tokenIdentity,
      tokenRegistry,
      workspace,
      ...(sessionId ? { sessionId } : {}),
    }
    const startInput = {
      agentId,
      command: startConfig.command,
      cwd: workspace.path,
      env: {
        ...startEnv,
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'hive',
        HIVE_PORT: hivePort,
        HIVE_AGENT_TOKEN: token,
        ...(sessionId ? { HIVE_SESSION_ID: sessionId } : {}),
      },
      onExit: ({ runId, exitCode }: { runId: string; exitCode: number | null }) => {
        const endedAt = Date.now()
        if (
          !handleAgentRunExit(exitContext, { exitCode, endedAt, runId }) &&
          abortedRunIds.has(runId)
        ) {
          registry.clearPendingExitCode(runId)
          return
        }
      },
    }

    let run: Awaited<ReturnType<AgentManager['startAgent']>>
    try {
      run = await agentManager.startAgent(
        startConfig.args ? { ...startInput, args: startConfig.args } : startInput
      )
    } catch (error) {
      tokenRegistry.revokeIfMatches(tokenIdentity, token)
      throw error
    }
    const liveRun: LiveAgentRun = {
      ...run,
      exitCode: run.status === 'error' ? run.exitCode : null,
      ...(sessionId ? { sessionId } : {}),
      startedAt,
      status: run.status === 'error' ? 'error' : 'starting',
      workspaceId: workspace.id,
    }
    try {
      store.insertAgentRun(run.runId, agentId, startedAt, run.pid, liveRun.status, liveRun.exitCode)
    } catch (error) {
      abortedRunIds.add(run.runId)
      registry.clearPendingExitCode(run.runId)
      tokenRegistry.revokeIfMatches(tokenIdentity, token)
      agentManager.stopRun(run.runId)
      throw error
    }
    registry.createExitEntry(run.runId)
    registry.add(liveRun)

    if (run.status === 'error') {
      store.updatePersistedRun(run.runId, 'error', run.exitCode, Date.now())
      if (startConfig.resumedSessionId) {
        scopedSessionStore.clearLastSessionId(workspace.id, agentId)
      }
      tokenRegistry.revokeIfMatches(tokenIdentity, token)
      // Ensure §12 three-state: failed spawn must flip AgentSummary to stopped.
      onAgentExit(workspace.id, agentId, sessionId)
      registry.resolveExit(run.runId)
      registry.clearPendingExitCode(run.runId)
      return liveRun
    }

    startAgentRunCapture({
      agentId,
      sessionCaptureSnapshot,
      sessionStore: scopedSessionStore,
      startConfig,
      workspace,
    })
    const postStartWriter = createPostStartInputWriter(
      agentManager,
      startConfig.interactiveCommand ?? startConfig.command
    )
    queueMicrotask(() => {
      try {
        const injectedRestartMessage = freshStart
          ? false
          : restartPolicy.injectPostStartMessage({
              agentId,
              runId: run.runId,
              sessionId,
              startConfig,
              workspace,
              writeToRun: postStartWriter,
            })
        if (
          !startConfig.resumedSessionId &&
          !injectedRestartMessage &&
          agent &&
          isInteractiveAgentCommand(startConfig.interactiveCommand ?? startConfig.command)
        ) {
          postStartWriter(
            run.runId,
            buildAgentStartupInstructions({
              agent,
              workspace,
              language: getPromptLanguage(),
              newSession: freshStart,
              sessionId,
            })
          )
        }
      } catch {
        // The agent may have exited before post-start guidance could be written.
      }
    })
    if (freshStart) completeFreshStart(workspace.id, freshnessAgentId)

    if (registry.hasPendingExitCode(run.runId)) {
      const exitCode = registry.getPendingExitCode(run.runId) ?? null
      queueMicrotask(() => {
        handleAgentRunExit(exitContext, { exitCode, endedAt: Date.now(), runId: run.runId })
      })
    }

    return liveRun
  }

import { useCallback, useEffect, useState } from 'react'
import type { TerminalRunSummary } from '../api.js'
import {
  deleteWorkspaceSession,
  listWorkspaceSessions,
  type OrchestratorStartResult,
  startAgentRun,
  startNewSession,
  stopAgentRun,
  switchWorkspaceSession,
  type WorkspaceSessionSummary,
} from '../api.js'
import { findOrchestratorRun, orchestratorAgentId } from '../terminal/useTerminalRuns.js'
import type { OrchestratorPaneState } from './OrchestratorPane.js'

interface UseOrchestratorPaneStateInput {
  workspaceId: string
  terminalRuns: TerminalRunSummary[]
  /** Latest known autostart error for this workspace (sticky until cleared). */
  autostartError: string | null
  /**
   * A just-created workspace may already have a server-side autostart run.
   * Suppress client-side auto-start briefly until terminalRuns catches up.
   */
  suppressAutostartRunId?: string | null
  onClearAutostartError: () => void
  /** Optional callback fired after a manual start succeeds — lets parent
   *  invalidate caches / refresh runs immediately. */
  onAfterStart?: (result: OrchestratorStartResult) => void
}

interface UseOrchestratorPaneStateOutput {
  state: OrchestratorPaneState
  start: () => void
  stop: () => void
  restart: () => void
  deleteSession: (sessionId: string) => Promise<void>
  newSession: (name?: string) => void
  newSessionPending: boolean
  sessions: WorkspaceSessionSummary[]
  sessionSwitchPending: boolean
  switchSession: (sessionId: string) => void
}

/**
 * Derives the Orchestrator pane shape from live terminal runs + explicit
 * start attempts. Live `running` always wins; runtime restarts intentionally
 * land in `stopped` instead of silently autostarting a new CLI process.
 */
export const useOrchestratorPaneState = ({
  workspaceId,
  terminalRuns,
  autostartError,
  suppressAutostartRunId,
  onClearAutostartError,
  onAfterStart,
}: UseOrchestratorPaneStateInput): UseOrchestratorPaneStateOutput => {
  const orchestratorRun = findOrchestratorRun(terminalRuns, workspaceId)
  const agentId = orchestratorAgentId(workspaceId)
  const [pendingStartWorkspaceId, setPendingStartWorkspaceId] = useState<string | null>(null)
  const [optimisticRun, setOptimisticRun] = useState<{
    workspaceId: string
    runId: string
  } | null>(null)
  const [suppressedRunId, setSuppressedRunId] = useState<string | null>(null)
  const [newSessionWorkspaceId, setNewSessionWorkspaceId] = useState<string | null>(null)
  const [sessionSwitchWorkspaceId, setSessionSwitchWorkspaceId] = useState<string | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([])
  const optimisticRunId = optimisticRun?.workspaceId === workspaceId ? optimisticRun.runId : null
  const suppressingAutostart = Boolean(suppressedRunId && !orchestratorRun && !optimisticRunId)

  useEffect(() => {
    setSuppressedRunId(suppressAutostartRunId ?? null)
  }, [suppressAutostartRunId])

  useEffect(() => {
    if (!workspaceId) {
      setSessions([])
      return
    }
    let cancelled = false
    void listWorkspaceSessions(workspaceId)
      .then((result) => {
        if (!cancelled) setSessions(result)
      })
      .catch((error: unknown) => {
        console.error('[hive] swallowed:workspaceSessions.list', error)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (orchestratorRun) {
      setPendingStartWorkspaceId(null)
      setOptimisticRun(null)
      setSuppressedRunId(null)
    }
  }, [orchestratorRun])

  useEffect(() => {
    if (!suppressedRunId || orchestratorRun) return
    const timer = window.setTimeout(() => setSuppressedRunId(null), 1500)
    return () => window.clearTimeout(timer)
  }, [suppressedRunId, orchestratorRun])

  useEffect(() => {
    if (!optimisticRunId || orchestratorRun) return
    const timer = window.setTimeout(() => setOptimisticRun(null), 2000)
    return () => window.clearTimeout(timer)
  }, [optimisticRunId, orchestratorRun])

  let state: OrchestratorPaneState
  if (optimisticRunId && orchestratorRun?.run_id !== optimisticRunId) {
    state = { kind: 'running', runId: optimisticRunId }
  } else if (orchestratorRun) {
    state = { kind: 'running', runId: orchestratorRun.run_id }
  } else if (pendingStartWorkspaceId === workspaceId || suppressingAutostart) {
    state = { kind: 'starting' }
  } else if (autostartError) {
    state = { kind: 'failed', error: autostartError }
  } else {
    state = { kind: 'stopped' }
  }

  const start = useCallback(() => {
    if (!workspaceId || pendingStartWorkspaceId === workspaceId || orchestratorRun) return
    onClearAutostartError()
    setPendingStartWorkspaceId(workspaceId)
    void startAgentRun(workspaceId, agentId)
      .then((result) => {
        setOptimisticRun({ workspaceId, runId: result.runId })
        onAfterStart?.({ ok: true, error: null, run_id: result.runId })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to start Queen'
        setOptimisticRun(null)
        onAfterStart?.({ ok: false, error: message, run_id: null })
      })
      .finally(() =>
        setPendingStartWorkspaceId((current) => (current === workspaceId ? null : current))
      )
  }, [
    agentId,
    onAfterStart,
    onClearAutostartError,
    orchestratorRun,
    pendingStartWorkspaceId,
    workspaceId,
  ])

  const stop = useCallback(() => {
    if (!orchestratorRun) return
    void stopAgentRun(orchestratorRun.run_id).catch((error: unknown) => {
      console.error('[hive] swallowed:orchestrator.stop', error)
    })
  }, [orchestratorRun])

  const restart = useCallback(() => {
    onClearAutostartError()
    if (orchestratorRun) {
      void stopAgentRun(orchestratorRun.run_id)
        .catch((error: unknown) => {
          // Best-effort stop before restart; failure is reported via the
          // subsequent .catch on startAgentRun if start fails.
          console.error('[hive] swallowed:orchestrator.restart.stop', error)
        })
        .then(() => startAgentRun(workspaceId, agentId))
        .then((result) => {
          setOptimisticRun({ workspaceId, runId: result.runId })
          onAfterStart?.({ ok: true, error: null, run_id: result.runId })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to restart Queen'
          onAfterStart?.({ ok: false, error: message, run_id: null })
        })
      return
    }
    start()
  }, [agentId, onAfterStart, onClearAutostartError, orchestratorRun, start, workspaceId])

  const newSession = useCallback(
    (name?: string) => {
      if (!workspaceId || newSessionWorkspaceId === workspaceId) return
      onClearAutostartError()
      setNewSessionWorkspaceId(workspaceId)
      void startNewSession(workspaceId, name)
        .then((result) => {
          setOptimisticRun({ workspaceId, runId: result.runId })
          setSessions((current) => [
            ...current
              .filter((session) => session.id !== result.session.id)
              .map((session) => ({ ...session, active: false })),
            result.session,
          ])
          onAfterStart?.({ ok: true, error: null, run_id: result.runId })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to start a new session'
          onAfterStart?.({ ok: false, error: message, run_id: null })
        })
        .finally(() =>
          setNewSessionWorkspaceId((current) => (current === workspaceId ? null : current))
        )
    },
    [newSessionWorkspaceId, onAfterStart, onClearAutostartError, workspaceId]
  )

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!workspaceId || deletingSessionId) return
      setDeletingSessionId(sessionId)
      try {
        await deleteWorkspaceSession(workspaceId, sessionId)
        setSessions((current) => current.filter((session) => session.id !== sessionId))
      } finally {
        setDeletingSessionId(null)
      }
    },
    [deletingSessionId, workspaceId]
  )

  const switchSession = useCallback(
    (sessionId: string) => {
      if (
        !workspaceId ||
        sessionSwitchWorkspaceId === workspaceId ||
        sessions.some((session) => session.id === sessionId && session.active)
      ) {
        return
      }
      onClearAutostartError()
      setSessionSwitchWorkspaceId(workspaceId)
      void switchWorkspaceSession(workspaceId, sessionId)
        .then((result) => {
          setOptimisticRun({ workspaceId, runId: result.runId })
          setSessions((current) =>
            current.map((session) => ({ ...session, active: session.id === result.session.id }))
          )
          onAfterStart?.({ ok: true, error: null, run_id: result.runId })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to switch session'
          onAfterStart?.({ ok: false, error: message, run_id: null })
        })
        .finally(() =>
          setSessionSwitchWorkspaceId((current) => (current === workspaceId ? null : current))
        )
    },
    [onAfterStart, onClearAutostartError, sessionSwitchWorkspaceId, sessions, workspaceId]
  )

  return {
    state,
    deleteSession,
    start,
    stop,
    restart,
    newSession,
    newSessionPending: newSessionWorkspaceId === workspaceId,
    sessions,
    sessionSwitchPending: sessionSwitchWorkspaceId === workspaceId,
    switchSession,
  }
}

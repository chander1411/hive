// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { useOrchestratorPaneState } from '../../web/src/worker/useOrchestratorPaneState.js'

const { listWorkspaceSessions, startAgentRun, startNewSession } = vi.hoisted(() => ({
  listWorkspaceSessions: vi.fn().mockResolvedValue([]),
  startAgentRun: vi.fn(),
  startNewSession: vi.fn(),
}))

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    listWorkspaceSessions: (...args: unknown[]) => listWorkspaceSessions(...args),
    startAgentRun: (...args: unknown[]) => startAgentRun(...args),
    startNewSession: (...args: unknown[]) => startNewSession(...args),
    stopAgentRun: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  startAgentRun.mockReset()
  startNewSession.mockReset()
  listWorkspaceSessions.mockClear()
})

const NewSessionHarness = () => {
  const orchestrator = useOrchestratorPaneState({
    workspaceId: 'workspace-1',
    terminalRuns: [
      {
        agent_id: 'workspace-1:orchestrator',
        agent_name: 'Queen',
        run_id: 'old-run',
        status: 'running',
      },
    ],
    autostartError: null,
    onClearAutostartError: vi.fn(),
  })
  const runId = orchestrator.state.kind === 'running' ? orchestrator.state.runId : ''
  return (
    <button type="button" data-testid="new-session-state" onClick={() => orchestrator.newSession()}>
      {runId}
    </button>
  )
}

const Harness = () => {
  const orchestrator = useOrchestratorPaneState({
    workspaceId: 'workspace-1',
    terminalRuns: [],
    autostartError: null,
    onClearAutostartError: vi.fn(),
  })

  return (
    <button type="button" data-testid="state" onClick={orchestrator.start}>
      {orchestrator.state.kind}
    </button>
  )
}

describe('useOrchestratorPaneState restart semantics', () => {
  test('no live run renders stopped and does not autostart', async () => {
    render(<Harness />)

    expect(screen.getByTestId('state')).toHaveTextContent('stopped')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(startAgentRun).not.toHaveBeenCalled()
  })

  test('manual start moves through starting and calls the start endpoint', async () => {
    startAgentRun.mockResolvedValueOnce({ runId: 'run-1' })
    render(<Harness />)

    fireEvent.click(screen.getByTestId('state'))

    expect(screen.getByTestId('state')).toHaveTextContent('starting')
    await waitFor(() => {
      expect(startAgentRun).toHaveBeenCalledWith('workspace-1', 'workspace-1:orchestrator')
    })
  })

  test('new session immediately replaces the prior run instead of showing its terminal buffer', async () => {
    startNewSession.mockResolvedValueOnce({
      archivedTasksPath: null,
      runId: 'new-run',
      session: {
        active: true,
        createdAt: 2,
        id: 'session-2',
        name: 'Session 2',
        updatedAt: 2,
        workspaceId: 'workspace-1',
      },
    })
    render(<NewSessionHarness />)

    expect(screen.getByTestId('new-session-state')).toHaveTextContent('old-run')
    fireEvent.click(screen.getByTestId('new-session-state'))
    await waitFor(() => {
      expect(screen.getByTestId('new-session-state')).toHaveTextContent('new-run')
    })
  })
})

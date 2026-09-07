// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  OrchestratorPane,
  type OrchestratorPaneState,
} from '../../web/src/worker/OrchestratorPane.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const renderPane = (state: OrchestratorPaneState) => {
  const onStop = vi.fn()
  const onStart = vi.fn()
  const onRestart = vi.fn()
  const onNewSession = vi.fn()
  const onDeleteSession = vi.fn().mockResolvedValue(undefined)
  const onSwitchSession = vi.fn()
  const onRemoveWorkspace = vi.fn()
  render(
    <OrchestratorPane
      state={state}
      newSessionPending={false}
      onDeleteSession={onDeleteSession}
      onNewSession={onNewSession}
      onSwitchSession={onSwitchSession}
      sessionSwitchPending={false}
      sessions={[
        {
          active: true,
          createdAt: 1,
          id: 'session-1',
          name: 'Session 1',
          running: true,
          updatedAt: 1,
          workspaceId: 'workspace-1',
        },
        {
          active: false,
          createdAt: 2,
          id: 'session-2',
          name: 'Session 2',
          running: false,
          updatedAt: 2,
          workspaceId: 'workspace-1',
        },
      ]}
      onStop={onStop}
      onStart={onStart}
      onRestart={onRestart}
      onRemoveWorkspace={onRemoveWorkspace}
    />
  )
  return {
    onDeleteSession,
    onNewSession,
    onRemoveWorkspace,
    onStop,
    onStart,
    onRestart,
    onSwitchSession,
  }
}

describe('OrchestratorPane three-state UI', () => {
  test('starting: shows passive startup state without a manual Start Orchestrator CTA', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'starting' })

    expect(screen.getByTestId('orchestrator-starting-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Starting Orchestrator')
    expect(screen.queryByTestId('orchestrator-start')).toBeNull()
    expect(screen.queryByText('Orchestrator is offline')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('stopped: shows explicit Start Orchestrator CTA', () => {
    const { onStop, onStart, onRestart } = renderPane({ kind: 'stopped' })

    expect(screen.getByTestId('orchestrator-stopped-body')).toBeInTheDocument()
    expect(screen.getByTestId('empty-state-title')).toHaveTextContent('Orchestrator is stopped')
    const start = screen.getByTestId('orchestrator-start')
    expect(start).toHaveTextContent('Start Orchestrator')

    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('running: PTY slot mounts and New Session requires confirmation', () => {
    const { onNewSession, onStop, onStart, onRestart, onSwitchSession } = renderPane({
      kind: 'running',
      runId: 'run-abc',
    })

    // PTY slot must use the run id so TerminalView can portal into it.
    const slot = document.getElementById('orch-pty-run-abc')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('data-pty-slot')).toBe('orchestrator')

    expect(screen.queryByTestId('orchestrator-stop')).toBeNull()
    expect(screen.queryByTestId('orchestrator-restart')).toBeNull()
    fireEvent.click(screen.getByTestId('orchestrator-session-manager'))
    fireEvent.click(screen.getByText('Session 2'))
    expect(onSwitchSession).toHaveBeenCalledWith('session-2')
    fireEvent.click(screen.getByTestId('orchestrator-new-session'))
    expect(screen.getByText('Start a new session?')).toBeInTheDocument()
    expect(
      screen.getByText(/The current AI conversation context will not be resumed/)
    ).toHaveTextContent('The current AI conversation context will not be resumed.')
    expect(onNewSession).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('new-session-name'), { target: { value: 'Planning' } })
    fireEvent.click(screen.getByTestId('new-session-submit'))
    expect(onNewSession).toHaveBeenCalledWith('Planning')
    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-stopped-body')).toBeNull()
    expect(screen.queryByTestId('orchestrator-failed-body')).toBeNull()

    expect(onStop).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
    expect(onRestart).not.toHaveBeenCalled()
  })

  test('failed: surfaces error string + Retry CTA, click dispatches onRestart', () => {
    const errorMessage = 'claude CLI not found in PATH'
    const { onRemoveWorkspace, onStop, onStart, onRestart } = renderPane({
      kind: 'failed',
      error: errorMessage,
    })

    expect(screen.getByTestId('orchestrator-failed-body')).toBeInTheDocument()
    expect(screen.getByTestId('orchestrator-error-message')).toHaveTextContent(errorMessage)
    const retryBody = screen.getByTestId('orchestrator-retry')
    expect(retryBody).toHaveTextContent('Retry')

    expect(screen.queryByTestId('orchestrator-starting-body')).toBeNull()

    fireEvent.click(retryBody)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()

    const remove = screen.getByTestId('orchestrator-remove-workspace')
    expect(remove).toHaveTextContent('Remove workspace')
    fireEvent.click(remove)
    expect(onRemoveWorkspace).toHaveBeenCalledTimes(1)
  })

  test('session manager searches and deletes an inactive session', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onDeleteSession } = renderPane({ kind: 'running', runId: 'run-abc' })

    fireEvent.click(screen.getByTestId('orchestrator-session-manager'))
    expect(screen.getByTestId('delete-session-session-1')).toBeDisabled()
    fireEvent.change(screen.getByTestId('session-search'), { target: { value: 'Session 2' } })
    expect(screen.queryByTestId('session-row-session-1')).toBeNull()
    fireEvent.click(screen.getByTestId('delete-session-session-2'))

    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith('session-2'))
  })
})

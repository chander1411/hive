import * as Dialog from '@radix-ui/react-dialog'
import { Copy, Crown, FilePlus2, History, LoaderCircle, Play, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { WorkspaceSessionSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { EmptyState } from '../ui/EmptyState.js'
import { Tooltip } from '../ui/Tooltip.js'
import { SessionManagerDialog } from './SessionManagerDialog.js'

export type OrchestratorPaneState =
  | { kind: 'starting' }
  | { kind: 'running'; runId: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

type OrchestratorPaneProps = {
  state: OrchestratorPaneState
  /** Kept for API stability; M6-B will surface stop via the ⌘K palette. */
  onStop: () => void
  onRemoveWorkspace: () => void
  onStart: () => void
  onRestart: () => void
  onDeleteSession: (sessionId: string) => Promise<void>
  onNewSession: (name?: string) => void
  newSessionPending: boolean
  onSwitchSession: (sessionId: string) => void
  sessions: WorkspaceSessionSummary[]
  sessionSwitchPending: boolean
}

const StartingBody = () => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-starting-body" className="flex flex-1">
      <EmptyState
        icon={<LoaderCircle size={24} className="animate-spin" />}
        title={t('orchestrator.startingTitle')}
        description={t('orchestrator.startingDesc')}
      />
    </div>
  )
}

const StoppedBody = ({ onStart }: { onStart: () => void }) => {
  const { t } = useI18n()
  return (
    <div data-testid="orchestrator-stopped-body" className="flex flex-1">
      <EmptyState
        icon={<Crown size={24} />}
        title={t('orchestrator.stoppedTitle')}
        description={t('orchestrator.stoppedDesc')}
        action={
          <button
            type="button"
            onClick={onStart}
            className="icon-btn icon-btn--primary"
            data-testid="orchestrator-start"
          >
            <Play size={12} aria-hidden /> {t('orchestrator.start')}
          </button>
        }
      />
    </div>
  )
}

const FailedBody = ({
  error,
  onRemoveWorkspace,
  onRestart,
}: {
  error: string
  onRemoveWorkspace: () => void
  onRestart: () => void
}) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copyError = () => {
    void navigator.clipboard
      ?.writeText(error)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div
      data-testid="orchestrator-failed-body"
      className="m-auto flex max-w-[480px] flex-col items-center gap-3 px-6 py-8"
    >
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded text-sec"
        style={{ background: 'var(--bg-2)', border: '1px solid var(--border-bright)' }}
      >
        <Crown size={24} />
      </div>
      <div className="text-lg font-semibold text-pri">{t('orchestrator.failed')}</div>
      <div className="relative w-full">
        <pre
          data-testid="orchestrator-error-message"
          className="mono w-full max-h-40 overflow-auto whitespace-pre-wrap break-all rounded p-3 text-left text-xs"
          style={{
            background: 'color-mix(in oklab, var(--status-red) 8%, var(--bg-2))',
            border: '1px solid color-mix(in oklab, var(--status-red) 24%, transparent)',
            color: 'var(--text-secondary)',
          }}
        >
          {error}
        </pre>
        <Tooltip label={copied ? t('common.copied') : t('common.copyError')}>
          <button
            type="button"
            onClick={copyError}
            aria-label={t('orchestrator.copyErrorAria')}
            className="icon-btn icon-btn--ghost absolute right-1 top-1 h-6 px-1.5"
            data-testid="orchestrator-copy-error"
          >
            <Copy size={12} aria-hidden />
          </button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRestart}
          className="icon-btn icon-btn--primary"
          data-testid="orchestrator-retry"
        >
          <RotateCcw size={12} aria-hidden /> {t('common.retry')}
        </button>
        <button
          type="button"
          onClick={onRemoveWorkspace}
          className="icon-btn icon-btn--danger"
          data-testid="orchestrator-remove-workspace"
        >
          {t('orchestrator.removeWorkspace')}
        </button>
      </div>
      {/* Header retry was a duplicate; alias kept for back-compat. */}
      <span data-testid="orchestrator-retry-header" className="sr-only">
        {t('common.retry')}
      </span>
    </div>
  )
}

export const OrchestratorPane = ({
  state,
  newSessionPending,
  onDeleteSession,
  onNewSession,
  onSwitchSession,
  sessions,
  sessionSwitchPending,
  onRemoveWorkspace,
  onRestart,
  onStart,
}: OrchestratorPaneProps) => {
  const { t } = useI18n()
  const [confirmNewSession, setConfirmNewSession] = useState(false)
  const [manageSessions, setManageSessions] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const activeSession = sessions.find((session) => session.active)
  return (
    <div
      className="relative flex h-full w-full min-w-0 flex-col"
      style={{
        background: 'var(--bg-crust)',
        borderRight: '1px solid var(--border)',
      }}
      data-testid="orchestrator-terminal-slot"
    >
      {state.kind !== 'starting' ? (
        <div
          className="absolute right-2 top-2 z-10 flex items-center gap-1"
          data-testid="orchestrator-session-actions"
        >
          <button
            aria-label={t('orchestrator.manageSessions')}
            className="icon-btn"
            data-testid="orchestrator-session-manager"
            disabled={sessionSwitchPending || newSessionPending}
            onClick={() => setManageSessions(true)}
            type="button"
          >
            <History size={12} aria-hidden /> {activeSession?.name ?? t('orchestrator.sessions')}
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="orchestrator-new-session"
            disabled={newSessionPending || sessionSwitchPending}
            onClick={() => setConfirmNewSession(true)}
          >
            {newSessionPending ? (
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
            ) : (
              <FilePlus2 size={12} aria-hidden />
            )}
            {t('orchestrator.newSession')}
          </button>
        </div>
      ) : null}
      {state.kind === 'running' ? (
        <div
          id={`orch-pty-${state.runId}`}
          className="flex h-full w-full"
          data-pty-slot="orchestrator"
        />
      ) : state.kind === 'failed' ? (
        <FailedBody
          error={state.error}
          onRemoveWorkspace={onRemoveWorkspace}
          onRestart={onRestart}
        />
      ) : state.kind === 'stopped' ? (
        <StoppedBody onStart={onStart} />
      ) : (
        <StartingBody />
      )}
      <Dialog.Root open={confirmNewSession} onOpenChange={setConfirmNewSession}>
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
            <Dialog.Content
              className="dialog-scale-pop elev-2 pointer-events-auto w-[440px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
              data-testid="new-session-dialog"
              style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
            >
              <Dialog.Title className="text-lg font-semibold text-pri">
                {t('orchestrator.newSessionConfirmTitle')}
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 whitespace-pre-line text-sm text-sec">
                {t('orchestrator.newSessionConfirmDescription')}
              </Dialog.Description>
              <label className="mt-4 block text-xs text-sec">
                {t('orchestrator.sessionName')}
                <input
                  className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm text-pri outline-none"
                  data-testid="new-session-name"
                  maxLength={120}
                  onChange={(event) => setSessionName(event.target.value)}
                  placeholder={t('orchestrator.sessionNamePlaceholder')}
                  value={sessionName}
                />
              </label>
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close className="icon-btn">{t('common.cancel')}</Dialog.Close>
                <button
                  className="icon-btn icon-btn--primary"
                  data-testid="new-session-submit"
                  onClick={() => {
                    onNewSession(sessionName.trim() || undefined)
                    setSessionName('')
                    setConfirmNewSession(false)
                  }}
                  type="button"
                >
                  {t('orchestrator.startNewSession')}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
      {manageSessions ? (
        <SessionManagerDialog
          onClose={() => setManageSessions(false)}
          onDelete={onDeleteSession}
          onSwitch={onSwitchSession}
          sessions={sessions}
        />
      ) : null}
    </div>
  )
}

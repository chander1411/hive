import * as Dialog from '@radix-ui/react-dialog'
import { Check, Search, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { WorkspaceSessionSummary } from '../api.js'
import { useI18n } from '../i18n.js'

interface SessionManagerDialogProps {
  onClose: () => void
  onDelete: (sessionId: string) => Promise<void>
  onSwitch: (sessionId: string) => void
  sessions: WorkspaceSessionSummary[]
}

export const SessionManagerDialog = ({
  onClose,
  onDelete,
  onSwitch,
  sessions,
}: SessionManagerDialogProps) => {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized
      ? sessions.filter((session) => session.name.toLocaleLowerCase().includes(normalized))
      : sessions
  }, [query, sessions])

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[75vh] w-[560px] max-w-[calc(100vw-32px)] flex-col rounded-lg border p-5"
            data-testid="session-manager-dialog"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-lg font-semibold text-pri">
                {t('orchestrator.manageSessions')}
              </Dialog.Title>
              <Dialog.Close className="icon-btn icon-btn--ghost" aria-label={t('common.close')}>
                <X size={14} aria-hidden />
              </Dialog.Close>
            </div>
            <Dialog.Description className="mt-1 text-sm text-sec">
              {t('orchestrator.manageSessionsDescription')}
            </Dialog.Description>
            <label className="mt-4 flex items-center gap-2 rounded border px-3 py-2">
              <Search size={14} className="text-ter" aria-hidden />
              <span className="sr-only">{t('orchestrator.searchSessions')}</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-sm text-pri outline-none"
                data-testid="session-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('orchestrator.searchSessions')}
                value={query}
              />
            </label>
            {error ? <div className="mt-3 text-xs text-red-400">{error}</div> : null}
            <div className="mt-3 min-h-0 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-sm text-ter">
                  {t('orchestrator.noSessionsFound')}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {filtered.map((session) => (
                    <div
                      className="flex items-center gap-3 rounded border px-3 py-2"
                      data-testid={`session-row-${session.id}`}
                      key={session.id}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        disabled={session.active}
                        onClick={() => {
                          onSwitch(session.id)
                          onClose()
                        }}
                        type="button"
                      >
                        <span className="flex items-center gap-2 text-sm text-pri">
                          {session.name}
                          {session.active ? (
                            <Check size={13} aria-label={t('orchestrator.activeSession')} />
                          ) : null}
                        </span>
                        <span className="text-xs text-ter">
                          {new Date(session.createdAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        aria-label={t('orchestrator.deleteSession', { name: session.name })}
                        className="icon-btn icon-btn--danger"
                        data-testid={`delete-session-${session.id}`}
                        disabled={session.active || deletingId !== null}
                        onClick={() => {
                          if (
                            !window.confirm(
                              t('orchestrator.deleteSessionConfirm', { name: session.name })
                            )
                          )
                            return
                          setError(null)
                          setDeletingId(session.id)
                          void onDelete(session.id)
                            .catch((reason: unknown) => {
                              setError(reason instanceof Error ? reason.message : String(reason))
                            })
                            .finally(() => setDeletingId(null))
                        }}
                        title={
                          session.active ? t('orchestrator.activeSessionDeleteHelp') : undefined
                        }
                        type="button"
                      >
                        <Trash2 size={13} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

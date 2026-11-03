import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { createDispatchLedgerStore } from '../../src/server/dispatch-ledger-store.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const createStore = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, store: createDispatchLedgerStore(db) }
}

describe('dispatch id prefix lookup', () => {
  test('accepts an unambiguous dispatch id prefix for reports and cancels', () => {
    const { db, store } = createStore()
    const dispatch = store.createDispatch({
      text: 'Implement login',
      toAgentId: 'worker-1',
      workspaceId: 'ws-1',
    })
    const prefix = dispatch.id.slice(0, 8)

    expect(store.findOpenDispatch('ws-1', 'worker-1', prefix)?.id).toBe(dispatch.id)
    expect(store.findOpenDispatchById('ws-1', prefix)?.id).toBe(dispatch.id)
    expect(store.findOpenDispatch('ws-1', 'worker-1', dispatch.id)?.id).toBe(dispatch.id)
    expect(store.findOpenDispatch('ws-1', 'worker-1', 'not-a-prefix')).toBeUndefined()
    expect(store.findOpenDispatch('ws-1', 'worker-1', dispatch.id.slice(0, 4))).toBeUndefined()
    db.close()
  })

  test('rejects an ambiguous prefix instead of closing the wrong dispatch', () => {
    const { db, store } = createStore()
    const insert = db.prepare(
      `INSERT INTO dispatches (
        id, workspace_id, from_agent_id, to_agent_id, text, status,
        created_at, delivered_at, submitted_at, reported_at, report_text, artifacts
      ) VALUES (?, ?, NULL, ?, ?, 'submitted', ?, NULL, ?, NULL, NULL, '[]')`
    )
    insert.run('aaaaaaaa-1111-4111-8111-111111111111', 'ws-1', 'worker-1', 'first', 1, 1)
    insert.run('aaaaaaaa-2222-4222-8222-222222222222', 'ws-1', 'worker-1', 'second', 2, 2)

    expect(store.findOpenDispatch('ws-1', 'worker-1', 'aaaaaaaa')).toBeUndefined()
    expect(store.findOpenDispatchById('ws-1', 'aaaaaaaa')).toBeUndefined()
    expect(store.findOpenDispatch('ws-1', 'worker-1', 'aaaaaaaa-1111')?.text).toBe('first')
    db.close()
  })

  test('does not match a prefix after the dispatch is reported', () => {
    const { db, store } = createStore()
    const dispatch = store.createDispatch({
      text: 'done',
      toAgentId: 'worker-1',
      workspaceId: 'ws-1',
    })
    store.markReportedByWorker({
      artifacts: [],
      dispatchId: dispatch.id,
      reportText: 'done',
      toAgentId: 'worker-1',
      workspaceId: 'ws-1',
    })

    expect(store.findOpenDispatch('ws-1', 'worker-1', dispatch.id.slice(0, 8))).toBeUndefined()
    db.close()
  })
})

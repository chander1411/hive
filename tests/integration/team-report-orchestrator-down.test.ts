import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

const tempDirs: string[] = []
const servers: Array<Awaited<ReturnType<typeof startTestServer>>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitFor = async (assertion: () => void, timeoutMs = 4000, intervalMs = 25) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

const writeFakeAgent = (workspacePath: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliPath = join(binDir, 'claude')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
process.stdout.write('❯ ')
process.stdin.resume()
setInterval(() => {}, 1000)
`
  )
  chmodSync(cliPath, 0o755)
  return cliPath
}

describe('team report with the orchestrator down', () => {
  test('closes the dispatch and returns the worker to idle instead of rejecting the report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-report-orchestrator-down-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    const orchestratorId = `${workspace.id}:orchestrator`
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: writeFakeAgent(workspacePath),
      interactiveCommand: 'claude',
    })

    const dispatch = await server.store.dispatchTask(workspace.id, worker.id, 'do the work', {
      fromAgentId: orchestratorId,
      hivePort: '4010',
    })
    await waitFor(() => {
      expect(server.store.listWorkers(workspace.id)[0]?.status).toBe('working')
    })
    expect(server.store.getActiveRunByAgentId(workspace.id, orchestratorId)).toBeUndefined()

    const result = server.store.reportTask(workspace.id, worker.id, {
      requireActiveRun: true,
      text: 'done with the work',
    })

    expect(result.dispatch?.status).toBe('reported')
    expect(result.forwarded).toBe(false)
    expect(server.store.listDispatches(workspace.id)).toContainEqual(
      expect.objectContaining({ id: dispatch.id, status: 'reported' })
    )
    expect(server.store.listWorkers(workspace.id)[0]?.status).toBe('idle')
  })
})

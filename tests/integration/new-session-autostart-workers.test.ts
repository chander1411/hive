import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { getOrchestratorId } from '../../src/server/workspace-store-support.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

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

const writeFakeAgent = (binDir: string, logDir: string) => {
  mkdirSync(binDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  const cliPath = join(binDir, 'claude')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const logPath = join(${JSON.stringify(logDir)}, (process.env.HIVE_AGENT_ID ?? 'unknown') + '.log')
process.stdout.write('❯ ')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  appendFileSync(logPath, chunk)
})
setInterval(() => {}, 1000)
`
  )
  chmodSync(cliPath, 0o755)
  return cliPath
}

describe('new session worker autostart', () => {
  test('starts all configured workers and delivers each role prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-autostart-workers-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const fakeAgent = writeFakeAgent(join(root, 'bin'), join(root, 'logs'))

    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    server.store.configureAgentLaunch(workspace.id, getOrchestratorId(workspace.id), {
      command: fakeAgent,
      interactiveCommand: 'claude',
    })

    const descriptions = new Map<string, string>()
    const workers = ['Alice', 'Bob', 'Cara'].map((name) => {
      const description = `You are ${name}, a Specialist autostart role prompt.`
      descriptions.set(name, description)
      const worker = server.store.addWorker(workspace.id, {
        description,
        name,
        role: 'coder',
      })
      server.store.configureAgentLaunch(workspace.id, worker.id, {
        command: fakeAgent,
        interactiveCommand: 'claude',
      })
      return worker
    })

    const noConfig = server.store.addWorker(workspace.id, { name: 'NoConfig', role: 'tester' })
    const broken = server.store.addWorker(workspace.id, { name: 'Broken', role: 'reviewer' })
    server.store.configureAgentLaunch(workspace.id, broken.id, {
      command: join(root, 'missing-agent-binary'),
      interactiveCommand: 'claude',
    })

    const result = await server.store.startNewSession(workspace.id, { hivePort: '4010' })

    expect(result.workerStarts).toHaveLength(4)
    expect(result.workerStarts.filter((worker) => worker.ok)).toHaveLength(3)
    expect(result.workerStarts.find((worker) => worker.agentId === broken.id)?.ok).toBe(false)
    expect(result.workerStarts.some((worker) => worker.agentId === noConfig.id)).toBe(false)

    for (const worker of workers) {
      expect(
        server.store.getActiveRunByAgentId(workspace.id, worker.id, result.session.id)
      ).toBeDefined()
      const description = descriptions.get(worker.name) as string
      await waitFor(() => {
        expect(readFileSync(join(root, 'logs', `${worker.id}.log`), 'utf8')).toContain(description)
      })
    }
    expect(server.store.getActiveRunByAgentId(workspace.id, noConfig.id, result.session.id)).toBe(
      undefined
    )
  }, 15_000)

  test('defaults to autostarting workers and can be disabled per request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-autostart-route-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    mkdirSync(workspacePath, { recursive: true })
    const fakeAgent = writeFakeAgent(join(root, 'bin'), join(root, 'logs'))

    const server = await startTestServer()
    servers.push(server)
    const cookie = await getUiCookie(server.baseUrl)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    server.store.configureAgentLaunch(workspace.id, getOrchestratorId(workspace.id), {
      command: fakeAgent,
      interactiveCommand: 'claude',
    })
    const worker = server.store.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: fakeAgent,
      interactiveCommand: 'claude',
    })

    const defaultResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/new-session`,
      {
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(defaultResponse.status).toBe(201)
    const defaultBody = (await defaultResponse.json()) as {
      session: { id: string }
      worker_starts: Array<{ agent_id: string; ok: boolean; run_id: string | null }>
    }
    expect(defaultBody.worker_starts).toHaveLength(1)
    expect(defaultBody.worker_starts[0]).toMatchObject({ agent_id: worker.id, ok: true })
    expect(
      server.store.getActiveRunByAgentId(workspace.id, worker.id, defaultBody.session.id)
    ).toBeDefined()

    const disabledResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/new-session`,
      {
        body: JSON.stringify({ autostart_workers: false }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'POST',
      }
    )
    expect(disabledResponse.status).toBe(201)
    const disabledBody = (await disabledResponse.json()) as {
      session: { id: string }
      worker_starts: unknown[]
    }
    expect(disabledBody.worker_starts).toEqual([])
    expect(
      server.store.getActiveRunByAgentId(workspace.id, worker.id, disabledBody.session.id)
    ).toBeUndefined()
  }, 15_000)
})

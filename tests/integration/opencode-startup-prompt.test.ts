import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const waitFor = async (assertion: () => void, timeoutMs = 8000, intervalMs = 25) => {
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

const writeFakeOpenCode = (root: string, stdinLog: string, readyDelayMs: number) => {
  const cliPath = join(root, 'opencode')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

process.stdout.write('OpenCode is starting\\n')
let ready = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (ready) appendFileSync(${JSON.stringify(stdinLog)}, chunk)
})
setTimeout(() => {
  ready = true
  process.stdout.write('\\nAsk anything… "Fix a TODO in the codebase"\\n')
}, ${readyDelayMs})
setInterval(() => {}, 1000)
`
  )
  chmodSync(cliPath, 0o755)
  return cliPath
}

describe('OpenCode startup prompt', () => {
  test('waits for the TUI prompt instead of dropping startup instructions on a slow boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-opencode-startup-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    const stdinLog = join(root, 'stdin.log')
    mkdirSync(workspacePath, { recursive: true })
    const fakeOpenCode = writeFakeOpenCode(root, stdinLog, 4000)

    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    const worker = server.store.addWorker(workspace.id, {
      description: 'You are a Specialist OpenCode startup prompt worker.',
      name: 'Alice',
      role: 'coder',
    })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: fakeOpenCode,
      interactiveCommand: 'opencode',
    })

    await server.store.startAgent(workspace.id, worker.id, { hivePort: '4010' })

    await waitFor(() => {
      expect(readFileSync(stdinLog, 'utf8')).toContain('Specialist OpenCode startup prompt worker')
    }, 10_000)
  }, 15_000)

  test('re-sends the role prompt when restarting a worker in the same session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-opencode-restart-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    const stdinLog = join(root, 'stdin.log')
    mkdirSync(workspacePath, { recursive: true })
    const fakeOpenCode = writeFakeOpenCode(root, stdinLog, 0)

    const server = await startTestServer()
    servers.push(server)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    const worker = server.store.addWorker(workspace.id, {
      description: 'You are a Specialist OpenCode restart prompt worker.',
      name: 'Alice',
      role: 'reviewer',
    })
    server.store.configureAgentLaunch(workspace.id, worker.id, {
      command: fakeOpenCode,
      interactiveCommand: 'opencode',
    })

    const firstRun = await server.store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(readFileSync(stdinLog, 'utf8')).toContain('Specialist OpenCode restart prompt worker')
    })

    server.store.stopAgentRun(firstRun.runId)
    await waitFor(() => {
      expect(server.store.getLiveRun(firstRun.runId).status).toBe('exited')
    })
    writeFileSync(stdinLog, '')

    await server.store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      expect(readFileSync(stdinLog, 'utf8')).toContain('Specialist OpenCode restart prompt worker')
    })
  })
})

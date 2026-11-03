import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { getOrchestratorId } from '../../src/server/workspace-store-support.js'
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

const writeFakeClaude = (workspacePath: string, stdinLog: string, launchLog: string) => {
  const binDir = join(workspacePath, 'bin')
  mkdirSync(binDir, { recursive: true })
  const cliPath = join(binDir, 'claude')
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

appendFileSync(${JSON.stringify(
      launchLog
    )}, JSON.stringify({ agent: process.env.HIVE_AGENT_ID, session: process.env.HIVE_SESSION_ID }) + '\\n')
process.stdout.write('❯ ')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  appendFileSync(${JSON.stringify(stdinLog)}, chunk)
})
setInterval(() => {}, 1000)
`
  )
  chmodSync(cliPath, 0o755)
  return cliPath
}

describe('new session worker startup', () => {
  test('starts a configured worker with its role prompt instead of restart recovery after a runtime restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-new-session-worker-startup-'))
    tempDirs.push(root)
    const dataDir = join(root, 'data')
    const workspacePath = join(root, 'workspace')
    const stdinLog = join(root, 'worker-stdin.log')
    const launchLog = join(root, 'launches.log')
    mkdirSync(workspacePath, { recursive: true })
    const fakeClaude = writeFakeClaude(workspacePath, stdinLog, launchLog)

    const firstServer = await startTestServer({ dataDir })
    servers.push(firstServer)
    const workspace = firstServer.store.createWorkspace(workspacePath, 'Alpha')
    const worker = firstServer.store.addWorker(workspace.id, {
      description: 'You are a Specialist reviewer for Hive startup tests.',
      name: 'Alice',
      role: 'reviewer',
    })
    firstServer.store.configureAgentLaunch(workspace.id, getOrchestratorId(workspace.id), {
      command: fakeClaude,
      interactiveCommand: 'claude',
    })
    firstServer.store.configureAgentLaunch(workspace.id, worker.id, {
      command: fakeClaude,
      interactiveCommand: 'claude',
    })

    const firstRun = await firstServer.store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
    })
    await waitFor(() => {
      expect(readFileSync(stdinLog, 'utf8')).toContain('Specialist reviewer for Hive startup tests')
    })
    firstServer.store.stopAgentRun(firstRun.runId)
    await firstServer.close()
    servers.splice(servers.indexOf(firstServer), 1)

    const newSessionServer = await startTestServer({ dataDir })
    servers.push(newSessionServer)
    await newSessionServer.store.startNewSession(workspace.id, {
      autostartWorkers: false,
      hivePort: '4010',
    })
    await newSessionServer.close()
    servers.splice(servers.indexOf(newSessionServer), 1)

    writeFileSync(stdinLog, '')

    const restartedServer = await startTestServer({ dataDir })
    servers.push(restartedServer)
    await restartedServer.store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    await waitFor(() => {
      const startup = readFileSync(stdinLog, 'utf8')
      expect(startup).toContain('Specialist reviewer for Hive startup tests')
      expect(startup).not.toContain('restarted you')
      expect(startup).not.toContain('reiniciarte')
    })
  }, 20_000)
})

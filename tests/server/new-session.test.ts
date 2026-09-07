import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'

import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { toSessionScopeId } from '../../src/server/session-scope.js'
import { getSessionTasksRelativePath } from '../../src/server/tasks-file.js'
import { getOrchestratorId } from '../../src/server/workspace-store-support.js'
import { startTestServer } from '../helpers/test-server.js'
import { getUiCookie } from '../helpers/ui-session.js'

const cleanup: Array<() => Promise<void>> = []
const tempDirs: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

const waitForLines = async (path: string, count: number) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const lines = readFileSync(path, 'utf8').trim().split('\n')
      if (lines.length >= count) return lines.map((line) => JSON.parse(line) as string[])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${count} launch records`)
}

const waitFor = async (assertion: () => void, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

describe('POST /api/workspaces/:workspaceId/new-session', () => {
  test.each([
    '--continue',
    '--resume',
  ])('removes an explicit %s from a shell-wrapped orchestrator command', async (resumeFlag) => {
    const root = mkdtempSync(join(tmpdir(), 'hive-new-session-continue-'))
    tempDirs.push(root)
    const launchLog = join(root, 'launches.jsonl')
    const agentScript = join(root, 'agent.mjs')
    writeFileSync(
      agentScript,
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(
        launchLog
      )}, JSON.stringify(process.argv.slice(2)) + '\\n')\nsetInterval(() => {}, 1000)\n`
    )
    chmodSync(agentScript, 0o755)

    const server = await startTestServer()
    cleanup.push(server.close)
    const workspace = server.store.createWorkspace(join(root, 'workspace'), 'Alpha')
    server.store.configureAgentLaunch(workspace.id, getOrchestratorId(workspace.id), {
      args: ['-lic', `${JSON.stringify(agentScript)} ${resumeFlag}`],
      command: process.env.SHELL ?? '/bin/sh',
      interactiveCommand: 'claude',
      presetAugmentationDisabled: true,
    })

    const cookie = await getUiCookie(server.baseUrl)
    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/new-session`, {
      headers: { cookie },
      method: 'POST',
    })
    expect(response.status).toBe(201)
    expect(await waitForLines(launchLog, 1)).toEqual([['--setting-sources', 'project,local']])
  })

  test('starts fresh sessions, archives tasks, and preserves members and configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-new-session-'))
    const dataDir = join(root, 'data')
    const workspacePath = join(root, 'workspace')
    const launchLog = join(root, 'launches.jsonl')
    const bootstrapLog = join(root, 'bootstrap.txt')
    tempDirs.push(root)
    const agentScript = join(root, 'agent.mjs')
    writeFileSync(
      agentScript,
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(
        launchLog
      )}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdin.on('data', chunk => appendFileSync(${JSON.stringify(
        bootstrapLog
      )}, chunk))\nsetInterval(() => {}, 1000)\n`
    )
    chmodSync(agentScript, 0o755)

    const seedStore = createRuntimeStore({ dataDir })
    const workspace = seedStore.createWorkspace(workspacePath, 'Alpha')
    const orchestratorId = getOrchestratorId(workspace.id)
    const worker = seedStore.addWorker(workspace.id, { name: 'Alice', role: 'coder' })
    seedStore.configureAgentLaunch(workspace.id, orchestratorId, {
      command: agentScript,
      interactiveCommand: 'claude',
      resumeArgsTemplate: '--resume {session_id}',
      sessionIdCapture: { source: 'codex_session_jsonl_dir', pattern: '/missing' },
    })
    seedStore.configureAgentLaunch(workspace.id, worker.id, {
      command: agentScript,
      resumeArgsTemplate: '--session {session_id}',
      sessionIdCapture: { source: 'codex_session_jsonl_dir', pattern: '/missing' },
    })
    await seedStore.close()

    const db = new Database(join(dataDir, 'runtime.sqlite'))
    const insertSession = db.prepare(
      'INSERT INTO agent_sessions (agent_id, workspace_id, last_session_id, updated_at) VALUES (?, ?, ?, ?)'
    )
    insertSession.run(orchestratorId, workspace.id, 'claude-old', 1)
    insertSession.run(worker.id, workspace.id, 'opencode-old', 1)
    db.prepare('UPDATE workers SET last_session_id = ? WHERE id = ?').run('opencode-old', worker.id)
    db.close()

    writeFileSync(join(workspacePath, '.hive', 'tasks.md'), '- [ ] old task\n')
    const teamMemoryPath = join(workspacePath, '.hive', 'team-memory.md')
    writeFileSync(teamMemoryPath, 'Keep pnpm conventions\n')

    const server = await startTestServer({ dataDir })
    cleanup.push(server.close)
    const cookie = await getUiCookie(server.baseUrl)
    const originalConfig = server.store.peekAgentLaunchConfig(workspace.id, orchestratorId)
    const originalWorkerConfig = server.store.peekAgentLaunchConfig(workspace.id, worker.id)
    const initialSessionsResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/sessions`,
      { headers: { cookie } }
    )
    expect(initialSessionsResponse.status).toBe(200)
    const initialSessions = (await initialSessionsResponse.json()) as Array<{
      active: boolean
      id: string
      name: string
    }>
    expect(initialSessions).toHaveLength(1)
    expect(initialSessions[0]).toMatchObject({ active: true, name: 'Session 1' })
    const firstSessionId = initialSessions[0]?.id
    expect(firstSessionId).toBeDefined()
    writeFileSync(
      join(workspacePath, getSessionTasksRelativePath(firstSessionId as string)),
      '- [ ] old task\n'
    )
    const initialOrchestratorRun = await server.store.startAgent(workspace.id, orchestratorId, {
      hivePort: '4010',
    })
    const initialWorkerRun = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
    })
    const resumedLaunches = await waitForLines(launchLog, 2)
    expect(resumedLaunches).toContainEqual(['--resume', 'claude-old'])
    expect(resumedLaunches).toContainEqual(['--session', 'opencode-old'])
    const migratedSessionsDb = new Database(join(dataDir, 'runtime.sqlite'))
    expect(
      migratedSessionsDb
        .prepare(
          'SELECT last_session_id FROM agent_sessions WHERE workspace_id = ? AND agent_id = ?'
        )
        .get(toSessionScopeId(workspace.id, firstSessionId), orchestratorId)
    ).toEqual({ last_session_id: 'claude-old' })
    migratedSessionsDb.close()
    await server.store.dispatchTask(workspace.id, worker.id, 'old delegated work')

    const response = await fetch(`${server.baseUrl}/api/workspaces/${workspace.id}/new-session`, {
      body: JSON.stringify({ name: 'Planning' }),
      headers: { cookie, 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      archived_tasks_path: string
      run_id: string
      session: { active: boolean; id: string; name: string }
    }
    expect(body.archived_tasks_path).toMatch(/^\.hive\/history\/tasks-.+\.md$/)
    expect(body.session).toMatchObject({ active: true, name: 'Planning' })

    const launches = await waitForLines(launchLog, 3)
    expect(launches[2]).not.toContain('--resume')
    expect(launches[2]).not.toContain('claude-old')
    await waitFor(() => {
      const bootstrap = readFileSync(bootstrapLog, 'utf8')
      expect(bootstrap).toContain('新会话边界')
      expect(bootstrap).toContain('只回复“已就绪。”')
    })
    expect(server.store.getLiveRun(initialOrchestratorRun.runId).status).not.toBe('exited')
    expect(server.store.getLiveRun(initialWorkerRun.runId).status).not.toBe('exited')
    expect(server.store.listWorkers(workspace.id)).toEqual([
      {
        id: worker.id,
        name: 'Alice',
        pendingTaskCount: 0,
        role: 'coder',
        status: 'stopped',
      },
    ])
    expect(server.store.peekAgentLaunchConfig(workspace.id, orchestratorId)).toEqual(originalConfig)
    expect(server.store.peekAgentLaunchConfig(workspace.id, worker.id)).toEqual(
      originalWorkerConfig
    )
    expect(server.store.listDispatches(workspace.id)).toEqual([])
    expect(server.store.settings.getCommandPreset('claude')).toBeDefined()
    expect(readFileSync(join(workspacePath, '.hive', 'tasks.md'), 'utf8')).toBe('')
    expect(readFileSync(join(workspacePath, body.archived_tasks_path), 'utf8')).toBe(
      '- [ ] old task\n'
    )
    expect(readFileSync(teamMemoryPath, 'utf8')).toBe('Keep pnpm conventions\n')

    const verificationDb = new Database(join(dataDir, 'runtime.sqlite'))
    verificationDb.close()

    await server.store.startAgent(workspace.id, worker.id, { hivePort: '4010' })
    const freshLaunches = await waitForLines(launchLog, 4)
    expect(freshLaunches[3]).not.toContain('--session')
    expect(freshLaunches[3]).not.toContain('opencode-old')
    writeFileSync(
      join(workspacePath, getSessionTasksRelativePath(body.session.id)),
      '- [ ] session 2 task\n'
    )

    const switchResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/sessions/${firstSessionId}/activate`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(switchResponse.status).toBe(200)
    const switched = (await switchResponse.json()) as { run_id: string }
    expect(switched.run_id).toBe(initialOrchestratorRun.runId)
    expect(readFileSync(join(workspacePath, '.hive', 'tasks.md'), 'utf8')).toBe('- [ ] old task\n')
    expect(server.store.listDispatches(workspace.id)).toEqual([
      expect.objectContaining({ status: 'queued', text: 'old delegated work' }),
    ])
    expect(server.store.listWorkers(workspace.id)[0]).toMatchObject({
      id: worker.id,
      pendingTaskCount: 1,
      status: 'working',
    })

    const restoredWorkerRun = await server.store.startAgent(workspace.id, worker.id, {
      hivePort: '4010',
    })
    expect(restoredWorkerRun.runId).toBe(initialWorkerRun.runId)

    const switchBackResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/sessions/${body.session.id}/activate`,
      { headers: { cookie }, method: 'POST' }
    )
    expect(switchBackResponse.status).toBe(200)
    const switchedBack = (await switchBackResponse.json()) as { run_id: string }
    expect(switchedBack.run_id).toBe(body.run_id)
    expect(readFileSync(join(workspacePath, '.hive', 'tasks.md'), 'utf8')).toBe(
      '- [ ] session 2 task\n'
    )
    expect(server.store.listDispatches(workspace.id)).toEqual([])

    const sessionsResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/sessions`,
      {
        headers: { cookie },
      }
    )
    const sessions = (await sessionsResponse.json()) as Array<{
      active: boolean
      id: string
      name: string
      running: boolean
    }>
    expect(sessions).toHaveLength(2)
    expect(sessions.find((session) => session.id === body.session.id)?.active).toBe(true)
    expect(sessions.every((session) => session.running)).toBe(true)

    const deleteArchivedResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/sessions/${firstSessionId}`,
      { headers: { cookie }, method: 'DELETE' }
    )
    expect(deleteArchivedResponse.status).toBe(204)
    expect(server.store.listWorkspaceSessions(workspace.id)).toHaveLength(1)
    expect(
      existsSync(join(workspacePath, getSessionTasksRelativePath(firstSessionId as string)))
    ).toBe(false)

    const deleteActiveResponse = await fetch(
      `${server.baseUrl}/api/workspaces/${workspace.id}/sessions/${body.session.id}`,
      { headers: { cookie }, method: 'DELETE' }
    )
    expect(deleteActiveResponse.status).toBe(409)
  }, 15_000)

  test('rejects an overlapping operation so only one replacement orchestrator starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-new-session-lock-'))
    tempDirs.push(root)
    const workspacePath = join(root, 'workspace')
    const script = join(root, 'agent.mjs')
    writeFileSync(
      script,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => setTimeout(() => process.exit(0), 250))\nconsole.log('ready')\nsetInterval(() => {}, 1000)\n"
    )
    chmodSync(script, 0o755)
    const server = await startTestServer()
    cleanup.push(server.close)
    const workspace = server.store.createWorkspace(workspacePath, 'Alpha')
    const orchestratorId = getOrchestratorId(workspace.id)
    server.store.configureAgentLaunch(workspace.id, orchestratorId, { command: script })
    await server.store.startAgent(workspace.id, orchestratorId, {
      hivePort: '4010',
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    const firstOperation = server.store.startNewSession(workspace.id, { hivePort: '4010' })
    expect(() => server.store.startNewSession(workspace.id, { hivePort: '4010' })).toThrow(
      'A session operation is already running for this workspace'
    )
    await firstOperation
    expect(server.store.listTerminalRuns(workspace.id)).toHaveLength(1)
  })
})

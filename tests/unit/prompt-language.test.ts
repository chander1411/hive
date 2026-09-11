import { describe, expect, test } from 'vitest'

import { buildAgentStartupInstructions } from '../../src/server/agent-startup-instructions.js'
import { buildRecoverySummary } from '../../src/server/recovery-summary.js'
import { CODER_ROLE_DESCRIPTION } from '../../src/server/role-templates.js'

const workspace = { id: 'ws-1', name: 'Alpha', path: '/tmp/alpha' }
const orchestrator = {
  id: 'ws-1:orchestrator',
  workspaceId: 'ws-1',
  name: 'Orchestrator',
  description: 'legacy description',
  role: 'orchestrator' as const,
  status: 'idle' as const,
  pendingTaskCount: 0,
}
const coder = {
  id: 'worker-1',
  workspaceId: 'ws-1',
  name: 'Alicia',
  description: CODER_ROLE_DESCRIPTION,
  role: 'coder' as const,
  status: 'idle' as const,
  pendingTaskCount: 0,
}

describe('runtime prompt language', () => {
  test('builds English startup instructions without leaking built-in Chinese descriptions', () => {
    const prompt = buildAgentStartupInstructions({ agent: coder, workspace, language: 'en' })
    const orchestratorPrompt = buildAgentStartupInstructions({
      agent: orchestrator,
      workspace,
      language: 'en',
      newSession: true,
    })
    const restoredPrompt = buildAgentStartupInstructions({
      agent: orchestrator,
      workspace,
      language: 'en',
    })

    expect(prompt).toContain('[Hive system message: startup instructions]')
    expect(prompt).toContain('Your role: You are a Coder.')
    expect(orchestratorPrompt).toContain('Project memory is reference material')
    expect(orchestratorPrompt).toContain('Reply only `Ready.`')
    expect(orchestratorPrompt).toContain("wait for the user's first request")
    expect(restoredPrompt).not.toContain('New session boundary:')
    expect(restoredPrompt).not.toContain('Reply only `Ready.`')
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u)
  })

  test('builds Spanish startup and recovery prompts', () => {
    const startup = buildAgentStartupInstructions({
      agent: orchestrator,
      workspace,
      language: 'es',
      newSession: true,
    })
    const recovery = buildRecoverySummary({
      agent: orchestrator,
      messages: [],
      tasksContent: '',
      workers: [coder],
      workspace,
      language: 'es',
    })

    expect(startup).toContain('[Mensaje del sistema Hive: instrucciones de inicio]')
    expect(startup).toContain('La memoria del proyecto es material de referencia')
    expect(startup).toContain('Responde solamente `Listo.`')
    expect(startup).toContain('espera la primera solicitud del usuario')
    expect(startup).toContain('Tus responsabilidades:')
    expect(recovery).toContain('[Mensaje del sistema Hive:')
    expect(recovery).toContain('## Tareas pendientes')
    expect(`${startup}\n${recovery}`).not.toMatch(/[\u3400-\u9fff]/u)
  })

  test.each([
    ['en', 'Do not inspect the project', 'Do not run `team report` or `team status`'],
    ['es', 'No inspecciones el proyecto', 'No ejecutes `team report` ni `team status`'],
    ['zh', '启动时不要检查项目', '启动时不要执行 `team report` 或 `team status`'],
  ] as const)('keeps a fresh %s worker idle until an explicit dispatch', (language, first, second) => {
    const prompt = buildAgentStartupInstructions({
      agent: coder,
      workspace,
      language,
      newSession: true,
      sessionId: 'session-new',
    })

    expect(prompt).toContain(first)
    expect(prompt).toContain(second)
    expect(prompt).toContain('session_id=session-new')
  })

  test('does not apply the new-session worker boundary when restoring an existing session', () => {
    const prompt = buildAgentStartupInstructions({
      agent: coder,
      workspace,
      language: 'es',
      sessionId: 'session-existing',
    })

    expect(prompt).not.toContain('Límite de la sesión nueva:')
    expect(prompt).not.toContain('No inspecciones el proyecto')
  })
})

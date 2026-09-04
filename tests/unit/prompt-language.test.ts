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

    expect(prompt).toContain('[Hive system message: startup instructions]')
    expect(prompt).toContain('Your role: You are a Coder.')
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u)
  })

  test('builds Spanish startup and recovery prompts', () => {
    const startup = buildAgentStartupInstructions({
      agent: orchestrator,
      workspace,
      language: 'es',
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
    expect(startup).toContain('Tus responsabilidades:')
    expect(recovery).toContain('[Mensaje del sistema Hive:')
    expect(recovery).toContain('## Tareas pendientes')
    expect(`${startup}\n${recovery}`).not.toMatch(/[\u3400-\u9fff]/u)
  })
})

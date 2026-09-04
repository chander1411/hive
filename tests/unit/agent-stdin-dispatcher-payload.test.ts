import { describe, expect, test } from 'vitest'

import {
  buildOrchestratorReportPayload,
  buildOrchestratorStatusPayload,
  buildOrchestratorUserInputPayload,
  buildWorkerDispatchPayload,
} from '../../src/server/agent-stdin-dispatcher.js'
import {
  buildLocalizedWorkerReminderTail,
  getOrchestratorReminderTail,
} from '../../src/server/hive-team-guidance.js'

const lineIndexOf = (payload: string, needle: string): number =>
  payload.split('\n').findIndex((line) => line === needle || line.includes(needle))

describe('buildOrchestratorReportPayload', () => {
  test('starts with the report header and includes the body verbatim', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'fix shipped', [])
    expect(payload.split('\n')[0]).toBe('[Hive 系统消息：来自 @coder-1 的汇报]')
    expect(payload).toContain('fix shipped')
  })

  test('renders every artifact path on its own `artifact: <path>` line', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'done', ['a.md', 'b.png'])
    const lines = payload.split('\n')
    expect(lines).toContain('artifact: a.md')
    expect(lines).toContain('artifact: b.png')
  })

  test('places the orchestrator reminder AFTER the body, not before — recency anchoring depends on tail position', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'fix shipped', ['a.md'])
    const bodyIdx = lineIndexOf(payload, 'fix shipped')
    const artifactIdx = lineIndexOf(payload, 'artifact: a.md')
    const reminderIdx = lineIndexOf(payload, '<hive-system-reminder>')
    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    expect(reminderIdx).toBeGreaterThan(bodyIdx)
    expect(reminderIdx).toBeGreaterThan(artifactIdx)
  })

  test('contains the full localized orchestrator reminder block verbatim', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'done', [])
    expect(payload).toContain(getOrchestratorReminderTail('zh'))
  })

  test('ends with a trailing newline so xterm/bracketed-paste submits the message', () => {
    const payload = buildOrchestratorReportPayload('coder-1', 'done', [])
    expect(payload.endsWith('\n')).toBe(true)
  })
})

describe('buildOrchestratorStatusPayload', () => {
  test('starts with the status header (distinct from the report header) and trails with the same reminder', () => {
    const payload = buildOrchestratorStatusPayload('coder-1', 'waiting on tests', [])
    expect(payload.split('\n')[0]).toBe('[Hive 系统消息：来自 @coder-1 的状态更新]')
    expect(payload).toContain(getOrchestratorReminderTail('zh'))
    // Reminder is at tail, not at head.
    const reminderIdx = lineIndexOf(payload, '<hive-system-reminder>')
    const bodyIdx = lineIndexOf(payload, 'waiting on tests')
    expect(reminderIdx).toBeGreaterThan(bodyIdx)
  })
})

describe('buildOrchestratorUserInputPayload', () => {
  test('puts the user text first, the reminder last', () => {
    const payload = buildOrchestratorUserInputPayload('please draft the migration')
    const lines = payload.split('\n')
    expect(lines[0]).toBe('please draft the migration')
    const reminderIdx = lineIndexOf(payload, '<hive-system-reminder>')
    expect(reminderIdx).toBeGreaterThan(0)
  })

  test('preserves multi-line user input as-is before the reminder', () => {
    const payload = buildOrchestratorUserInputPayload('line one\nline two')
    expect(payload.startsWith('line one\nline two\n')).toBe(true)
    expect(payload).toContain(getOrchestratorReminderTail('zh'))
  })
})

describe('buildWorkerDispatchPayload', () => {
  test('localizes the complete dispatch envelope and built-in role description to Spanish', () => {
    const payload = buildWorkerDispatchPayload(
      'Orchestrator',
      '你是实现型 Coder，负责把明确任务落成最小正确代码改动。\n工作方式：\n- 先阅读相关文件和现有模式，再动手。\n- 优先小步修改，避免无关重构和范围扩张。\n- 改动后运行能覆盖风险的验证命令；不能验证时说明原因。\n交付说明要包含：改动文件、验证结果、剩余风险或阻塞。',
      'disp-es',
      'corrige el inicio de sesión',
      'es'
    )

    expect(payload).toContain('[Mensaje del sistema Hive: tarea de @Orchestrator]')
    expect(payload).toContain('Tu rol: Eres un programador.')
    expect(payload).toContain('Debes cumplir:')
    expect(payload).not.toMatch(/[\u3400-\u9fff]/u)
  })

  test('keeps the existing dispatch header, role, obligation prose, and task body intact', () => {
    const payload = buildWorkerDispatchPayload(
      'orchestrator-1',
      'Coder — implements features',
      'disp-42',
      'add error handling to login.ts'
    )
    expect(payload).toContain('[Hive 系统消息：来自 @orchestrator-1 的派单]')
    expect(payload).toContain('你的角色：Coder — implements features')
    expect(payload).toContain('dispatch_id: disp-42')
    expect(payload).toContain('add error handling to login.ts')
  })

  test('appends the worker reminder tail with the dispatch_id interpolated', () => {
    const payload = buildWorkerDispatchPayload('orchestrator-1', 'Coder', 'disp-77', 'task body')
    expect(payload).toContain(buildLocalizedWorkerReminderTail('disp-77', 'zh'))
    // No leaked placeholder.
    expect(payload).not.toContain('--dispatch <id>')
  })

  test('places the worker reminder AFTER the task body so it is the last thing the worker sees', () => {
    const payload = buildWorkerDispatchPayload('orchestrator-1', 'Coder', 'disp-99', 'do the thing')
    const taskBodyIdx = lineIndexOf(payload, 'do the thing')
    const reminderIdx = lineIndexOf(payload, '<hive-system-reminder>')
    expect(taskBodyIdx).toBeGreaterThanOrEqual(0)
    expect(reminderIdx).toBeGreaterThan(taskBodyIdx)
  })
})

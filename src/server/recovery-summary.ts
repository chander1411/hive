import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { PromptLanguage } from './prompt-language.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1536

const emptyLine = (language: PromptLanguage, en: string, es: string, zh: string) =>
  `- ${language === 'zh' ? zh : language === 'es' ? es : en}`

const formatUserInputs = (messages: RecoveryMessage[], language: PromptLanguage) => {
  const userInputs = messages.filter((message) => message.type === 'user_input')
  return userInputs.length > 0
    ? userInputs.slice(-5).map((message) => `- user: ${message.text}`)
    : [
        emptyLine(
          language,
          '(no new user input in the last hour)',
          '(sin mensajes nuevos del usuario en la última hora)',
          '（最近 1 小时没有新的 user_input）'
        ),
      ]
}

const formatTaskEvents = (
  messages: RecoveryMessage[],
  agent: AgentSummary,
  language: PromptLanguage
) => {
  const taskEvents = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' | 'report' | 'status' }> => {
      if (agent.role === 'orchestrator') {
        if (message.type === 'send') return message.from === agent.id
        return message.type === 'report' || message.type === 'status'
      }
      if (message.type === 'send') return message.to === agent.id || message.from === agent.id
      return (message.type === 'report' || message.type === 'status') && message.from === agent.id
    }
  )
  return taskEvents.length > 0
    ? taskEvents.slice(-8).map((message) => {
        if (message.type === 'send') return `- send -> ${message.to}: ${message.text}`
        if (message.type === 'status') return `- status <- ${message.from}: ${message.text}`
        const status = message.status ? ` [${message.status}]` : ''
        return `- report <- ${message.from}${status}: ${message.text}`
      })
    : [
        emptyLine(
          language,
          '(no recent task events)',
          '(sin eventos de tareas recientes)',
          '（最近没有任务事件）'
        ),
      ]
}

const getOpenTaskTargets = (agent: AgentSummary, workers: AgentSummary[]) =>
  agent.role === 'orchestrator' ? workers : [agent]

const formatOpenTasks = (
  messages: RecoveryMessage[],
  agent: AgentSummary,
  workers: AgentSummary[],
  language: PromptLanguage
) => {
  const targetAgents = getOpenTaskTargets(agent, workers).filter(
    (target) => target.role !== 'orchestrator'
  )
  const targetIds = new Set(targetAgents.map((target) => target.id))
  const queues = new Map<string, Array<Extract<RecoveryMessage, { type: 'send' }>>>()

  for (const message of messages) {
    if (message.type === 'send' && targetIds.has(message.to)) {
      const queue = queues.get(message.to) ?? []
      queue.push(message)
      queues.set(message.to, queue)
      continue
    }

    if (message.type === 'report' && targetIds.has(message.from)) {
      queues.get(message.from)?.shift()
    }
  }

  const lines: string[] = []
  for (const target of targetAgents) {
    const queue = queues.get(target.id) ?? []
    for (const task of queue.slice(-8)) {
      lines.push(`- ${target.name}: ${task.text}`)
    }
    if (target.pendingTaskCount > queue.length) {
      lines.push(
        `- ${target.name}: ${target.pendingTaskCount - queue.length} ${
          language === 'zh'
            ? '个 pending 无可恢复详情'
            : language === 'es'
              ? 'pendientes sin detalles recuperables'
              : 'pending without recoverable details'
        }`
      )
    }
  }

  return lines.length > 0
    ? lines
    : [emptyLine(language, '(no open tasks)', '(sin tareas pendientes)', '（当前没有未完成任务）')]
}

const formatWorkers = (workers: AgentSummary[], language: PromptLanguage) => {
  if (workers.length === 0) {
    return [emptyLine(language, 'no other workers', 'no hay otros workers', '当前没有其他 worker')]
  }
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const localizedCopy = (language: PromptLanguage) => {
  if (language === 'zh') {
    return {
      activeWorkers: '## 当前活跃 worker',
      continue: '请基于此继续。如果不确定，问 user。',
      identity: (workspace: WorkspaceSummary, agent: AgentSummary) =>
        `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`,
      openTasks: '## 当前未完成任务',
      recentConversation: '## 最近 1 小时与 user 的对话',
      restarted: '你刚被 Hive 重启了，且无法通过原生 session resume 恢复。下面是接力上下文。',
      rules: (agent: AgentSummary) =>
        agent.role === 'orchestrator' ? '## Hive worker 派单规则' : '## Hive worker 边界',
      taskEvents: (agent: AgentSummary) =>
        agent.role === 'orchestrator' ? '## 你已派出的任务' : '## 最近派给你的任务',
      tasksState: `## 当前 ${TASKS_RELATIVE_PATH} 状态`,
      empty: '(空)',
    }
  }
  const es = language === 'es'
  return {
    activeWorkers: es ? '## Workers activos' : '## Active workers',
    continue: es
      ? 'Continúa desde aquí. Si no estás seguro, pregunta al usuario.'
      : 'Continue from here. If unsure, ask the user.',
    identity: (workspace: WorkspaceSummary, agent: AgentSummary) =>
      es
        ? `Eres ${agent.name} (${agent.role}) del workspace ${workspace.name}.`
        : `You are ${agent.name} (${agent.role}) in the ${workspace.name} workspace.`,
    openTasks: es ? '## Tareas pendientes' : '## Open tasks',
    recentConversation: es
      ? '## Conversación reciente con el usuario'
      : '## Recent user conversation',
    restarted: es
      ? 'Hive acaba de reiniciarte sin poder recuperar la sesión nativa. Este es el contexto de continuidad.'
      : 'Hive just restarted you without native session resume. This is the recovery context.',
    rules: (agent: AgentSummary) =>
      agent.role === 'orchestrator'
        ? es
          ? '## Reglas para delegar a workers'
          : '## Hive worker dispatch rules'
        : es
          ? '## Límites del worker'
          : '## Hive worker boundaries',
    taskEvents: (agent: AgentSummary) =>
      agent.role === 'orchestrator'
        ? es
          ? '## Tareas delegadas'
          : '## Dispatched tasks'
        : es
          ? '## Tareas que te asignaron recientemente'
          : '## Tasks recently assigned to you',
    tasksState: es
      ? `## Estado actual de ${TASKS_RELATIVE_PATH}`
      : `## Current ${TASKS_RELATIVE_PATH} state`,
    empty: es ? '(vacío)' : '(empty)',
  }
}

export const buildRecoverySummary = ({
  agent,
  allTaskMessages,
  messages,
  tasksContent,
  workers,
  workspace,
  language = 'zh',
}: {
  agent: AgentSummary
  allTaskMessages?: RecoveryMessage[]
  messages: RecoveryMessage[]
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  language?: PromptLanguage
}) => {
  const copy = localizedCopy(language)
  return wrapSystemMessage(
    [
      copy.identity(workspace, agent),
      copy.restarted,
      '',
      copy.recentConversation,
      ...formatUserInputs(messages, language),
      '',
      copy.taskEvents(agent),
      ...formatTaskEvents(messages, agent, language),
      '',
      copy.openTasks,
      ...formatOpenTasks(allTaskMessages ?? messages, agent, workers, language),
      '',
      copy.tasksState,
      tasksContent.slice(0, TASKS_HEAD_LIMIT) || copy.empty,
      '',
      copy.activeWorkers,
      ...formatWorkers(workers, language),
      '',
      copy.rules(agent),
      ...getHiveTeamRules(agent, language),
      '',
      copy.continue,
    ].join('\n'),
    language
  )
}

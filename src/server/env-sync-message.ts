import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { getHiveTeamRules } from './hive-team-guidance.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { PromptLanguage } from './prompt-language.js'
import { wrapSystemMessage } from './system-message.js'
import { TASKS_RELATIVE_PATH } from './tasks-file.js'

const TASKS_HEAD_LIMIT = 1024

const formatWorkers = (workers: AgentSummary[], language: PromptLanguage) => {
  if (workers.length === 0) {
    return [
      language === 'zh'
        ? '- 当前没有其他 worker'
        : language === 'es'
          ? '- No hay otros workers'
          : '- No other workers',
    ]
  }
  return workers.map(
    (worker) =>
      `- ${worker.name} (${worker.role}, ${worker.status}, pending_task_count: ${worker.pendingTaskCount})`
  )
}

const formatRestartWindow = (messages: RecoveryMessage[], language: PromptLanguage) => {
  const sends = messages.filter(
    (message): message is Extract<RecoveryMessage, { type: 'send' }> => {
      return message.type === 'send'
    }
  )
  if (sends.length === 0) {
    return [
      language === 'zh'
        ? '- 重启期间未派新单'
        : language === 'es'
          ? '- No se delegaron tareas durante el reinicio'
          : '- No tasks were dispatched during restart',
    ]
  }
  return sends.slice(-5).map((message) => `- send -> ${message.to}: ${message.text}`)
}

export const buildEnvSyncMessage = ({
  agent,
  tasksContent,
  workers,
  workspace,
  restartWindowMessages,
  language = 'zh',
}: {
  agent: AgentSummary
  tasksContent: string
  workers: AgentSummary[]
  workspace: WorkspaceSummary
  restartWindowMessages: RecoveryMessage[]
  language?: PromptLanguage
}) => {
  const es = language === 'es'
  const zh = language === 'zh'
  return wrapSystemMessage(
    [
      zh
        ? '你刚被 Hive 重启了。期间环境变化：'
        : es
          ? 'Hive acaba de reiniciarte. Cambios del entorno:'
          : 'Hive just restarted you. Environment changes:',
      `- ${zh ? '当前 workspace' : es ? 'Workspace actual' : 'Current workspace'}: ${workspace.name}`,
      zh ? '- 现有 worker:' : es ? '- Workers actuales:' : '- Current workers:',
      ...formatWorkers(workers, language),
      `- ${TASKS_RELATIVE_PATH} ${zh ? '当前内容' : es ? 'contenido actual' : 'current content'}:`,
      tasksContent.slice(0, TASKS_HEAD_LIMIT) || (zh ? '(空)' : es ? '(vacío)' : '(empty)'),
      ...formatRestartWindow(restartWindowMessages, language),
      agent.role === 'orchestrator'
        ? zh
          ? '- Hive worker 派单规则:'
          : es
            ? '- Reglas para delegar:'
            : '- Hive worker dispatch rules:'
        : zh
          ? '- Hive worker 边界:'
          : es
            ? '- Límites del worker:'
            : '- Hive worker boundaries:',
      ...getHiveTeamRules(agent, language).map((rule) => `  - ${rule}`),
      zh
        ? `请继续。如果不确定，用 team list / Read ${TASKS_RELATIVE_PATH} 自查或问 user。`
        : es
          ? `Continúa. Si no estás seguro, usa team list, lee ${TASKS_RELATIVE_PATH} o pregunta al usuario.`
          : `Continue. If unsure, use team list, read ${TASKS_RELATIVE_PATH}, or ask the user.`,
    ].join('\n'),
    language
  )
}

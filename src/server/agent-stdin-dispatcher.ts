import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import {
  buildLocalizedWorkerReminderTail,
  getOrchestratorReminderTail,
} from './hive-team-guidance.js'
import { PtyInactiveError } from './http-errors.js'
import type { LiveRunRegistry } from './live-run-registry.js'
import { createPostStartInputWriter } from './post-start-input-writer.js'
import type { PromptLanguage } from './prompt-language.js'
import { localizeKnownRoleDescription } from './role-templates.js'

interface AgentStdinDispatcherInput {
  agentManager: AgentManager | undefined
  getLaunchConfig: (workspaceId: string, agentId: string) => AgentLaunchConfigInput | undefined
  getWorkspaceId: (agentId: string) => string | undefined
  registry: LiveRunRegistry
  syncRun: (run: LiveAgentRun) => LiveAgentRun
  getPromptLanguage?: () => PromptLanguage
}

export const buildOrchestratorReportPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  language: PromptLanguage = 'zh'
): string => {
  const heading =
    language === 'zh'
      ? `[Hive 系统消息：来自 @${workerName} 的汇报]`
      : language === 'es'
        ? `[Mensaje del sistema Hive: reporte de @${workerName}]`
        : `[Hive system message: report from @${workerName}]`
  const lines: string[] = [heading, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('', getOrchestratorReminderTail(language), '')
  return lines.join('\n')
}

export const buildOrchestratorStatusPayload = (
  workerName: string,
  text: string,
  artifacts: string[],
  language: PromptLanguage = 'zh'
): string => {
  const heading =
    language === 'zh'
      ? `[Hive 系统消息：来自 @${workerName} 的状态更新]`
      : language === 'es'
        ? `[Mensaje del sistema Hive: estado de @${workerName}]`
        : `[Hive system message: status from @${workerName}]`
  const lines: string[] = [heading, text]
  for (const artifact of artifacts) lines.push(`artifact: ${artifact}`)
  lines.push('', getOrchestratorReminderTail(language), '')
  return lines.join('\n')
}

export const buildOrchestratorUserInputPayload = (
  text: string,
  language: PromptLanguage = 'zh'
): string => [text, '', getOrchestratorReminderTail(language), ''].join('\n')

export const buildWorkerDispatchPayload = (
  fromAgentName: string,
  workerDescription: string,
  dispatchId: string,
  text: string,
  language: PromptLanguage = 'zh'
): string =>
  language === 'zh'
    ? [
        `[Hive 系统消息：来自 @${fromAgentName} 的派单]`,
        '',
        `你的角色：${workerDescription}`,
        '',
        '你必须遵守：',
        `- 完成、失败、阻塞或部分完成后，执行 \`team report "<result>" --dispatch ${dispatchId}\``,
        '- 不要做无关的事，做完就 report',
        '',
        `dispatch_id: ${dispatchId}`,
        '',
        '任务内容：',
        text,
        '',
        buildLocalizedWorkerReminderTail(dispatchId, language),
        '',
      ].join('\n')
    : [
        language === 'es'
          ? `[Mensaje del sistema Hive: tarea de @${fromAgentName}]`
          : `[Hive system message: task from @${fromAgentName}]`,
        '',
        `${language === 'es' ? 'Tu rol' : 'Your role'}: ${localizeKnownRoleDescription(
          workerDescription,
          language
        )}`,
        '',
        language === 'es' ? 'Debes cumplir:' : 'You must:',
        `- ${language === 'es' ? 'Al terminar, fallar o bloquearte, ejecuta' : 'When done, failed, or blocked, run'} \`team report "<result>" --dispatch ${dispatchId}\``,
        language === 'es'
          ? '- No hagas trabajo ajeno; reporta al terminar'
          : '- Do not do unrelated work; report when finished',
        '',
        `dispatch_id: ${dispatchId}`,
        '',
        language === 'es' ? 'Tarea:' : 'Task:',
        text,
        '',
        buildLocalizedWorkerReminderTail(dispatchId, language),
        '',
      ].join('\n')

export const buildWorkerCancelPayload = (
  dispatchId: string,
  reason: string,
  language: PromptLanguage = 'zh'
): string =>
  [
    language === 'zh'
      ? `[Hive 系统消息：dispatch ${dispatchId} 已取消]`
      : language === 'es'
        ? `[Mensaje del sistema Hive: dispatch ${dispatchId} cancelado]`
        : `[Hive system message: dispatch ${dispatchId} cancelled]`,
    '',
    language === 'zh'
      ? '请停止执行这条派单，不要再为它调用 team report。'
      : language === 'es'
        ? 'Detén esta tarea y no vuelvas a ejecutar team report para ella.'
        : 'Stop this task and do not call team report for it.',
    '',
    language === 'zh' ? '取消原因：' : language === 'es' ? 'Motivo:' : 'Reason:',
    reason,
    '',
  ].join('\n')

export const createAgentStdinDispatcher = ({
  agentManager,
  getLaunchConfig,
  getWorkspaceId,
  registry,
  syncRun,
  getPromptLanguage = () => 'zh',
}: AgentStdinDispatcherInput) => {
  const writeToActiveAgentRun = (
    workspaceId: string,
    agentId: string,
    text: string,
    input: { requireActiveRun?: boolean } = {}
  ) => {
    const run = registry
      .list()
      .filter((item) => item.agentId === agentId && getWorkspaceId(item.agentId) === workspaceId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .find((item) => {
        const status = syncRun(item).status
        return status === 'starting' || status === 'running'
      })
    if (!run) {
      if (input.requireActiveRun) {
        throw new PtyInactiveError(`No active run for agent: ${agentId}`)
      }
      return
    }

    try {
      const config = getLaunchConfig(workspaceId, agentId)
      if (agentManager && config) {
        createPostStartInputWriter(agentManager, config.interactiveCommand ?? config.command)(
          run.runId,
          text
        )
      } else {
        agentManager?.writeInput(run.runId, text)
      }
    } catch (error) {
      throw new PtyInactiveError(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    writeReportPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorReportPayload(workerName, text, artifacts, getPromptLanguage()),
        input
      )
    },
    writeStatusPrompt(
      workspaceId: string,
      workerName: string,
      text: string,
      artifacts: string[],
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorStatusPayload(workerName, text, artifacts, getPromptLanguage()),
        input
      )
    },
    writeSendPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      fromAgentName: string,
      workerDescription: string,
      text: string
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerDispatchPayload(
          fromAgentName,
          workerDescription,
          dispatchId,
          text,
          getPromptLanguage()
        ),
        { requireActiveRun: true }
      )
    },
    writeCancelPrompt(
      workspaceId: string,
      workerId: string,
      dispatchId: string,
      reason: string,
      input: { requireActiveRun?: boolean } = {}
    ) {
      writeToActiveAgentRun(
        workspaceId,
        workerId,
        buildWorkerCancelPayload(dispatchId, reason, getPromptLanguage()),
        input
      )
    },
    writeUserInputPrompt(workspaceId: string, text: string) {
      writeToActiveAgentRun(
        workspaceId,
        `${workspaceId}:orchestrator`,
        buildOrchestratorUserInputPayload(text, getPromptLanguage())
      )
    },
  }
}

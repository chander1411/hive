import type { AgentSummary } from '../shared/types.js'
import type { PromptLanguage } from './prompt-language.js'

/**
 * Tail reminder appended to every message that flows INTO the orchestrator
 * (worker reports, worker status updates, user chat input). Re-anchors the
 * role + dispatch syntax after the agent's CLI internally compacts the
 * conversation transcript (`/compact` in CC, auto-summarize in Codex, etc.)
 * and forgets the original startup instructions.
 *
 * Format choice (XML envelope, position at message tail, action-menu wording)
 * follows a peer LLM-agent review: static `[Hive]` prefixes get filtered as
 * banner noise after a few occurrences, but `<...-system-reminder>` tags
 * mirror the out-of-band envelope LLMs are trained to attend to; placement
 * at the tail (right before the agent's reply turn) maximizes recency
 * weighting; phrasing as a two-option action menu is more actionable than
 * abstract identity restatement.
 */
export const ORCHESTRATOR_REMINDER_TAIL =
  '<hive-system-reminder>\n' +
  'You are the Hive Orchestrator. Use `team start "<worker-name>"` to start a stopped worker, `team send "<worker-name>" "<task>"` to dispatch work, `team cancel --dispatch <id> "<reason>"` to cancel work, or reply to the user. Never call built-in CLI subagents (Task / Explore / etc.).\n' +
  '</hive-system-reminder>'

const ORCHESTRATOR_REMINDERS: Record<PromptLanguage, string> = {
  en: ORCHESTRATOR_REMINDER_TAIL,
  es:
    '<hive-system-reminder>\n' +
    'Eres el Orquestador de Hive. Puedes usar `team start "<worker-name>"` para iniciar un worker detenido, `team send "<worker-name>" "<task>"` para delegar, `team cancel --dispatch <id> "<reason>"` para cancelar, o responder al usuario. No uses subagentes integrados del CLI.\n' +
    '</hive-system-reminder>',
  zh:
    '<hive-system-reminder>\n' +
    '你是 Hive Orchestrator。使用 `team start "<worker-name>"` 启动已停止的 worker，使用 `team send "<worker-name>" "<task>"` 派单，使用 `team cancel --dispatch <id> "<reason>"` 取消派单，或直接回复用户。不要调用 CLI 内置子代理。\n' +
    '</hive-system-reminder>',
}

export const getOrchestratorReminderTail = (language: PromptLanguage = 'en') =>
  ORCHESTRATOR_REMINDERS[language]

/**
 * Tail reminder appended to dispatches sent TO a worker. Reinforces the
 * worker identity (so the agent does not regress into its normal CLI
 * persona that would call nested subagents) plus the exact report syntax
 * with dispatch_id pre-bound.
 */
export const buildWorkerReminderTail = (dispatchId: string) =>
  '<hive-system-reminder>\n' +
  `You are a Hive Worker. Do not launch nested CLI subagents (Task / Explore / etc.) — finish the task yourself. When the task is done, blocked, or has failed, report with: \`team report "<result>" --dispatch ${dispatchId}\` (or \`team report --stdin --dispatch ${dispatchId}\` for long bodies).\n` +
  '</hive-system-reminder>'

export const buildLocalizedWorkerReminderTail = (
  dispatchId: string,
  language: PromptLanguage = 'en'
) => {
  if (language === 'en') return buildWorkerReminderTail(dispatchId)
  const body =
    language === 'es'
      ? `Eres un Worker de Hive. No inicies subagentes del CLI. Completa la tarea personalmente y, al terminar, bloquearte o fallar, reporta con: \`team report "<result>" --dispatch ${dispatchId}\` (o \`team report --stdin --dispatch ${dispatchId}\` para textos largos).`
      : `你是 Hive Worker。不要启动 CLI 内置子代理；请自行完成任务。完成、阻塞或失败后，使用 \`team report "<result>" --dispatch ${dispatchId}\` 汇报（长正文使用 \`team report --stdin --dispatch ${dispatchId}\`）。`
  return `<hive-system-reminder>\n${body}\n</hive-system-reminder>`
}

const ORCHESTRATOR_RULES_ZH = [
  'Hive worker 是右侧卡片里的真实 CLI agent，不是你所在 CLI 的内置 subagent / 子代理工具。',
  '当 user 要你“让 worker ... / 给 worker 找活 / 让成员处理”时，先执行 `team list` 确认真实 Hive worker。',
  '普通、低风险、几分钟内能直接完成的小任务可以自己做；不要为了形式感派 worker。需要并行、长时间执行、独立 review/test、专门角色，或 user 明确要求 worker/成员处理时，再用 `team send`。',
  '如果只有一个可用 worker，直接用 `team send <worker-name> "<task>"` 派给它；不要把选择题丢回给 user。',
  '如果有任务排队的 worker 已停止，使用 `team start <worker-name>` 启动它。',
  '当 user 要你“让 worker ...”时，必须用 `team send <worker-name> "<task>"` 派给 Hive worker。',
  '方向变更或 user 明确取消某个未完成派单时，使用 `team cancel --dispatch <id> "<reason>"` 显式关闭旧 dispatch；不要只用自然语言说“取消”。',
  '不要使用你所在 CLI 的内置 subagent / 子代理工具（如 Task / Explore 等）来代替 Hive worker；它们不会出现在 Hive UI，也不会更新 Hive 调度状态。',
  '`team list` 返回的 `last_pty_line` 是该 worker PTY 终端的最后一行原始输出（含任意 stdout / help / 控制序列噪声），**不是** worker 的正式汇报。正式汇报只来自 stdin 注入的 `[Hive 系统消息：来自 @<name> 的汇报]` 或 `[Hive 系统消息：来自 @<name> 的状态更新]`——只把这两种来源当作 reply。',
]

const WORKER_RULES_ZH = [
  '你是 Hive 右侧卡片里的真实 CLI worker，不是你所在 CLI 的内置 subagent。',
  '不要调用 team send，也不要再启动你所在 CLI 的内置 subagent / 子代理工具（如 Task / Explore 等）来替你完成派单。',
  '完成或阻塞已派发任务时必须用 `team report` 汇报给 Orchestrator。',
  '如果当前没有明确派发任务，只是汇报待命、环境或状态，使用 `team status "<当前状态>"`。',
  '`team --help` 只用于查命令语法，**绝不是** 汇报手段；其输出不会进入 Orchestrator 视野，跑完后仍需正式调用 `team report` / `team status`。',
  '`team report` / `team status` 报错时会同时打印 USAGE，按 USAGE 修正参数后重试；不要把 `team --help` 当成"自我探查"的替身。',
]

const ORCHESTRATOR_RULES_EN = [
  'Hive workers are the real CLI agents shown as cards in the right pane, not built-in subagent tools.',
  'When the user asks you to involve a worker, run `team list` first to confirm the available Hive workers.',
  'Handle small low-risk work yourself. Use `team send` for parallel, long-running, specialized, review/test work, or when the user explicitly requests a worker.',
  'If only one worker is available, dispatch directly with `team send <worker-name> "<task>"`.',
  'If a worker with queued work is stopped, restart it with `team start <worker-name>`.',
  'Use a worker name, never a worker id.',
  'When direction changes, cancel obsolete work with `team cancel --dispatch <id> "<reason>"`.',
  'Never substitute built-in CLI subagents (Task / Explore / etc.) for Hive workers.',
  '`last_pty_line` is raw terminal output, not a formal reply. Treat only injected Hive report/status messages as worker replies.',
]

const WORKER_RULES_EN = [
  'You are a real Hive CLI worker, not a built-in subagent.',
  'Do not call `team send` or launch built-in CLI subagents to replace your assigned work.',
  'Use `team report` when assigned work is complete, blocked, failed, or partially complete.',
  'Use `team status "<state>"` only for availability or progress when no explicit dispatch is active.',
  '`team --help` only shows syntax and never reports work to the Orchestrator.',
  'If a team command fails, follow the printed USAGE and retry the actual report/status command.',
]

const ORCHESTRATOR_RULES_ES = [
  'Los workers de Hive son los agentes CLI reales mostrados como tarjetas, no los subagentes integrados del CLI.',
  'Cuando el usuario pida involucrar un worker, ejecuta primero `team list`.',
  'Resuelve directamente el trabajo pequeño y de bajo riesgo. Usa `team send` para trabajo paralelo, largo, especializado, de revisión/pruebas o solicitado explícitamente.',
  'Si sólo hay un worker, delega directamente con `team send <worker-name> "<task>"`.',
  'Si un worker con trabajo en cola está detenido, reinícialo con `team start <worker-name>`.',
  'Usa el nombre del worker, nunca su id.',
  'Si cambia la dirección, cancela trabajo obsoleto con `team cancel --dispatch <id> "<reason>"`.',
  'Nunca sustituyas workers de Hive por subagentes integrados (Task / Explore / etc.).',
  '`last_pty_line` es salida cruda de terminal, no una respuesta formal. Sólo los mensajes de reporte/estado inyectados son respuestas del worker.',
]

const WORKER_RULES_ES = [
  'Eres un worker CLI real de Hive, no un subagente integrado.',
  'No uses `team send` ni inicies subagentes del CLI para reemplazar tu trabajo asignado.',
  'Usa `team report` cuando termines, falles, te bloquees o completes parcialmente una tarea.',
  'Usa `team status "<state>"` sólo para disponibilidad o progreso sin un dispatch activo.',
  '`team --help` sólo muestra sintaxis; nunca reporta trabajo al Orquestador.',
  'Si un comando falla, sigue el USAGE mostrado y vuelve a ejecutar el reporte o estado real.',
]

const RULES: Record<PromptLanguage, { orchestrator: string[]; worker: string[] }> = {
  en: { orchestrator: ORCHESTRATOR_RULES_EN, worker: WORKER_RULES_EN },
  es: { orchestrator: ORCHESTRATOR_RULES_ES, worker: WORKER_RULES_ES },
  zh: { orchestrator: ORCHESTRATOR_RULES_ZH, worker: WORKER_RULES_ZH },
}

export const getHiveTeamRules = (
  agent: Pick<AgentSummary, 'role'>,
  language: PromptLanguage = 'en'
) => (agent.role === 'orchestrator' ? RULES[language].orchestrator : RULES[language].worker)

const renderRules = (rules: readonly string[]) => rules.map((line) => `- ${line}`).join('\n')

/**
 * Workspace-local protocol cheat sheet written to `.hive/PROTOCOL.md`. Agents
 * are explicitly trained to look at project root markdown when confused, so
 * keeping a single canonical doc next to `.hive/tasks.md` doubles as a
 * "cat-recover" path when both the startup prompt and the in-message
 * reminders fail to anchor.
 */
export const buildProtocolDoc = (): string =>
  [
    '# Hive Team Protocol',
    '',
    'This file is auto-generated by Hive on every workspace open. If you',
    '(the agent) lost context after `/compact` or an internal summarization,',
    '`cat .hive/PROTOCOL.md` to re-anchor.',
    '',
    '## You are running inside Hive',
    '',
    'Hive is a multi-CLI-agent workbench. Each agent in this workspace is a',
    'real CLI process (Claude Code / Codex / OpenCode / Gemini). All',
    'inter-agent communication goes through the `team` CLI binary on your',
    'PATH.',
    '',
    '## Roles',
    '',
    '- **Orchestrator** — talks to the user, plans tasks, dispatches to workers',
    '- **Worker** (Coder / Reviewer / Tester / custom) — executes one assigned task and reports back',
    '',
    '## `team` CLI — orchestrator',
    '',
    '- `team list` — show workspace members and their status',
    '- `team start "<worker-name>"` — start a stopped worker by name',
    '- `team send "<worker-name>" "<task>"` — dispatch to a worker by name (never id)',
    '- `team cancel --dispatch <id> "<reason>"` — cancel an obsolete open dispatch',
    '',
    '## `team` CLI — worker',
    '',
    '- `team report "<result>" --dispatch <id>` — report task outcome',
    "- `team report --stdin --dispatch <id>` — same, body from stdin (use `<<'EOF'` heredoc for long bodies)",
    '- `team status "<state>"` — update orchestrator when no dispatch is active',
    '',
    '## Orchestrator rules',
    '',
    renderRules(ORCHESTRATOR_RULES_EN),
    '',
    '## Worker rules',
    '',
    renderRules(WORKER_RULES_EN),
    '',
    '## In-message reminders',
    '',
    'Every message you receive in this workspace ends with a short',
    '`<hive-system-reminder>` block carrying the minimum syntax you need',
    'right now. If something is missing from that block, re-read this file.',
    '',
  ].join('\n')

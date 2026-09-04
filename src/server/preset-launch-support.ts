import type { AgentLaunchConfigInput } from './agent-run-store.js'
import type { CommandPresetRecord } from './command-preset-store.js'
import type { SessionCaptureSnapshot, SessionIdCaptureConfig } from './session-capture.js'
import { doesCapturedSessionExist } from './session-capture.js'

type BoundPreset = Pick<
  CommandPresetRecord,
  'resumeArgsTemplate' | 'sessionIdCapture' | 'yoloArgsTemplate'
>

const appendUniqueArgs = (prefix: string[], args: string[]) => {
  const seen = new Set(prefix)
  return prefix.concat(args.filter((arg) => !seen.has(arg)))
}

const getEffectiveCapture = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.sessionIdCapture ?? preset?.sessionIdCapture ?? null

const getEffectiveResumeTemplate = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => config.resumeArgsTemplate ?? preset?.resumeArgsTemplate ?? null

const withPresetYoloArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined
) => {
  const yoloArgs = preset?.yoloArgsTemplate
  if (!yoloArgs?.length) return config
  const nextArgs = appendUniqueArgs(yoloArgs, config.args ?? [])
  if (
    nextArgs.length === (config.args ?? []).length &&
    nextArgs.every((arg, index) => arg === (config.args ?? [])[index])
  ) {
    return config
  }
  return { ...config, args: nextArgs }
}

const getPresetYoloArgs = (preset: BoundPreset | null | undefined) => preset?.yoloArgsTemplate ?? []

const hasResumeArgs = (args: string[]) =>
  args.includes('--resume') ||
  args.includes('-r') ||
  args.includes('--continue') ||
  args.includes('-c') ||
  args.includes('--session') ||
  args.includes('-s') ||
  args[0] === 'resume'

const longResumeFlagsWithValue = new Set(['--resume', '--session'])
const shortResumeFlagsWithValue = new Set(['-r', '-s'])
const knownSessionCliCommands = new Set(['claude', 'codex', 'gemini', 'opencode'])
const claudeFreshSettingSources = ['--setting-sources', 'project,local']

const stripDirectResumeArgs = (args: string[], allowShortFlags: boolean) => {
  const sanitized: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (index === 0 && arg === 'resume') {
      index += 1
      continue
    }
    if (
      longResumeFlagsWithValue.has(arg) ||
      (allowShortFlags && shortResumeFlagsWithValue.has(arg))
    ) {
      const value = args[index + 1]
      if (value && !value.startsWith('-')) index += 1
      continue
    }
    if (
      arg === '--continue' ||
      (allowShortFlags && arg === '-c') ||
      arg.startsWith('--resume=') ||
      arg.startsWith('--session=')
    ) {
      continue
    }
    sanitized.push(arg)
  }
  return sanitized
}

const stripShellResumeArgs = (command: string) =>
  command
    .replace(/^((?:"[^"]*"|'[^']*'|\S+))\s+resume(?:\s+(?!-)(?:"[^"]*"|'[^']*'|\S+))?/, '$1')
    .replace(
      /(^|\s)(?:--resume|--session|-r|-s)(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?!-)(?:"[^"]*"|'[^']*'|\S+))?/g,
      '$1'
    )
    .replace(/(^|\s)(?:--continue|-c)(?=\s|$)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()

const injectShellResumeArgs = (command: string, resumeArgs: string) => {
  const sanitized = stripShellResumeArgs(command)
  const executable = /^(?:"[^"]*"|'[^']*'|\S+)/.exec(sanitized)?.[0]
  if (!executable) return sanitized
  return `${executable} ${resumeArgs}${sanitized.slice(executable.length)}`
}

const isolateFreshClaudeShellCommand = (command: string) => {
  const withoutSettingSources = command
    .replace(
      /(^|\s)--setting-sources(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))/g,
      '$1'
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
  const executable = /^(?:"[^"]*"|'[^']*'|\S+)/.exec(withoutSettingSources)?.[0]
  if (!executable) return withoutSettingSources
  return `${executable} --setting-sources project,local${withoutSettingSources.slice(executable.length)}`
}

export const withoutSessionResumeArgs = (
  config: AgentLaunchConfigInput
): AgentLaunchConfigInput => {
  const args = config.args ?? []
  const shellWrapped = Boolean(
    config.interactiveCommand && config.interactiveCommand !== config.command && args.length > 1
  )
  const commandName = (config.interactiveCommand ?? config.command).split(/[\\/]/).at(-1) ?? ''
  let sanitizedArgs = shellWrapped
    ? args.map((arg, index) => (index === args.length - 1 ? stripShellResumeArgs(arg) : arg))
    : stripDirectResumeArgs(args, knownSessionCliCommands.has(commandName))
  if (commandName === 'claude') {
    if (shellWrapped) {
      sanitizedArgs = sanitizedArgs.map((arg, index) =>
        index === sanitizedArgs.length - 1 ? isolateFreshClaudeShellCommand(arg) : arg
      )
    } else {
      sanitizedArgs = sanitizedArgs.filter((arg, index) => {
        const previous = sanitizedArgs[index - 1]
        return (
          arg !== '--setting-sources' &&
          !arg.startsWith('--setting-sources=') &&
          previous !== '--setting-sources'
        )
      })
      sanitizedArgs = claudeFreshSettingSources.concat(sanitizedArgs)
    }
  }
  return {
    ...config,
    args: sanitizedArgs,
    resumedSessionId: null,
  }
}

const shouldVerifySessionBeforeResume = (capture: SessionIdCaptureConfig | null | undefined) => {
  // Claude is a cheap project-dir existence check; OpenCode is a direct DB query.
  // Codex/Gemini require broad session-store scans, so trust the persisted id and
  // let the CLI fail fast if it is stale.
  return capture?.source === 'claude_project_jsonl_dir' || capture?.source === 'opencode_session_db'
}

const supportsPresetResume = (capture: SessionIdCaptureConfig | null | undefined) =>
  capture?.source === 'claude_project_jsonl_dir' ||
  capture?.source === 'codex_session_jsonl_dir' ||
  capture?.source === 'gemini_session_json_dir' ||
  capture?.source === 'opencode_session_db'

export const withPresetResumeArgs = (
  config: AgentLaunchConfigInput,
  preset: BoundPreset | null | undefined,
  lastSessionId: string | undefined,
  cwd?: string,
  discriminator?: SessionCaptureSnapshot['discriminator'],
  onInvalidSessionId?: (sessionId: string) => void
) => {
  let nextConfig = withPresetYoloArgs(config, preset)
  const sessionIdCapture = getEffectiveCapture(nextConfig, preset)
  if (sessionIdCapture && sessionIdCapture !== nextConfig.sessionIdCapture) {
    nextConfig = { ...nextConfig, sessionIdCapture }
  }

  const resumeArgsTemplate = getEffectiveResumeTemplate(nextConfig, preset)
  if (!lastSessionId || !resumeArgsTemplate) return nextConfig
  if (sessionIdCapture && !supportsPresetResume(sessionIdCapture)) return nextConfig
  if (
    cwd &&
    sessionIdCapture &&
    shouldVerifySessionBeforeResume(sessionIdCapture) &&
    !doesCapturedSessionExist(cwd, sessionIdCapture, lastSessionId, discriminator)
  ) {
    onInvalidSessionId?.(lastSessionId)
    return nextConfig
  }
  const args = config.args ?? []
  const resumeCommand = resumeArgsTemplate.replace('{session_id}', lastSessionId).trim()
  const shellWrapped = Boolean(
    config.interactiveCommand && config.interactiveCommand !== config.command && args.length > 1
  )
  if (shellWrapped) {
    return {
      ...nextConfig,
      args: args.map((arg, index) =>
        index === args.length - 1 ? injectShellResumeArgs(arg, resumeCommand) : arg
      ),
      resumeArgsTemplate,
      resumedSessionId: lastSessionId,
    } satisfies AgentLaunchConfigInput
  }
  if (hasResumeArgs(args)) return nextConfig
  const yoloArgs = getPresetYoloArgs(preset)
  const resumeArgs = resumeCommand.split(/\s+/)

  return {
    ...nextConfig,
    args: appendUniqueArgs(yoloArgs, resumeArgs.concat(args)),
    resumeArgsTemplate,
    resumedSessionId: lastSessionId,
  } satisfies AgentLaunchConfigInput
}

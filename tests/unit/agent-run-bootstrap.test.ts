import { describe, expect, test } from 'vitest'

import { buildAgentRunBootstrap } from '../../src/server/agent-run-bootstrap.js'
import type { AgentSessionStore } from '../../src/server/agent-session-store.js'
import type { CommandPresetRecord } from '../../src/server/command-preset-store.js'

const codexPreset: CommandPresetRecord = {
  args: [],
  command: 'codex',
  displayName: 'Codex',
  env: {},
  id: 'codex',
  isBuiltin: true,
  resumeArgsTemplate: 'resume {session_id}',
  sessionIdCapture: {
    pattern: '~/.codex/sessions/**/*.jsonl',
    source: 'codex_session_jsonl_dir',
  },
  yoloArgsTemplate: null,
}

const createSessionStore = (sessionId: string): AgentSessionStore => ({
  clearLastSessionId: () => {},
  getLastSessionId: () => sessionId,
  setLastSessionId: () => {},
})

describe('agent run bootstrap', () => {
  test('does not snapshot sessions before spawning when a preset resume id is available', () => {
    const sessionId = '019dc277-0e8e-75c1-9794-94929426288e'
    const bootstrap = buildAgentRunBootstrap(
      {
        id: 'workspace-1',
        name: 'Workspace',
        path: '/tmp/no-such-codex-workspace',
      },
      'agent-1',
      {
        args: [],
        command: 'codex',
        commandPresetId: 'codex',
      },
      createSessionStore(sessionId),
      (id) => (id === 'codex' ? codexPreset : undefined)
    )

    expect(bootstrap.startConfig).toMatchObject({
      args: ['resume', sessionId],
      resumedSessionId: sessionId,
    })
    expect(bootstrap.sessionCaptureSnapshot).toBeUndefined()
  })

  test('fresh start strips direct continuation arguments from configuration', () => {
    const bootstrap = buildAgentRunBootstrap(
      { id: 'workspace-1', name: 'Workspace', path: '/tmp/no-such-workspace' },
      'agent-1',
      {
        args: ['--continue', '--resume', 'old-session', '--model', 'sonnet'],
        command: 'claude',
      },
      createSessionStore('old-session'),
      () => undefined,
      undefined,
      true
    )

    expect(bootstrap.startConfig.args).toEqual([
      '--setting-sources',
      'project,local',
      '--model',
      'sonnet',
    ])
    expect(bootstrap.startConfig.resumedSessionId).toBeNull()
  })

  test('fresh start strips continuation arguments from shell-wrapped startup commands', () => {
    const bootstrap = buildAgentRunBootstrap(
      { id: 'workspace-1', name: 'Workspace', path: '/tmp/no-such-workspace' },
      'agent-1',
      {
        args: ['-lic', 'ccs --continue --model sonnet'],
        command: '/bin/zsh',
        interactiveCommand: 'claude',
        presetAugmentationDisabled: true,
      },
      createSessionStore('old-session'),
      () => undefined,
      undefined,
      true
    )

    expect(bootstrap.startConfig.args).toEqual([
      '-lic',
      'ccs --setting-sources project,local --model sonnet',
    ])
    expect(bootstrap.startConfig.resumedSessionId).toBeNull()
  })

  test('fresh start strips a bare shell-wrapped --resume flag', () => {
    const bootstrap = buildAgentRunBootstrap(
      { id: 'workspace-1', name: 'Workspace', path: '/tmp/no-such-workspace' },
      'agent-1',
      {
        command: '/bin/zsh',
        args: ['-lic', 'claude --resume'],
        interactiveCommand: 'claude',
      },
      createSessionStore('old-session'),
      () => undefined,
      undefined,
      true
    )

    expect(bootstrap.startConfig.args).toEqual(['-lic', 'claude --setting-sources project,local'])
    expect(bootstrap.startConfig.resumedSessionId).toBeNull()
  })

  test('fresh Claude start excludes user hooks that can inject cross-session memory', () => {
    const bootstrap = buildAgentRunBootstrap(
      { id: 'workspace-1', name: 'Workspace', path: '/tmp/no-such-workspace' },
      'agent-1',
      {
        args: ['--setting-sources', 'user,project,local'],
        command: 'claude',
      },
      createSessionStore('old-session'),
      () => undefined,
      undefined,
      true
    )

    expect(bootstrap.startConfig.args).toEqual(['--setting-sources', 'project,local'])
  })

  test('fresh start preserves a shell execution -c argument', () => {
    const bootstrap = buildAgentRunBootstrap(
      { id: 'workspace-1', name: 'Workspace', path: '/tmp/no-such-workspace' },
      'agent-1',
      { args: ['-c', 'echo ready'], command: '/bin/bash' },
      createSessionStore('old-session'),
      () => undefined,
      undefined,
      true
    )

    expect(bootstrap.startConfig.args).toEqual(['-c', 'echo ready'])
  })

  test('switching back injects the selected id into a shell-wrapped command', () => {
    const bootstrap = buildAgentRunBootstrap(
      { id: 'workspace-1', name: 'Workspace', path: '/tmp/no-such-workspace' },
      'agent-1',
      {
        args: ['-lic', 'ccs --continue --model sonnet'],
        command: '/bin/zsh',
        interactiveCommand: 'claude',
        presetAugmentationDisabled: true,
        resumeArgsTemplate: '--resume {session_id}',
      },
      createSessionStore('selected-session'),
      () => undefined
    )

    expect(bootstrap.startConfig.args).toEqual([
      '-lic',
      'ccs --resume selected-session --model sonnet',
    ])
    expect(bootstrap.startConfig.resumedSessionId).toBe('selected-session')
  })
})

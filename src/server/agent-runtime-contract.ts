import type { WorkspaceSummary } from '../shared/types.js'

import type { PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import type { PtyOutputBus } from './pty-output-bus.js'

interface StartAgentOptions {
  hivePort: string
  sessionId?: string | undefined
}

export interface AgentRuntime {
  clearAgentFreshStart: (workspaceId: string, agentId: string) => void
  clearLastSessionId: (workspaceId: string, agentId: string) => void
  close: () => Promise<void>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: import('./agent-run-store.js').AgentLaunchConfigInput
  ) => void
  deleteAgentLaunchConfig: (workspaceId: string, agentId: string) => void
  getActiveRunByAgentId: (
    workspaceId: string,
    agentId: string,
    sessionId?: string
  ) => LiveAgentRun | undefined
  getLastSessionId: (workspaceId: string, agentId: string) => string | undefined
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => import('./agent-run-store.js').AgentLaunchConfigInput | undefined
  getLiveRun: (runId: string) => LiveAgentRun
  getPtyOutputBus: () => PtyOutputBus
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  markAgentForFreshStart: (workspaceId: string, agentId: string) => void
  pauseRun: (runId: string) => void
  peekAgentToken: (agentId: string, sessionId?: string) => string | undefined
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeRun: (runId: string) => void
  setLastSessionId: (workspaceId: string, agentId: string, sessionId: string) => void
  startAgent: (
    workspace: WorkspaceSummary,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  stopAgentRun: (runId: string) => void
  stopAgentAcrossSessions: (workspaceId: string, agentId: string) => void
  stopAgentAndWait: (workspaceId: string, agentId: string, sessionId?: string) => Promise<void>
  stopSessionAndWait: (workspaceId: string, sessionId: string) => Promise<void>
  stopWorkspaceAndWait: (workspaceId: string) => Promise<void>
  validateAgentToken: (agentId: string, token: string | undefined, sessionId?: string) => boolean
  writeReportPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean; sessionId?: string | undefined }
  ) => void
  writeStatusPrompt: (
    workspaceId: string,
    workerName: string,
    workerId: string,
    text: string,
    artifacts: string[],
    input?: { requireActiveRun?: boolean; sessionId?: string | undefined }
  ) => void
  writeSendPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    fromAgentName: string,
    workerDescription: string,
    text: string,
    sessionId?: string
  ) => void
  writeCancelPrompt: (
    workspaceId: string,
    workerId: string,
    dispatchId: string,
    reason: string,
    input?: { requireActiveRun?: boolean; sessionId?: string | undefined }
  ) => void
  writeUserInputPrompt: (workspaceId: string, text: string, sessionId?: string) => void
}

export type { StartAgentOptions }

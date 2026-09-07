import type { AgentRunSnapshot } from './agent-manager.js'

export interface LiveAgentRun extends AgentRunSnapshot {
  sessionId?: string | undefined
  startedAt: number
  workspaceId?: string
}

import type { LiveAgentRun } from './agent-runtime-types.js'
import type { LiveRunRegistry } from './live-run-registry.js'

export const getActiveRunByAgent = (
  registry: LiveRunRegistry,
  getWorkspaceId: (agentId: string) => string | undefined,
  syncRun: (run: LiveAgentRun) => LiveAgentRun,
  workspaceId: string,
  agentId: string,
  sessionId?: string
) => {
  return registry
    .list()
    .filter(
      (run) =>
        run.agentId === agentId &&
        (run.workspaceId === workspaceId || getWorkspaceId(run.agentId) === workspaceId) &&
        (sessionId === undefined || run.sessionId === sessionId)
    )
    .sort((left, right) => right.startedAt - left.startedAt)
    .find((run) => {
      const status = syncRun(run).status
      return status === 'starting' || status === 'running'
    })
}

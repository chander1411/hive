import { BadRequestError, ConflictError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type {
  CancelTaskBody,
  ReportTaskBody,
  RouteDefinition,
  SendTaskBody,
  StartWorkerBody,
} from './route-types.js'
import { authenticateCliAgent, requireCommandForRole } from './team-authz.js'

const requireNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`Missing ${field}`)
  }
  return value
}

const getArtifacts = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const teamRoutes: RouteDefinition[] = [
  route('POST', '/api/team/start', async ({ request, response, store }) => {
    const body = await readJsonBody<StartWorkerBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const workerName = requireNonEmptyString(body.worker_name, 'worker_name')
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
      sessionId,
    })
    requireCommandForRole(agent, 'start')
    const worker = store.listWorkers(projectId, sessionId).find((item) => item.name === workerName)
    if (!worker) throw new BadRequestError(`Worker not found: ${workerName}`)
    if (!store.peekAgentLaunchConfig(projectId, worker.id)) {
      throw new ConflictError('No worker launch config available')
    }
    const existingRun = store.getActiveRunByAgentId(projectId, worker.id, sessionId)
    const run = await store.startAgent(projectId, worker.id, {
      hivePort: String(request.socket.localPort ?? ''),
      sessionId,
    })
    sendJson(response, 202, {
      already_running: existingRun !== undefined,
      ok: true,
      run_id: run.runId,
      worker_id: worker.id,
    })
  }),
  route('POST', '/api/team/send', async ({ request, response, store }) => {
    const body = await readJsonBody<SendTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const to = requireNonEmptyString(body.to, 'to')
    const text = requireNonEmptyString(body.text, 'text')
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
      sessionId,
    })
    requireCommandForRole(agent, 'send')
    const dispatch = await store.dispatchTaskByWorkerName(projectId, to, text, {
      fromAgentId,
      hivePort: String(request.socket.localPort ?? ''),
      sessionId,
    })

    sendJson(response, 202, { dispatch_id: dispatch.id, ok: true })
  }),
  route('POST', '/api/team/cancel', async ({ request, response, store }) => {
    const body = await readJsonBody<CancelTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const dispatchId = requireNonEmptyString(body.dispatch_id, 'dispatch_id')
    const reason = requireNonEmptyString(body.reason, 'reason')
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
      sessionId,
    })
    requireCommandForRole(agent, 'cancel')
    const result = store.cancelTask(projectId, dispatchId, { fromAgentId, reason, sessionId })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
  }),
  route('POST', '/api/team/report', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
      sessionId,
    })
    requireCommandForRole(agent, 'report')
    const reportInput = {
      artifacts: getArtifacts(body.artifacts),
      ...(typeof body.dispatch_id === 'string' ? { dispatchId: body.dispatch_id } : {}),
      requireActiveRun: true,
      text: resultText,
      sessionId,
    }
    if (typeof body.status === 'string') {
      const result = store.reportTask(projectId, fromAgentId, {
        ...reportInput,
        status: body.status,
      })
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    } else {
      const result = store.reportTask(projectId, fromAgentId, reportInput)
      sendJson(response, 202, {
        dispatch_id: result.dispatch?.id ?? null,
        forward_error: result.forwardError,
        forwarded: result.forwarded,
        ok: true,
      })
      return
    }
  }),
  route('POST', '/api/team/status', async ({ request, response, store }) => {
    const body = await readJsonBody<ReportTaskBody>(request)
    const projectId = requireNonEmptyString(body.project_id, 'project_id')
    const fromAgentId = requireNonEmptyString(body.from_agent_id, 'from_agent_id')
    const resultText = requireNonEmptyString(body.result, 'result')
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined
    const agent = authenticateCliAgent({
      fromAgentId,
      getAgent: store.getAgent,
      token: body.token,
      validateToken: store.validateAgentToken,
      workspaceId: projectId,
      sessionId,
    })
    requireCommandForRole(agent, 'status')
    const result = store.statusTask(projectId, fromAgentId, {
      artifacts: getArtifacts(body.artifacts),
      requireActiveRun: true,
      text: resultText,
      sessionId,
    })
    sendJson(response, 202, {
      dispatch_id: result.dispatch?.id ?? null,
      forward_error: result.forwardError,
      forwarded: result.forwarded,
      ok: true,
    })
    return
  }),
]

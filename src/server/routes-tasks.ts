import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const taskRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks',
    ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const sessionId = store.getActiveWorkspaceSessionId(workspaceId)
      sendJson(response, 200, {
        content: tasksFileService.readSessionTasks(workspace.summary.path, sessionId),
      })
    }
  ),
  route(
    'PUT',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const body = await readJsonBody<{ content: string }>(request)
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const sessionId = store.getActiveWorkspaceSessionId(workspaceId)
      tasksFileService.writeSessionTasks(workspace.summary.path, sessionId, body.content)
      tasksFileService.writeTasks(workspace.summary.path, body.content)
      sendJson(response, 200, { content: body.content })
    }
  ),
]

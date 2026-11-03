import { PACKAGE_NAME, readPackageVersion } from './package-version.js'
import { route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'

export const versionRoutes: RouteDefinition[] = [
  route('GET', '/api/version', async ({ response }) => {
    sendJson(response, 200, {
      current_version: readPackageVersion(),
      package_name: PACKAGE_NAME,
    })
  }),
]

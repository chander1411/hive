const MARKER = '::hive-session::'

export const toSessionScopeId = (workspaceId: string, sessionId?: string) =>
  sessionId ? `${workspaceId}${MARKER}${sessionId}` : workspaceId

export const fromSessionScopeId = (scopeId: string) => {
  const index = scopeId.indexOf(MARKER)
  return index < 0
    ? { sessionId: undefined, workspaceId: scopeId }
    : { sessionId: scopeId.slice(index + MARKER.length), workspaceId: scopeId.slice(0, index) }
}

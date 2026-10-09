import type { SessionMeta } from './agentServer'

/** Maps the persisted sessions file (+ settings) to the metadata served by GET /api/sessions. */
export function toSessionMetas(data: any, settings: any): SessionMeta[] {
  const sessions: any[] = Array.isArray(data?.sessions) ? data.sessions : []
  const folders: any[] = Array.isArray(data?.folders) ? data.folders : []
  const tool = typeof settings?.codingTool === 'string' ? settings.codingTool : 'claude'
  return sessions
    // Remote tabs (kind: 'remote') are views of another Mac's sessions, never ours to serve.
    .filter((s) => s && typeof s.id === 'string' && s.kind !== 'remote')
    .map((s) => ({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : s.id,
      tool,
      cwd: typeof s.workDir === 'string' ? s.workDir : '',
      folder: s.folderId ? (folders.find((f) => f.id === s.folderId)?.name ?? null) : null,
      color: typeof s.colorLabel === 'string' ? s.colorLabel : null
    }))
}

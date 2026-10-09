/** "just now", "5 min ago", "3 h ago", "2 d ago". `lastSeen` is epoch seconds (as stored by the API). */
export function lastSeenLabel(lastSeen: number | null | undefined, nowMs: number = Date.now()): string {
  if (!lastSeen) return 'never seen'
  const s = Math.max(0, Math.floor(nowMs / 1000 - lastSeen))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** Human text for a remote tab's connection state. */
export function remoteStatusLabel(status: string, code?: number, exitCode?: number): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…'
    case 'live':
      return 'Connected'
    case 'offline':
      return 'Offline — reconnecting…'
    case 'auth':
      return 'Sign-in needed'
    case 'ended':
      if (code === 4409) return 'Session opened in another window'
      if (exitCode !== undefined) return `Session ended (exit code ${exitCode})`
      return code === 4404 ? 'Session ended (4404)' : 'Session ended'
    default:
      return status
  }
}

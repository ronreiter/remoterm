const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

export const API_ORIGIN: string = (env.VITE_API_ORIGIN || 'https://api.remoterm.io').replace(/\/$/, '')
export const TUNNEL_DOMAIN: string = env.VITE_TUNNEL_DOMAIN || 'remoterm.io'

/** Loopback tunnel domains (used by e2e tests and local dev) are plain http/ws; everything else is TLS. */
function insecure(domain: string): boolean {
  return domain.startsWith('localhost') || domain.startsWith('127.')
}

export function agentHttpOrigin(deviceId: string, domain: string = TUNNEL_DOMAIN): string {
  return `${insecure(domain) ? 'http' : 'https'}://${deviceId}.${domain}`
}

/** Tokens never go in the URL; the attach JWT is sent as the first WS frame. */
export function agentWsUrl(
  deviceId: string,
  sessionId: string,
  mode: 'control' | 'view',
  domain: string = TUNNEL_DOMAIN
): string {
  const scheme = insecure(domain) ? 'ws' : 'wss'
  return `${scheme}://${deviceId}.${domain}/ws/attach/${encodeURIComponent(sessionId)}?mode=${mode}`
}

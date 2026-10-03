/** Attach protocol message types (spec section 9). */

export const CloseCode = {
  Unauthorized: 4401,
  NotFound: 4404,
  TooSlow: 4408,
  Replaced: 4409
} as const
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode]

export type AttachMode = 'control' | 'view'

/** Client -> server text frames. */
export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'focus' }
  | { t: 'pong' }

/** Server -> client text frames. */
export type ServerMessage =
  | { t: 'snapshot'; data: string; cols: number; rows: number }
  | { t: 'meta'; title?: string; busy?: boolean }
  | { t: 'exit'; code: number }
  | { t: 'ping' }
  | { t: 'error'; code: number; message: string }

export const PING_INTERVAL_MS = 25_000
export const AUTH_TIMEOUT_MS = 5_000
export const MAX_BUFFERED_BYTES = 1024 * 1024

/** Session metadata returned by GET /api/sessions. */
export interface SessionInfo {
  id: string
  name: string
  tool: string
  cwd: string
  folder: string | null
  color: string | null
  running: boolean
  busy: boolean
  cols: number
  rows: number
}

/** JWT claims of an access / attach token. */
export interface AccessClaims {
  sub: string
  aud: string
  iat: number
  exp: number
  jti: string
}

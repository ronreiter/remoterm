import { CloseCode } from '@remoterm/protocol'

export type CloseKind = 'reauth' | 'ended' | 'reconnect' | 'replaced' | 'closed'

export interface CloseInfo {
  kind: CloseKind
  message: string
}

/** Maps an attach WebSocket close code to the UX the terminal page shows (spec section 9/11). */
export function describeClose(code: number): CloseInfo {
  switch (code) {
    case CloseCode.Unauthorized:
      return { kind: 'reauth', message: 'Your session expired. Sign in again to continue.' }
    case CloseCode.NotFound:
      return { kind: 'ended', message: 'Session ended or is not running on this device.' }
    case CloseCode.TooSlow:
      return { kind: 'reconnect', message: 'Connection too slow. Reconnecting...' }
    case CloseCode.Replaced:
      return { kind: 'replaced', message: 'This session was opened from another window.' }
    default:
      return { kind: 'closed', message: 'Connection closed.' }
  }
}

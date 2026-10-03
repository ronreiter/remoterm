import type { ClientMessage, ServerMessage } from './messages'

export function encodeMessage(m: ClientMessage | ServerMessage): string {
  return JSON.stringify(m)
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isDim = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 10000

export function decodeClientMessage(raw: string): ClientMessage | null {
  const o = parse(raw)
  if (!o) return null
  switch (o.t) {
    case 'auth':
      return typeof o.token === 'string' ? { t: 'auth', token: o.token } : null
    case 'resize':
      return isDim(o.cols) && isDim(o.rows) ? { t: 'resize', cols: o.cols, rows: o.rows } : null
    case 'focus':
      return { t: 'focus' }
    case 'pong':
      return { t: 'pong' }
    default:
      return null
  }
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  const o = parse(raw)
  if (!o) return null
  switch (o.t) {
    case 'snapshot':
      return typeof o.data === 'string' && isDim(o.cols) && isDim(o.rows)
        ? { t: 'snapshot', data: o.data, cols: o.cols, rows: o.rows }
        : null
    case 'meta': {
      const m: ServerMessage = { t: 'meta' }
      if (typeof o.title === 'string') m.title = o.title
      if (typeof o.busy === 'boolean') m.busy = o.busy
      return m
    }
    case 'exit':
      return typeof o.code === 'number' ? { t: 'exit', code: o.code } : null
    case 'ping':
      return { t: 'ping' }
    case 'error':
      return typeof o.code === 'number' && typeof o.message === 'string'
        ? { t: 'error', code: o.code, message: o.message }
        : null
    default:
      return null
  }
}

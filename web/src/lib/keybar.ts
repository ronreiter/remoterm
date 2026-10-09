export type BarKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'ctrlc'

const ARROW: Record<'up' | 'down' | 'right' | 'left', string> = { up: 'A', down: 'B', right: 'C', left: 'D' }

/** Bytes a key-bar button sends. `appCursor` selects SS3 arrows (DECCKM), as full-screen apps expect. */
export function keyBarBytes(key: BarKey, appCursor = false): string {
  switch (key) {
    case 'esc':
      return '\x1b'
    case 'tab':
      return '\t'
    case 'ctrlc':
      return '\x03'
    default:
      return `${appCursor ? '\x1bO' : '\x1b['}${ARROW[key]}`
  }
}

/** Applies a sticky Ctrl to the first character of typed input (a -> ^A, [ -> ESC, space -> NUL). */
export function applyCtrl(text: string): string {
  if (!text) return text
  const c = text.charCodeAt(0)
  let out: number | null = null
  if (c >= 0x61 && c <= 0x7a) out = c - 0x60
  else if (c >= 0x40 && c <= 0x5f) out = c - 0x40
  else if (c === 0x20) out = 0
  return out === null ? text : String.fromCharCode(out) + text.slice(1)
}

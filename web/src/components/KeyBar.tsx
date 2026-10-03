import type { PointerEvent } from 'react'
import { keyBarBytes, type BarKey } from '../lib/keybar'

interface Props {
  ctrl: boolean
  onToggleCtrl: () => void
  /** Receives the bytes to send; `key` is passed so the caller can pick cursor-key mode. */
  onKey: (key: BarKey) => void
}

const KEYS: { key: BarKey; label: string; aria: string }[] = [
  { key: 'esc', label: 'Esc', aria: 'Escape' },
  { key: 'tab', label: 'Tab', aria: 'Tab' }
]
const ARROWS: { key: BarKey; label: string; aria: string }[] = [
  { key: 'left', label: '←', aria: 'Left' },
  { key: 'up', label: '↑', aria: 'Up' },
  { key: 'down', label: '↓', aria: 'Down' },
  { key: 'right', label: '→', aria: 'Right' }
]

// Pointer-down + preventDefault keeps focus in the terminal so the on-screen keyboard stays open.
const press = (fn: () => void) => (e: PointerEvent) => {
  e.preventDefault()
  fn()
}

const btn =
  'min-w-[2.75rem] flex-1 rounded-md border border-terminal-border bg-terminal-surface px-2 py-2.5 text-sm select-none active:bg-terminal-border'

export function KeyBar({ ctrl, onToggleCtrl, onKey }: Props) {
  return (
    <div
      className="flex gap-1.5 border-t border-terminal-border bg-terminal-bg p-1.5"
      style={{ paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
      data-testid="key-bar"
    >
      {KEYS.map((k) => (
        <button key={k.key} aria-label={k.aria} className={btn} onPointerDown={press(() => onKey(k.key))}>
          {k.label}
        </button>
      ))}
      <button
        aria-label="Control"
        aria-pressed={ctrl}
        className={`${btn} ${ctrl ? '!bg-terminal-accent text-terminal-bg' : ''}`}
        onPointerDown={press(onToggleCtrl)}
      >
        Ctrl
      </button>
      {ARROWS.map((k) => (
        <button key={k.key} aria-label={k.aria} className={btn} onPointerDown={press(() => onKey(k.key))}>
          {k.label}
        </button>
      ))}
      <button aria-label="Control C" className={btn} onPointerDown={press(() => onKey('ctrlc'))}>
        ^C
      </button>
    </div>
  )
}

export { keyBarBytes }

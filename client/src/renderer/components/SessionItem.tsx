import React, { useState, useRef, useEffect } from 'react'
import { Session, useStore, COLOR_HEX } from '../store'
import SessionContextMenu from './SessionContextMenu'
import ConfirmDialog from './ConfirmDialog'
import RemoteViewerDot from './RemoteViewerDot'

interface Props {
  session: Session
  isActive: boolean
  onClick: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onClose?: () => void
}

export default function SessionItem({ session, isActive, onClick, onRename, onDelete, onClose }: Props) {
  const isLoaded = useStore((s) => s.loadedSessionIds.has(session.id))
  const isBusy = useStore((s) => s.busySessionIds.has(session.id))
  const hasActivity = useStore((s) => s.activeTabIds.has(session.id))
  const setSessionColor = useStore((s) => s.setSessionColor)
  const restartSession = useStore((s) => s.restartSession)
  const cloneSession = useStore((s) => s.cloneSession)
  const closeTab = useStore((s) => s.closeTab)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(session.name)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<'close' | 'remove' | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.select()
    }
  }, [editing])

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditName(session.name)
    setEditing(true)
  }

  const handleSubmitRename = () => {
    if (editName.trim() && editName !== session.name) {
      onRename(editName.trim())
    }
    setEditing(false)
  }

  // grey=dead, orange=starting, blue=attention, green=ok
  const statusColor = session.status !== 'open'
    ? 'bg-terminal-subtext'
    : !isLoaded
      ? 'bg-orange-400'
      : hasActivity
        ? 'bg-blue-400'
        : 'bg-terminal-green'

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const tintBg = session.colorLabel
    ? `color-mix(in srgb, ${COLOR_HEX[session.colorLabel]} ${isActive ? 25 : 10}%, transparent)`
    : isActive
      ? 'color-mix(in srgb, var(--terminal-accent) 12%, transparent)'
      : undefined
  const borderColor = session.colorLabel ? COLOR_HEX[session.colorLabel] : undefined

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-session-id', session.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      style={{
        ...(tintBg ? { backgroundColor: tintBg } : {}),
        ...(borderColor ? { border: `1px solid ${borderColor}` } : {}),
        ...(isActive
          ? { boxShadow: `inset 0 0 0 2px ${borderColor ?? 'var(--terminal-accent)'}` }
          : {})
      }}
      className={`group relative flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer ${
        borderColor ? '' : 'border border-transparent'
      } ${
        isActive
          ? 'text-terminal-accent'
          : borderColor
            ? 'text-terminal-text'
            : 'hover:bg-terminal-bg text-terminal-text'
      }`}
    >
      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor} ${isBusy ? 'animate-pulse-dot' : ''}`} />

      {editing ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSubmitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmitRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="flex-1 bg-terminal-bg px-2 py-0.5 rounded text-sm text-terminal-text outline-none border border-terminal-accent"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex-1 min-w-0">
          <span className="text-sm truncate block" title={session.name}>{session.name}</span>
          {session.workDir && (
            <span className="text-[10px] text-terminal-subtext truncate block">
              {session.workDir.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          )}
        </div>
      )}

      <RemoteViewerDot sessionId={session.id} />

      <button
        onClick={(e) => {
          e.stopPropagation()
          setConfirm('remove')
        }}
        className="opacity-0 group-hover:opacity-100 text-terminal-subtext hover:text-terminal-red transition-all"
        title="Remove session"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
        </svg>
      </button>
      {menuPos && (
        <SessionContextMenu
          x={menuPos.x}
          y={menuPos.y}
          current={session.colorLabel}
          onPickColor={(color) => setSessionColor(session.id, color)}
          onRestart={() => restartSession(session.id)}
          onRename={() => {
            setEditName(session.name)
            setEditing(true)
          }}
          onClone={() => cloneSession(session.id)}
          onClose={() => (onClose ? onClose() : closeTab(session.id))}
          onRemove={() => setConfirm('remove')}
          onDismiss={() => setMenuPos(null)}
        />
      )}
      {confirm === 'close' && (
        <ConfirmDialog
          title="Close session?"
          message={`Close "${session.name}"? The session will move to the closed list — you can reopen it later.`}
          confirmLabel="Close"
          onConfirm={() => {
            setConfirm(null)
            if (onClose) onClose()
            else closeTab(session.id)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'remove' && (
        <ConfirmDialog
          title="Remove session?"
          message={`Permanently remove "${session.name}"? This deletes the session record and cannot be undone.`}
          confirmLabel="Remove"
          destructive
          onConfirm={() => {
            setConfirm(null)
            onDelete()
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

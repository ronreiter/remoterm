import { useStore } from '../store'

/** Small dot shown on tabs / sidebar items while at least one remote client is attached. */
export default function RemoteViewerDot({ sessionId }: { sessionId: string }) {
  const count = useStore((s) => s.remoteViewerCounts[sessionId] ?? 0)
  if (count < 1) return null
  const label = `${count} remote viewer${count === 1 ? '' : 's'}`
  return (
    <span
      data-testid="remote-viewer-dot"
      title={label}
      aria-label={label}
      className="w-2 h-2 rounded-full bg-sky-400 ring-2 ring-sky-400/30 flex-shrink-0"
    />
  )
}

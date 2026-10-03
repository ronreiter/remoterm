import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { useStore } from '../store'
import { CODING_TOOLS } from '../services/api'
import { getTheme, type ThemeId } from '@remoterm/themes'

// Open a local file path in the Monaco side pane, parsing optional :line[:col] suffix.
// Directories are routed to the OS file manager (Finder on macOS) instead — opening
// a folder in a code-editor pane has no useful behavior.
async function openFilePathInEditor(rawPath: string) {
  const m = rawPath.match(/^(.+?)(?::(\d+))?(?::\d+)?$/)
  const path = m?.[1] ?? rawPath
  const line = m?.[2] ? parseInt(m[2], 10) : undefined
  const probe = await window.electronAPI.readFile(path)
  if (probe.isDirectory) {
    window.electronAPI.openPath(path)
    return
  }
  useStore.getState().setEditorFile(path, line)
}

// Dedupe link clicks across providers. xterm can fire multiple link
// activations for a single physical click:
//   - OSC 8 linkHandler + WebLinksAddon both match a URL when a tool emits an
//     OSC 8 hyperlink whose visible text is the URL (FORCE_HYPERLINK=1)
//   - OSC 8 linkHandler + our file-path provider both match a hyperlinked path
// All providers receive the SAME MouseEvent, so we key on its timeStamp: the
// first activation for a given click runs, sibling activations for the same
// click are ignored. This is exact (unlike a wall-clock window, which both
// misses slow double-fires and wrongly suppresses genuine rapid distinct
// clicks) and covers file opens too, not just external URLs.
let lastHandledClickTs = -1
function runLinkActivationOnce(event: MouseEvent, action: () => void) {
  if (event.timeStamp === lastHandledClickTs) return
  lastHandledClickTs = event.timeStamp
  action()
}

// Track last time the document became visible. Used to suppress busy-burst
// notifications: when the OS sleeps or the window is hidden long enough that
// queued PTY output arrives in a flood, the per-session busy timers all fire
// in the same ~2s window and every tab announces "finished a task" together.
let lastVisibleAt = Date.now()
const FOCUS_BURST_WINDOW_MS = 5000
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lastVisibleAt = Date.now()
  })
}

export function useTerminal(sessionId: string | null) {
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const cleanupListenersRef = useRef<(() => void) | null>(null)

  const initTerminal = useCallback(
    (container: HTMLDivElement, onReady?: () => void) => {
      if (!sessionId || terminalRef.current) return

      const session = useStore.getState().sessions.find((s) => s.id === sessionId)

      const themeId = (useStore.getState().settings?.theme || 'dark1') as ThemeId
      const appTheme = getTheme(themeId)

      const terminal = new Terminal({
        // Required for UnicodeGraphemesAddon, which uses xterm's proposed
        // `terminal.unicode` API.
        allowProposedApi: true,
        cursorBlink: false,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        // Default to no scrollback: the AI tools run in the terminal's alternate
        // screen buffer (full-screen TUI), which doesn't use scrollback at all —
        // so retained history is wasted memory that grows over a long session.
        scrollback: useStore.getState().settings?.scrollback ?? 0,
        theme: appTheme.terminal,
        linkHandler: {
          allowNonHttpProtocols: true,
          activate: (event: MouseEvent, uri: string) => {
            runLinkActivationOnce(event, () => {
              if (uri.startsWith('file://') || uri.startsWith('/') || uri.startsWith('~/')) {
                const path = uri.replace(/^file:\/\//, '')
                openFilePathInEditor(path)
              } else {
                window.electronAPI.openExternal(uri)
              }
            })
          }
        }
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      const searchAddon = new SearchAddon()
      terminal.loadAddon(searchAddon)
      searchAddonRef.current = searchAddon

      // Upgrade Unicode width tables to v15 with grapheme awareness so emoji
      // (and emoji-ZWJ sequences) are correctly classified as wide (2 cells).
      // Without this, xterm uses Unicode 6 tables which treat many emoji as
      // width 1, and Apple Color Emoji renders at its natural size — visibly
      // overflowing the cell, especially with the WebGL renderer's atlas.
      terminal.loadAddon(new UnicodeGraphemesAddon())
      terminal.unicode.activeVersion = '15-graphemes'

      terminal.open(container)
      fitAddon.fit()

      // Auto-name from terminal title only when it's likely meaningful.
      // Many AI tools (Claude Code in particular) just emit a static product
      // name like "Claude Code", which would clobber the more useful default
      // (the cwd shortpath). Skip those generic strings; for Claude we fetch
      // the conversation summary from the JSONL below.
      terminal.onTitleChange((title) => {
        if (!title || !sessionId) return
        // Strip leading non-word characters before matching: Claude Code
        // prefixes its title with a status emoji + space (e.g. "✳ Claude
        // Code"), which would otherwise slip past an exact-match filter and
        // overwrite the cwd-derived default with the bare product name.
        const cleaned = title.replace(/^[^\w]+/, '').trim().toLowerCase()
        const generic = ['claude code', 'claude', 'gemini', 'codex', 'aider', 'opencode']
        if (generic.includes(cleaned)) return
        useStore.getState().autoRenameSession(sessionId, title)
      })

      // WebGL renderer: fastest by a wide margin. The oversized-emoji bug that
      // pushed us off WebGL in v1.27 was actually a Unicode width-table issue,
      // fixed above by UnicodeGraphemesAddon (emoji are now 2-cell wide so
      // WebGL's atlas rasterizes them at the right size). The other WebGL
      // failure mode — stale glyph columns after resize / heavy redraw bursts —
      // is mitigated by clearing the texture atlas on every resize (below).
      let webglAddon: WebglAddon | null = null
      try {
        webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon?.dispose()
          webglAddon = null
        })
        terminal.loadAddon(webglAddon)
      } catch {
        // WebGL not available — fall back to default DOM renderer.
      }

      // Web links: click to open URLs in browser
      terminal.loadAddon(new WebLinksAddon((event, uri) => {
        runLinkActivationOnce(event as MouseEvent, () => window.electronAPI.openExternal(uri))
      }))

      // File path links: click to open local paths
      terminal.registerLinkProvider({
        provideLinks(lineNumber, callback) {
          const line = terminal.buffer.active.getLine(lineNumber - 1)
          if (!line) return callback(undefined)
          const text = line.translateToString()
          const links: { startIndex: number; length: number; text: string }[] = []
          // Path optionally followed by :line or :line:col
          const re = /(?:^|[\s('"=])((\/[\w.@+\-][\w.@+\-/]*|~\/[\w.@+\-/]+)(?::\d+(?::\d+)?)?)(?=[\s)'",;]|$)/g
          let match: RegExpExecArray | null
          while ((match = re.exec(text)) !== null) {
            const fullMatch = match[1]
            const idx = text.indexOf(fullMatch, match.index)
            links.push({ startIndex: idx, length: fullMatch.length, text: fullMatch })
          }
          if (links.length === 0) return callback(undefined)
          callback(links.map((l) => ({
            range: { start: { x: l.startIndex + 1, y: lineNumber }, end: { x: l.startIndex + l.length + 1, y: lineNumber } },
            text: l.text,
            activate(event: MouseEvent, linkText: string) {
              runLinkActivationOnce(event, () => openFilePathInEditor(linkText))
            }
          })))
        }
      })

      terminalRef.current = terminal
      fitAddonRef.current = fitAddon

      let readyCalled = false
      let busyTimer: ReturnType<typeof setTimeout> | null = null
      let busyStartTimer: ReturnType<typeof setTimeout> | null = null
      let outputBytes = 0
      let lastInputTime = 0
      let lastResizeAt = 0
      const startedAt = Date.now()
      let inOsc = false
      let suppressNotifications = true // suppress during initial load
      const BUSY_THRESHOLD = 500 // bytes of output before showing busy indicator
      const INPUT_ECHO_WINDOW = 150 // ms to ignore output after input (echo)
      const RESIZE_QUIET_WINDOW = 2000 // ms — suppress busy detection after a resize-triggered redraw
      const SPAWN_QUIET_WINDOW = 3000 // ms — suppress busy detection during initial spawn output

      // Persistent scroll state — survives across async write batches
      let stayAtBottom = true

      // Detect user scrolling via wheel events on the terminal container
      container.addEventListener('wheel', () => {
        requestAnimationFrame(() => {
          const buf = terminal.buffer.active
          stayAtBottom = buf.baseY === 0 || buf.viewportY >= buf.baseY - 1
        })
      })

      // Allow notifications after 15s (enough for all sessions to finish loading)
      setTimeout(() => { suppressNotifications = false }, 15000)
      const removeOutput = window.electronAPI.onLocalPtyOutput((sid, data) => {
        if (sid !== sessionId) return
        if (!readyCalled) {
          readyCalled = true
          useStore.getState().markSessionLoaded(sessionId)
          onReady?.()
        }
        terminal.write(data, () => {
          if (stayAtBottom) {
            terminal.scrollToBottom()
          }
        })
        // Skip busy/activity detection during quiet windows — output during these
        // windows is from app/terminal redraws, not from a real task running:
        //   - just after a window/fullscreen resize (TTY redraws on SIGWINCH)
        //   - during initial spawn (banners, prompts, restore-session output)
        const now = Date.now()
        if (now - lastResizeAt < RESIZE_QUIET_WINDOW) return
        if (now - startedAt < SPAWN_QUIET_WINDOW) return
        // Track busy state — only mark busy after sustained output, ignore input echo
        const isEcho = now - lastInputTime < INPUT_ECHO_WINDOW
        if (!isEcho) outputBytes += data.length
        if (outputBytes >= BUSY_THRESHOLD && !useStore.getState().busySessionIds.has(sessionId)) {
          useStore.getState().markSessionBusy(sessionId)
        } else if (!busyStartTimer && outputBytes < BUSY_THRESHOLD) {
          busyStartTimer = setTimeout(() => {
            busyStartTimer = null
            if (outputBytes >= BUSY_THRESHOLD) {
              useStore.getState().markSessionBusy(sessionId)
            }
          }, 500)
        }
        if (busyTimer) clearTimeout(busyTimer)
        busyTimer = setTimeout(() => {
          const wasBusy = useStore.getState().busySessionIds.has(sessionId)
          outputBytes = 0
          useStore.getState().markSessionIdle(sessionId)
          // Suppress busy-burst events: if the window was just unhidden, all
          // sessions can flush queued output and finish "together" — don't
          // mark finish/activity/notify so the sidebar doesn't reorder and
          // the user doesn't get a wall of notifications.
          const inFocusBurst = Date.now() - lastVisibleAt < FOCUS_BURST_WINDOW_MS
          if (inFocusBurst) return
          // Record finish time for sorting (sidebar list)
          if (wasBusy) useStore.getState().markSessionFinished(sessionId)
          // Mark tab activity and notify when a real task finishes (was busy, now idle)
          if (wasBusy && useStore.getState().activeSessionId !== sessionId) {
            if (!suppressNotifications) useStore.getState().markTabActivity(sessionId)
            if (!suppressNotifications && useStore.getState().settings?.notifications !== false) {
              const session = useStore.getState().sessions.find((s) => s.id === sessionId)
              window.electronAPI.showNotification('Remoterm', `${session?.name || 'Session'} finished a task`, sessionId)
            }
          }
        }, 2000)
        // Detect standalone BEL (\x07) not inside OSC sequences for notifications
        for (let i = 0; i < data.length; i++) {
          const ch = data.charCodeAt(i)
          if (ch === 0x1b && i + 1 < data.length && data.charCodeAt(i + 1) === 0x5d) {
            inOsc = true // ESC ] starts OSC
            i++ // skip ]
          } else if (inOsc && ch === 0x07) {
            inOsc = false // BEL terminates OSC — ignore
          } else if (ch === 0x07 && !inOsc) {
            // Standalone BEL — notify if background tab
            if (useStore.getState().activeSessionId !== sessionId) {
              const session = useStore.getState().sessions.find((s) => s.id === sessionId)
              window.electronAPI.showNotification('Remoterm', `${session?.name || 'Session'} needs attention`, sessionId)
            }
          }
        }
      })

      const removeExit = window.electronAPI.onLocalPtyExit((sid, exitCode) => {
        if (sid !== sessionId) return
        useStore.getState().markSessionUnloaded(sessionId)
        useStore.getState().markSessionClosed(sessionId)
        terminal.write(`\r\n\x1b[31mProcess exited (code ${exitCode}).\x1b[0m\r\n`)
        // Notify on process exit when window is hidden
        if (document.hidden) {
          const session = useStore.getState().sessions.find((s) => s.id === sessionId)
          window.electronAPI.showNotification('Remoterm', `${session?.name || 'Session'} exited (code ${exitCode})`, sessionId)
        }
      })

      const removeToolDetected = window.electronAPI.onToolSessionDetected?.((sid, toolId) => {
        if (sid !== sessionId) return
        useStore.getState().setToolSessionId(sessionId, toolId)
      }) || (() => {})

      // Periodically pull a meaningful auto-name from the tool's own session
      // log (Claude Code: first user message in the JSONL). Stops once we
      // successfully rename. Cleared in the cleanup chain below.
      let summaryPollInterval: ReturnType<typeof setInterval> | null = null
      const pollSummary = async () => {
        const sess = useStore.getState().sessions.find((s) => s.id === sessionId)
        if (!sess || sess.nameIsUserSet) {
          if (summaryPollInterval) clearInterval(summaryPollInterval)
          summaryPollInterval = null
          return
        }
        const tool = useStore.getState().settings?.codingTool
        if (!tool || !sess.toolSessionId) return
        const summary = await window.electronAPI.getToolSessionSummary?.(tool, sess.toolSessionId)
        if (summary && summary !== sess.name) {
          useStore.getState().autoRenameSession(sessionId, summary)
          if (summaryPollInterval) clearInterval(summaryPollInterval)
          summaryPollInterval = null
        }
      }
      summaryPollInterval = setInterval(pollSummary, 5000)
      // Try once shortly after spawn so we don't wait the full interval.
      setTimeout(pollSummary, 1500)

      cleanupListenersRef.current = () => {
        removeOutput()
        removeExit()
        removeToolDetected()
        if (summaryPollInterval) clearInterval(summaryPollInterval)
      }

      const settings = useStore.getState().settings
      const toolDef = CODING_TOOLS.find((t) => t.id === settings?.codingTool) || CODING_TOOLS[0]
      let command: string
      if (session?.toolSessionId && toolDef.resumeArg) {
        // Resume existing session
        command = `${toolDef.command} ${toolDef.resumeArg} ${session.toolSessionId}`
      } else if (toolDef.id === 'claude') {
        // New Claude session: generate a UUID and pass --session-id so we always know it
        const newToolSessionId = crypto.randomUUID()
        command = `${toolDef.command} --session-id ${newToolSessionId}`
        // Save immediately so it persists even if the app quits before detection
        useStore.getState().setToolSessionId(sessionId, newToolSessionId)
      } else {
        command = toolDef.command
      }
      // Force Claude into full-screen TUI mode (alternate screen buffer). There
      // is no --tui launch flag, but the `tui` settings key can be merged in for
      // this session via --settings. In full-screen mode Claude manages its own
      // scrolling and never writes to the terminal scrollback, so the default
      // scrollback of 0 (see terminal init above) costs no history.
      if (toolDef.id === 'claude') {
        command += ` --settings '{"tui":"fullscreen"}'`
      }
      if (session?.skipPermissions) {
        command += ' --enable-auto-mode'
      }
      // Claude's native worktree flag — only on first spawn, not when resuming
      // (the resumed session already lives in the previously-created worktree).
      if (session?.useWorktree && toolDef.id === 'claude' && !session?.toolSessionId) {
        command += ' --worktree'
      }
      console.log(`[PTY_SPAWN] session=${sessionId} toolSessionId=${session?.toolSessionId} command=${command}`)
      const loadZshrc = settings?.loadZshrc ?? true
      window.electronAPI.spawnLocalPty(sessionId, command, session?.workDir || '~', loadZshrc).then((result) => {
        if (!result.ok) {
          terminal.write(`\r\n\x1b[31mFailed to start: ${result.error}\x1b[0m\r\n`)
        } else {
          window.electronAPI.resizeLocalPty(sessionId, terminal.cols, terminal.rows)
          if (result.reattached) {
            useStore.getState().markSessionLoaded(sessionId)
            onReady?.()
          }
        }
      })

      // Intercept Shift+Enter to send ESC + CR instead of just CR.
      // xterm.js sends \r for both Enter and Shift+Enter by default, but CLI tools
      // like Claude Code detect ESC-prefixed CR (meta key) as a newline signal.
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.key === 'Enter' && event.shiftKey) {
          if (event.type === 'keydown') {
            lastInputTime = Date.now()
            window.electronAPI.sendLocalPtyInput(sessionId, '\x1b\r')
          }
          return false
        }
        return true
      })

      terminal.onData((data) => {
        lastInputTime = Date.now()
        window.electronAPI.sendLocalPtyInput(sessionId, data)
      })

      const resizeObserver = new ResizeObserver(() => {
        // Stamp before notifying the PTY so the redraw output that flows back
        // (often >500 bytes from full-screen apps) is treated as a quiet redraw
        // rather than a real task.
        lastResizeAt = Date.now()
        fitAddon.fit()
        if (stayAtBottom) {
          terminal.scrollToBottom()
        }
        // Flush the WebGL glyph atlas — without this we occasionally get stale
        // columns of text drawn over fresh content during the post-resize
        // redraw burst from full-screen TUIs.
        webglAddon?.clearTextureAtlas()
        window.electronAPI.resizeLocalPty(sessionId, terminal.cols, terminal.rows)
      })
      resizeObserver.observe(container)

      return () => {
        resizeObserver.disconnect()
        cleanupListenersRef.current?.()
        cleanupListenersRef.current = null
        terminal.dispose()
        terminalRef.current = null
        fitAddonRef.current = null
        searchAddonRef.current = null
      }
    },
    [sessionId]
  )

  useEffect(() => {
    return () => {
      cleanupListenersRef.current?.()
      cleanupListenersRef.current = null
      if (sessionId) {
        window.electronAPI.killLocalPty(sessionId)
        useStore.getState().markSessionUnloaded(sessionId)
      }
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
    }
  }, [sessionId])

  // Update terminal theme and font size when settings change
  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, prev) => {
      if (!terminalRef.current) return
      if (state.settings?.theme !== prev.settings?.theme) {
        const themeId = (state.settings?.theme || 'dark1') as ThemeId
        const appTheme = getTheme(themeId)
        terminalRef.current.options.theme = appTheme.terminal
      }
      if (state.fontSize !== prev.fontSize) {
        terminalRef.current.options.fontSize = state.fontSize
        fitAddonRef.current?.fit()
      }
      if (state.settings?.scrollback !== prev.settings?.scrollback) {
        terminalRef.current.options.scrollback = state.settings?.scrollback ?? 0
      }
    })
    return unsubscribe
  }, [])

  return { initTerminal, terminalRef, searchAddonRef }
}

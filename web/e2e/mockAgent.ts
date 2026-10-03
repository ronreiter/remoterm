import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

export interface MockSession {
  id: string
  name: string
  running: boolean
}

export interface AgentConnection {
  sessionId: string
  mode: string
  /** Token from the first text frame (never in the URL). */
  authToken: string | null
  url: string
  ws: WebSocket
}

const SNAPSHOT = 'hello from mock\r\n$ '

/** A stand-in for the Remoterm host agent: GET /api/sessions + WS /ws/attach/:id. */
export class MockAgent {
  server!: Server
  wss!: WebSocketServer
  sessions: MockSession[] = []
  /** Raw input bytes received (binary frames), as strings. */
  inputs: string[] = []
  droppedViewInputs: string[] = []
  connections: AgentConnection[] = []
  sessionRequests: { authorization: string | undefined }[] = []

  constructor(private port: number) {
    this.reset()
  }

  reset() {
    this.inputs = []
    this.droppedViewInputs = []
    this.connections = []
    this.sessionRequests = []
    this.sessions = [
      { id: 's1', name: 'zsh - project', running: true },
      { id: 's2', name: 'build', running: true },
      { id: 'dead', name: 'old session', running: false }
    ]
  }

  async start() {
    this.server = createServer((req, res) => this.http(req, res))
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws, req) => this.onWs(ws, req))
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', r))
  }

  async stop() {
    for (const c of this.wss.clients) c.terminate()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  private cors(req: IncomingMessage) {
    return {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': 'authorization',
      'access-control-allow-methods': 'GET, OPTIONS',
      vary: 'origin'
    }
  }

  private http(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const headers = this.cors(req)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end()
      return
    }
    if (req.url === '/api/sessions') {
      this.sessionRequests.push({ authorization: req.headers.authorization })
      if (!req.headers.authorization?.startsWith('Bearer attach-')) {
        res.writeHead(401, headers).end()
        return
      }
      res
        .writeHead(200, { ...headers, 'content-type': 'application/json' })
        .end(JSON.stringify(this.sessions.map((s) => ({ ...s, tool: 'shell', cwd: '/Users/me/project', folder: null, color: null, busy: false, cols: 80, rows: 24 }))))
      return
    }
    res.writeHead(404, headers).end()
  }

  private onWs(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://x')
    const m = /^\/ws\/attach\/([^/]+)$/.exec(url.pathname)
    const conn: AgentConnection = {
      sessionId: m ? decodeURIComponent(m[1]) : '',
      mode: url.searchParams.get('mode') ?? '',
      authToken: null,
      url: req.url ?? '',
      ws
    }
    this.connections.push(conn)
    ws.on('message', (data, isBinary) => {
      if (conn.authToken === null) {
        const msg = isBinary ? null : JSON.parse(data.toString())
        if (!msg || msg.t !== 'auth' || typeof msg.token !== 'string' || !msg.token.startsWith('attach-')) {
          ws.close(4401, 'unauthorized')
          return
        }
        conn.authToken = msg.token
        const s = this.sessions.find((x) => x.id === conn.sessionId)
        if (!s || !s.running) {
          ws.close(4404, 'not found')
          return
        }
        ws.send(JSON.stringify({ t: 'snapshot', data: SNAPSHOT, cols: 80, rows: 24 }))
        return
      }
      if (isBinary) {
        // Like the real host, view-mode input is dropped; we record it separately to prove the client never sends it.
        if (conn.mode === 'control') this.inputs.push(data.toString())
        else this.droppedViewInputs.push(data.toString())
      }
    })
  }

  /** Push PTY output to every attached client. */
  output(text: string) {
    for (const c of this.connections) if (c.ws.readyState === 1) c.ws.send(Buffer.from(text))
  }
}

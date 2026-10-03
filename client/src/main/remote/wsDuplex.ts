import { Duplex } from 'stream'
import type { WebSocket } from 'ws'

/** Exposes a WebSocket's binary frames as a byte stream (text frames are ignored). */
export class WsDuplex extends Duplex {
  constructor(private ws: WebSocket) {
    super()
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      this.feed(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data))
    })
    ws.on('close', () => this.push(null))
    ws.on('error', (e) => this.destroy(e))
  }

  /** Injects bytes received before the stream was created. */
  feed(buf: Buffer): void {
    this.push(buf)
  }

  _read(): void {
    /* data is pushed as frames arrive */
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (this.ws.readyState !== this.ws.OPEN) return cb(new Error('websocket not open'))
    this.ws.send(chunk, { binary: true }, cb)
  }

  _final(cb: (e?: Error | null) => void): void {
    this.ws.close(1000, 'ssh closed')
    cb()
  }

  _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    try {
      if (this.ws.readyState === this.ws.OPEN) this.ws.close(1000, 'ssh closed')
    } catch {
      /* ignore */
    }
    cb(err)
  }
}

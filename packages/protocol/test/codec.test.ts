import { describe, it, expect } from 'vitest'
import { encodeMessage, decodeClientMessage, decodeServerMessage, CloseCode } from '../src'

describe('codec', () => {
  it('round-trips client messages', () => {
    const m = { t: 'resize', cols: 80, rows: 24 } as const
    expect(decodeClientMessage(encodeMessage(m))).toEqual(m)
    expect(decodeClientMessage(encodeMessage({ t: 'auth', token: 'x' }))).toEqual({ t: 'auth', token: 'x' })
    expect(decodeClientMessage(encodeMessage({ t: 'focus' }))).toEqual({ t: 'focus' })
    expect(decodeClientMessage(encodeMessage({ t: 'pong' }))).toEqual({ t: 'pong' })
  })

  it('round-trips server messages', () => {
    const m = { t: 'snapshot', data: 'hi\x1b[0m', cols: 10, rows: 5 } as const
    expect(decodeServerMessage(encodeMessage(m))).toEqual(m)
    expect(decodeServerMessage(encodeMessage({ t: 'exit', code: 3 }))).toEqual({ t: 'exit', code: 3 })
    expect(decodeServerMessage(encodeMessage({ t: 'ping' }))).toEqual({ t: 'ping' })
  })

  it('rejects malformed and unknown frames', () => {
    expect(decodeClientMessage('not json')).toBeNull()
    expect(decodeClientMessage('{"t":"nope"}')).toBeNull()
    expect(decodeClientMessage('{"t":"auth"}')).toBeNull()
    expect(decodeClientMessage('{"t":"resize","cols":"a","rows":2}')).toBeNull()
    expect(decodeClientMessage('{"t":"resize","cols":0,"rows":2}')).toBeNull()
    expect(decodeServerMessage('{"t":"snapshot","data":1}')).toBeNull()
    expect(decodeServerMessage('[]')).toBeNull()
  })

  it('exposes spec close codes', () => {
    expect(CloseCode).toEqual({ Unauthorized: 4401, NotFound: 4404, TooSlow: 4408, Replaced: 4409 })
  })
})

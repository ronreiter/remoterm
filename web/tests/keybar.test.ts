import { describe, expect, it } from 'vitest'
import { applyCtrl, keyBarBytes } from '../src/lib/keybar'
import { describeClose } from '../src/lib/closeCodes'

describe('keyBarBytes', () => {
  it('maps keys to terminal bytes', () => {
    expect(keyBarBytes('esc')).toBe('\x1b')
    expect(keyBarBytes('tab')).toBe('\t')
    expect(keyBarBytes('ctrlc')).toBe('\x03')
    expect(keyBarBytes('up')).toBe('\x1b[A')
    expect(keyBarBytes('down')).toBe('\x1b[B')
    expect(keyBarBytes('right')).toBe('\x1b[C')
    expect(keyBarBytes('left')).toBe('\x1b[D')
  })

  it('uses SS3 arrows in application cursor mode', () => {
    expect(keyBarBytes('up', true)).toBe('\x1bOA')
    expect(keyBarBytes('left', true)).toBe('\x1bOD')
    expect(keyBarBytes('esc', true)).toBe('\x1b')
  })
})

describe('applyCtrl (sticky Ctrl)', () => {
  it('turns letters into control bytes', () => {
    expect(applyCtrl('a')).toBe('\x01')
    expect(applyCtrl('C')).toBe('\x03')
    expect(applyCtrl('z')).toBe('\x1a')
    expect(applyCtrl('d')).toBe('\x04')
  })

  it('handles punctuation control chars and leaves the rest alone', () => {
    expect(applyCtrl('[')).toBe('\x1b')
    expect(applyCtrl(' ')).toBe('\x00')
    expect(applyCtrl('\\')).toBe('\x1c')
    expect(applyCtrl('1')).toBe('1')
    expect(applyCtrl('\r')).toBe('\r')
  })

  it('only modifies the first character of a multi-char chunk (paste/IME)', () => {
    expect(applyCtrl('ab')).toBe('\x01b')
  })
})

describe('describeClose', () => {
  it('classifies the protocol close codes', () => {
    expect(describeClose(4401).kind).toBe('reauth')
    expect(describeClose(4404).kind).toBe('ended')
    expect(describeClose(4404).message).toMatch(/ended|not running/i)
    expect(describeClose(4408).kind).toBe('reconnect')
    expect(describeClose(4409).kind).toBe('replaced')
  })

  it('treats normal and unknown closes generically', () => {
    expect(describeClose(1000).kind).toBe('closed')
    expect(describeClose(1006).kind).toBe('closed')
  })
})

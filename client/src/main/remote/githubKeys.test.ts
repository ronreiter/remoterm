import { describe, it, expect } from 'vitest'
import { utils } from 'ssh2'
import { GithubKeys, parseAuthorizedKeys } from './githubKeys'

const a = utils.generateKeyPairSync('ed25519')
const b = utils.generateKeyPairSync('ed25519')
const blob = (pub: string) => parseAuthorizedKeys(pub)[0]

describe('GithubKeys', () => {
  it('caches for the ttl, then refetches', async () => {
    let t = 0
    let n = 0
    const k = new GithubKeys({ now: () => t, missRefetchMs: 0, fetchText: async () => (n++, a.public) })
    expect(await k.isAllowed('u', blob(a.public))).toBe(true)
    expect(await k.isAllowed('u', blob(a.public))).toBe(true)
    expect(n).toBe(1)
    t += 61 * 60_000
    expect(await k.isAllowed('u', blob(a.public))).toBe(true)
    expect(n).toBe(2)
  })

  it('refetches on a miss and picks up new keys; throttles repeated misses', async () => {
    let t = 0
    let n = 0
    let text = a.public
    const k = new GithubKeys({ now: () => t, missRefetchMs: 10_000, fetchText: async () => (n++, text) })
    expect(await k.isAllowed('u', blob(b.public))).toBe(false)
    expect(n).toBe(2) // initial load + forced refetch
    expect(await k.isAllowed('u', blob(b.public))).toBe(false)
    expect(n).toBe(2) // throttled
    text = `${a.public}\n# c\n${b.public}\n`
    t += 11_000
    expect(await k.isAllowed('u', blob(b.public))).toBe(true)
    expect(n).toBe(3)
  })

  it('serves stale keys when GitHub is unreachable and denies when nothing is cached', async () => {
    let fail = false
    let t = 0
    const k = new GithubKeys({
      now: () => t,
      fetchText: async () => {
        if (fail) throw new Error('down')
        return a.public
      }
    })
    expect(await k.isAllowed('u', blob(a.public))).toBe(true)
    fail = true
    t += 2 * 60 * 60_000
    expect(await k.isAllowed('u', blob(a.public))).toBe(true)
    const none = new GithubKeys({
      fetchText: async () => {
        throw new Error('down')
      }
    })
    expect(await none.isAllowed('u', blob(a.public))).toBe(false)
  })

  it('ignores garbage lines', () => {
    expect(parseAuthorizedKeys('nonsense\n\n' + a.public)).toHaveLength(1)
  })
})

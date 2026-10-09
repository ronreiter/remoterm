export type HostRef = { kind: 'name'; name: string } | { kind: 'id'; id: string }

export class HostError extends Error {}

/**
 * Parses the `%h` ssh passes to ProxyCommand: `<device>.remoterm` (device name)
 * or `<deviceId>.<tunnelDomain>` (e.g. `ab12cd.remoterm.io`).
 */
export function parseHost(host: string, tunnelDomain: string): HostRef {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  const td = '.' + tunnelDomain.toLowerCase()
  if (h.endsWith(td)) {
    const id = h.slice(0, -td.length)
    if (/^[a-z0-9]+$/.test(id)) return { kind: 'id', id }
  } else if (h.endsWith('.remoterm')) {
    const name = h.slice(0, -'.remoterm'.length)
    if (name) return { kind: 'name', name }
  }
  throw new HostError(`unrecognized host "${host}" (expected <device>.remoterm or <deviceId>.${tunnelDomain})`)
}

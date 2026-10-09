import { networkInterfaces } from 'node:os'

/** Loopback and link-local IPv4 ranges the surface must never bind. */
const LOOPBACK_PREFIX = '127.'

/**
 * Enumerate non-internal IPv4 interfaces as `{ name, address }` pairs.
 * @returns Every IPv4 address this host currently holds on a usable interface.
 */
export function listIpv4Interfaces() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith(LOOPBACK_PREFIX)) continue
      found.push({ name, address: entry.address })
    }
  }
  return found
}

/**
 * Select the interface the remote surface binds to.
 *
 * An explicit address wins. Otherwise the configured name substring selects the
 * ZeroTier interface, and a single candidate resolves on its own. Zero matches
 * throws instead of falling back to every interface: a surface that reaches the
 * agent's shell must never widen its reach because detection failed.
 *
 * @param configured - `listenAddress` from the plugin config.
 * @param hint - `interfaceHint` from the plugin config.
 * @param interfaces - Injectable interface list; defaults to the live host.
 * @returns The selected interface name and address.
 * @throws When no interface matches, or several match without an explicit address.
 */
export function resolveBindAddress(configured, hint, interfaces = listIpv4Interfaces()) {
  if (configured !== '') {
    const match = interfaces.find((iface) => iface.address === configured)
    return { name: match?.name ?? 'configured', address: configured }
  }
  const needle = hint.toLowerCase()
  const named = interfaces.filter((iface) => iface.name.toLowerCase().includes(needle))
  if (named.length === 1) return named[0]
  if (named.length === 0) {
    throw new Error(
      `zt-remote: no interface name matches ${JSON.stringify(hint)}; ` +
        `set listenAddress explicitly. Interfaces: ${interfaces.map((i) => `${i.name}=${i.address}`).join(', ') || 'none'}`,
    )
  }
  throw new Error(
    `zt-remote: ${named.length} interfaces match ${JSON.stringify(hint)} (${named
      .map((i) => i.address)
      .join(', ')}); set listenAddress explicitly`,
  )
}

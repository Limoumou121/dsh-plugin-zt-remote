/**
 * Resolve the loopback origin of the Host Web UI the proxy forwards to.
 *
 * The desktop Host chooses its port per launch, so a fixed default goes stale the
 * next time the application starts: every proxied request then reaches a closed
 * port and the Web UI answers `webui/host-session-unavailable`. The live
 * `webServer` service reports the port actually in use, and the Host's own desktop
 * half composes its authenticated URL the same way.
 *
 * @param explicit - `hostBase` from the plugin config; a non-empty value wins.
 * @param webServer - The `webServer` service, when the composition provides one.
 * @param fallback - Origin used when neither source is available.
 * @returns The origin without a trailing slash, and which source produced it.
 */
export function resolveHostBase(explicit, webServer, fallback = 'http://127.0.0.1:19387') {
  const configured = typeof explicit === 'string' ? explicit.trim().replace(/\/+$/u, '') : ''
  if (configured !== '') return { base: configured, source: 'config' }

  const port = Number(webServer?.port)
  if (Number.isInteger(port) && port > 0 && port <= 65_535) {
    const protocol = typeof webServer?.protocol === 'string' && webServer.protocol !== '' ? webServer.protocol : 'http:'
    const scheme = protocol.endsWith(':') ? protocol : `${protocol}:`
    return { base: `${scheme}//127.0.0.1:${port}`, source: 'webServer' }
  }

  return { base: fallback, source: 'fallback' }
}

/**
 * Read the `webServer` service without requiring it.
 *
 * The service is absent in a headless composition, so this stays a lookup rather
 * than an injected dependency: a missing service must not fail activation.
 *
 * @param ctx - Plugin context.
 * @returns The service, or undefined.
 */
export function readWebServer(ctx) {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    return ctx.get('webServer')
  } catch {
    return undefined
  }
}

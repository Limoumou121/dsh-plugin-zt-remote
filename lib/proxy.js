import { request as httpRequest } from 'node:http'

/**
 * Reverse proxy from the ZeroTier listener to the Host's own loopback Web UI.
 *
 * The official browser UI is served by the Host on loopback, behind a
 * launch-token exchange that mints a cookie bound to the loopback authority.
 * This proxy performs that exchange once for the process and then replays the
 * cookie on every forwarded request while presenting the loopback authority to
 * the Host, so a paired phone sees the real Web UI — routes, assets and API
 * included — without the Host ever listening off loopback.
 *
 * The proxy holds the Host cookie. A phone never receives or needs it: the
 * plugin's own device token, carried as a cookie, is the only credential the
 * phone presents.
 */

/** Response headers the proxy regenerates or withholds. */
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

/** Upper bound on a request body the proxy buffers before forwarding it. */
const MAX_FORWARDED_BODY_BYTES = 64 * 1024 * 1024

/**
 * Acquire and hold the Host's browser-session cookie.
 *
 * `authenticatedUrl` appends the live process token; requesting that URL answers
 * `303` with the `set-cookie` the Host will accept for the loopback authority.
 *
 * @param options - Host base and the URL builder the Host composition provides.
 * @param options.hostBase - Loopback origin of the Host Web UI, without a trailing slash.
 * @param options.authenticatedUrl - `ctx.connection.authenticatedUrl`.
 * @param options.log - Logger for a failed refresh.
 * @returns The cookie handle.
 */
export function createHostSession({ hostBase, authenticatedUrl, log }) {
  const authority = hostBase.replace(/^https?:\/\//u, '')
  let cookie

  /** Exchange the process token for a fresh cookie. */
  async function acquire() {
    const authenticated = authenticatedUrl(`${hostBase}/`)
    const response = await fetch(authenticated, { redirect: 'manual' })
    const setCookie = response.headers.get('set-cookie')
    await response.body?.cancel()
    if (response.status !== 303 || setCookie === null) {
      throw new Error(`zt-remote: host session exchange failed with ${response.status}`)
    }
    const end = setCookie.indexOf(';')
    cookie = end < 0 ? setCookie : setCookie.slice(0, end)
    return cookie
  }

  return {
    authority,
    hostBase,
    /** Current cookie, exchanging for one when absent. */
    async get() {
      if (cookie === undefined) {
        try {
          await acquire()
        } catch (error) {
          log?.(String(error))
          return undefined
        }
      }
      return cookie
    },
    /** Force a refresh, for example after the Host reports the session expired. */
    async refresh() {
      cookie = undefined
      return this.get()
    },
  }
}

/**
 * Forward one HTTP request to the Host Web UI.
 *
 * @param incoming - Phone request.
 * @param response - Phone response.
 * @param options - Target authority, cookie, and path rewriting.
 * @param options.hostBase - Loopback origin of the Host Web UI.
 * @param options.cookie - Cookie value the Host accepts.
 * @param options.path - Request target to send, which may differ from the phone's path.
 * @param options.requestFreshCookie - Exchanges for a new Host session so a stale one can be retried.
 * @param options.retry - False on the retry itself, so it cannot loop.
 * @returns Completion of the forwarded exchange.
 */
export async function forwardRequest(incoming, response, { hostBase, cookie, path, requestFreshCookie, retry }) {
  const target = new URL(hostBase)
  const headers = {}
  for (const [name, value] of Object.entries(incoming.headers)) {
    /* `accept-encoding` is dropped so the Host answers identity-encoded: Node's fetch
       decodes a compressed response transparently, and passing its `content-encoding`
       on would make the browser decode an already-decoded body. */
    if (['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'sec-fetch-site', 'origin', 'accept-encoding'].includes(name)) continue
    if (value !== undefined) headers[name] = value
  }
  /* The Host authenticates by its own authority, so the proxy presents it and
     holds the cookie; the phone's own credential was checked before arrival. */
  headers.host = target.host
  headers.cookie = cookie
  headers['sec-fetch-site'] = 'same-origin'
  /* Origin is an absolute origin, and the Host compares it with its own: a
     forwarded phone origin reads as cross-origin and the request is reset. */
  if (incoming.headers.origin !== undefined) headers.origin = target.origin

  /* Read the body once so the forwarded request carries an exact Content-Length
     instead of chunked framing, and so a session refresh can replay it. */
  const body = await readBody(incoming, headers)

  return new Promise((resolve) => {
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path,
        headers,
      },
      (upstreamResponse) => {
        const expired = upstreamResponse.statusCode === 401 && typeof requestFreshCookie === 'function' && retry !== false
        if (!expired) {
          const outgoing = {}
          for (const [name, value] of Object.entries(upstreamResponse.headers)) {
            if (STRIPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue
            outgoing[name] = value
          }
          /* The body is streamed as received, so a decoded `content-encoding` would
             describe bytes the client no longer gets. */
          if (outgoing['content-encoding'] !== undefined) delete outgoing['content-encoding']
          response.writeHead(upstreamResponse.statusCode ?? 502, outgoing)
          upstreamResponse.pipe(response)
          upstreamResponse.on('end', resolve)
          return
        }
        /* The Host session went stale between requests: take a fresh one and retry
           once. The retry replays the same raw target, so query-shaped bundle URLs
           survive the refresh too. */
        upstreamResponse.resume()
        void (async () => {
          try {
            const refreshed = await requestFreshCookie()
            await forwardRequest(incoming, response, {
              hostBase,
              cookie: refreshed,
              path,
              requestFreshCookie,
              retry: false,
            })
          } catch (error) {
            if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            response.end(`zt-remote: host session refresh failed: ${String(error?.message ?? error)}`)
          }
          resolve()
        })()
      },
    )
    upstream.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`zt-remote: host request failed [${error?.code ?? 'unknown'}] ${String(error?.message ?? error)}`)
      resolve()
    })
    if (body.length > 0) upstream.write(body)
    upstream.end()
  })
}

/**
 * Read a request body into one buffer and declare its exact length.
 *
 * Chunked framing reaches the Host the same way, but an exact length keeps the
 * forwarded request replayable after a session refresh and avoids a framing
 * difference between a browser upload and a plain RPC call.
 *
 * @param incoming - Phone request.
 * @param headers - Mutable forwarded headers; a length is added when a body exists.
 * @returns The body bytes, empty for a bodyless request.
 */
function readBody(incoming, headers) {
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return Promise.resolve(Buffer.alloc(0))
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    incoming.on('data', (chunk) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_FORWARDED_BODY_BYTES) {
        reject(new Error(`forwarded body exceeds ${MAX_FORWARDED_BODY_BYTES} bytes`))
        incoming.destroy()
      }
    })
    incoming.on('end', () => {
      const body = Buffer.concat(chunks)
      if (body.length > 0) headers['content-length'] = String(body.length)
      resolve(body)
    })
    incoming.on('error', reject)
  })
}


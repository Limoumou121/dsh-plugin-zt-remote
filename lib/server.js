import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describeFailure, readWorkspaces, workspacesOf, readHistory } from './remote.js'
import { forwardRequest } from './proxy.js'
import { pipeUpgrade } from './upgrade-tunnel.js'
import { projectHistory, projectSessionRow, projectWorkspace, deriveTitle, titleOf } from './projection.js'

/**
 * Phone page source, read once at module load. The asset is plain HTML, so it
 * cannot be imported as a module the way a JavaScript template could.
 */
const PHONE_UI = readFileSync(fileURLToPath(new URL('../assets/ui.html', import.meta.url)), 'utf8')

/**
 * Remote management page. The Host's directory picker resolves to its native
 * backend on a loopback bind, so it opens a dialog on the machine running dsh and
 * cannot serve a remote operator; this page adds a workspace by typed path instead.
 */
const MANAGE_UI = readFileSync(fileURLToPath(new URL('../assets/manage.html', import.meta.url)), 'utf8')

/**
 * Typography the phone panel adds to the official Web UI.
 *
 * The shell has no width breakpoints and fixes its session rows at 14px/20px, which
 * is dense on a phone; this sheet tightens type below 768px only. The panel links it
 * on mount, so a desktop window at full width keeps the shipped sizing.
 */
const PHONE_CSS = readFileSync(fileURLToPath(new URL('../assets/phone.css', import.meta.url)), 'utf8')

/** Endpoints that never require a device token. */
const PUBLIC_PATHS = new Set(['/hello', '/pair'])

/** Cookie the phone carries after it proves a device token, so navigations work. */
const DEVICE_COOKIE = 'dsh-zt-token'

/**
 * Normalize a configured path prefix to a leading-slash, no-trailing-slash form.
 * @param value - Configured `webuiPrefix`.
 * @returns The normalized prefix, or an empty string when the proxy is disabled.
 */
function normalizePrefix(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * Read the token from a Cookie header without a full cookie parser.
 * @param header - Raw `Cookie` header.
 * @param name - Cookie name to read.
 * @returns The value, or undefined.
 */
function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Send one JSON response with the headers every reply shares.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body, or undefined for an empty body.
 * @param headers - Extra response headers.
 */
function sendJson(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

/**
 * Read a bounded JSON request body.
 * @param req - Node request.
 * @param limit - Maximum accepted byte length.
 * @returns The parsed value, or undefined when absent or unparsable.
 * @throws When the body exceeds the limit.
 */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Extract the bearer token from a request.
 * @param req - Node request.
 * @returns The token, or undefined when none was presented.
 */
function bearerToken(req) {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7)
  return undefined
}

/**
 * Whether a request's ultimate peer is this machine.
 *
 * A reverse proxy in front of the listener reports the real peer in
 * `x-forwarded-for`; honoring it only ever *widens* the loopback exemption, and
 * that exemption still requires the operator key or the operator's own machine,
 * so a forged header cannot read pairing material.
 *
 * @param req - Node request.
 * @returns True for loopback peers.
 */
function fromLoopback(req) {
  const forwarded = req.headers['x-forwarded-for']
  const address = (typeof forwarded === 'string' && forwarded !== '' ? forwarded.split(',')[0].trim() : '') || req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Name an auto-admitted device after the peer that reached the listener.
 * @param req - Node request.
 * @returns A roster label that hints at the source address.
 */
function provisionalDeviceName(req) {
  const forwarded = req.headers['x-forwarded-for']
  const address =
    (typeof forwarded === 'string' && forwarded !== '' ? forwarded.split(',')[0].trim() : '') || req.socket?.remoteAddress || 'unknown'
  return `访问设备 ${address}`
}

/**
 * Origin-root asset paths that some client plugins inject without the served prefix.
 *
 * The whale pet is the live example: its widget URL is absolute, so under `webuiPrefix`
 * the shell asks for `/dsh-whale/widget.js` while the asset answers at
 * `<prefix>/dsh-whale/widget.js`.
 */
const PREFIXED_ASSET_ROOTS = ['/dsh-whale']

/**
 * Build the request handler for the ZeroTier surface.
 *
 * @param deps - Caller, pairing registry, stream opener, approval desk, and effective config.
 * @param deps.caller - Remote caller built by `createCaller`.
 * @param deps.registry - Pairing and device registry.
 * @param deps.openFollow - Opens one session follow stream.
 * @param deps.desk - Pending approval asks and their phone answers.
 * @param deps.streams - Live event-stream writers the desk broadcasts through.
 * @param deps.config - Effective plugin config.
 * @param deps.log - Logger for non-fatal failures.
 * @returns An async `(req, res)` handler.
 */
export function createHandler(deps) {
  const { caller, gateway, registry, openFollow, desk, streams, config, log } = deps
  /* Owner Peer every in-process Gateway call must name. */
  const peer = deps.peer
  const operatorKey = deps.operatorKey ?? ''
  const hostSession = deps.hostSession
  const webuiPrefix = normalizePrefix(config.webuiPrefix)

  /**
   * Admit a paired device from either the bearer header or the session cookie the
   * login route sets. A cookie is the only credential a browser navigation or an
   * EventSource can carry, so the proxied official UI relies on it.
   * @param req - Node request.
   * @returns The matching device, or undefined.
   */
  const deviceOf = async (req) => {
    const bearer = bearerToken(req)
    if (bearer !== undefined) return registry.authenticate(bearer)
    const cookie = cookieValue(req.headers.cookie, DEVICE_COOKIE)
    if (cookie === undefined) return undefined
    return registry.authenticate(cookie)
  }

  /**
   * Admit an operator request.
   *
   * The listener binds the ZeroTier address, so in the shipped configuration a
   * loopback peer never appears and the operator key is the only way in: the key
   * is written to a 0600 file beside the pairing URL. The loopback shortcut stays
   * for the case where a deployment rebinds to loopback and the key file is not
   * to hand.
   *
   * @param req - Node request.
   * @param url - Parsed request URL.
   * @returns True when this peer may read pairing material.
   */
  const admitOperator = (req, url) => {
    if (fromLoopback(req)) return true
    const header = req.headers['x-zt-operator-key']
    const presented = typeof header === 'string' && header !== '' ? header : url.searchParams.get('key')
    if (operatorKey === '' || typeof presented !== 'string') return false
    const expected = Buffer.from(operatorKey)
    const actual = Buffer.from(presented)
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
  }

  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://zt-remote.invalid')
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'request/invalid-url' } })
      return
    }
    const path = url.pathname

    /* With auto access the root is the Web UI itself, so the address works like a
       local URL. The small pairing page stays available for a deliberate pairing. */
    if (req.method === 'GET' && (path === '/' || path === '/index.html') && config.autoAccess !== false && webuiPrefix !== '') {
      res.writeHead(303, { 'cache-control': 'no-store', location: `${webuiPrefix}/` })
      res.end()
      return
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(PHONE_UI)
      return
    }

    if (req.method === 'GET' && path === '/hello') {
      sendJson(res, 200, {
        ok: true,
        value: {
          plugin: 'dsh-plugin-zt-remote',
          protocol: 1,
          build: 'r30-operator-peer',
          /* Which access model is live: autoAccess admits any reachable peer, so the
             pairing page is the entry only while it is off. */
          access: config.autoAccess === false ? 'paired' : 'auto',
          /* Which Host origin the proxy talks to: the resolved value, so a stale or
             mismatched port is visible without reading logs. */
          hostBase: hostSession?.hostBase ?? null,
          capabilities: ['workspaces', 'sessions', 'prompt', 'follow', 'approvals', 'webui'],
        },
      })
      return
    }

    if (path.startsWith('/operator/')) {
      if (!admitOperator(req, url)) {
        sendJson(res, 403, { ok: false, error: { code: 'operator/key-required' } })
        return
      }
      if (req.method === 'GET' && path === '/operator/code') {
        const issued = registry.hasLiveCode() ? registry.currentCode() : registry.issueCode(config.pairCodeTtlSeconds)
        sendJson(res, 200, { ok: true, value: issued })
        return
      }
      if (req.method === 'GET' && path === '/operator/devices') {
        sendJson(res, 200, { ok: true, value: { devices: registry.roster() } })
        return
      }
      if (req.method === 'POST' && path === '/operator/revoke') {
        const body = await readJsonBody(req, config.bodyLimitBytes)
        const removed = await registry.revoke(typeof body?.deviceId === 'string' ? body.deviceId : undefined)
        registry.clearCode()
        sendJson(res, 200, { ok: true, value: { removed } })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'operator/not-found' } })
      return
    }

    if (req.method === 'POST' && path === '/pair') {
      if (!registry.admitAttempt()) {
        sendJson(res, 429, { ok: false, error: { code: 'pair/rate-limited' } })
        return
      }
      let body
      try {
        body = await readJsonBody(req, config.bodyLimitBytes)
      } catch {
        sendJson(res, 413, { ok: false, error: { code: 'request/too-large' } })
        return
      }
      const paired = await registry.pair(body?.code, body?.secret, body?.deviceName, config.deviceTokenDays)
      if (paired === undefined) {
        sendJson(res, 401, { ok: false, error: { code: 'pair/refused' } })
        return
      }
      log?.('zt-remote: paired device', paired.device.name)
      sendJson(res, 200, {
        ok: true,
        value: { token: paired.token, device: { id: paired.device.id, name: paired.device.name } },
      })
      return
    }

    if (PUBLIC_PATHS.has(path)) {
      sendJson(res, 404, { ok: false, error: { code: 'request/not-found' } })
      return
    }

    /* Prove a device token by exchanging it for a cookie, then land on the official UI. */
    if (path === `${webuiPrefix}/login` && req.method === 'GET') {
      const candidate = url.searchParams.get('token')
      const device = candidate === null ? undefined : await registry.authenticate(candidate)
      if (device === undefined) {
        sendJson(res, 401, { ok: false, error: { code: 'auth/required' } })
        return
      }
      res.writeHead(303, {
        'cache-control': 'no-store',
        location: webuiPrefix === '' ? '/' : `${webuiPrefix}/`,
        'set-cookie': `${DEVICE_COOKIE}=${candidate}; Path=/; HttpOnly; SameSite=Lax`,
      })
      res.end()
      return
    }

    /* Auto access: a peer that can reach this listener is admitted the way the
       loopback URL admits the local browser, and receives a device row so the
       operator can still see and revoke it. */
    const autoAccess = config.autoAccess !== false && config.webui !== false && hostSession !== undefined
    let device = await deviceOf(req)
    if (device === undefined && autoAccess) {
      const minted = await registry.issueDevice(provisionalDeviceName(req), config.deviceTokenDays)
      device = await registry.authenticate(minted.token)
      if (device !== undefined) {
        res.setHeader('set-cookie', `${DEVICE_COOKIE}=${minted.token}; Path=/; HttpOnly; SameSite=Lax`)
      }
    }
    if (device === undefined) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/required' } })
      return
    }

    /* Typography the sidebar panel links into the official page. `?list=1` answers the
       rules as data, so the acceptance script can check them without a browser. */
    if (req.method === 'GET' && path === `${webuiPrefix}/phone.css`) {
      if (url.searchParams.get('list') === '1') {
        const rules = [...PHONE_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
          selector: match[1].trim().replace(/\s+/gu, ' '),
          declarations: match[2].trim().replace(/\s+/gu, ' '),
        }))
        sendJson(res, 200, { ok: true, value: { rules } })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(PHONE_CSS)
      return
    }

    /* The plugin's own management page, for the operations the Host UI cannot serve
       remotely (a typed workspace path instead of the native directory chooser). */
    if (req.method === 'GET' && path === `${webuiPrefix}/manage`) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(MANAGE_UI)
      return
    }

    /* Everything the plugin does not answer itself is the official Web UI. The SPA
       resolves its own asset and API URLs against the origin root, so those paths
       are proxied too; the handlers above already claimed the plugin's own paths. */
    const underPrefix = webuiPrefix !== '' && (path === webuiPrefix || path.startsWith(`${webuiPrefix}/`))
    /* The SPA's bundle URLs carry a `?` query that lists every plugin module, so the
       forward target keeps the raw request target — a parsed path drops that query. */
    const rawTarget = req.url ?? '/'
    const queryAt = rawTarget.indexOf('?')
    const query = queryAt < 0 ? '' : rawTarget.slice(queryAt)
    const withoutQuery = queryAt < 0 ? rawTarget : rawTarget.slice(0, queryAt)
    const stripped =
      webuiPrefix !== '' && withoutQuery.startsWith(`${webuiPrefix}/`) ? withoutQuery.slice(webuiPrefix.length) : withoutQuery
    /* Some client plugins inject an origin-root asset URL, which omits the prefix and
       would 404 here; the same asset answers under the prefix. */
    const prefixedAsset =
      webuiPrefix !== '' && !underPrefix && PREFIXED_ASSET_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
        ? `${webuiPrefix}${path}`
        : path
    const hostTarget = `${stripped.startsWith('/') ? stripped : `/${stripped}`}${query}`
    const isApiPath = path === '/api' || path.startsWith('/api/') || path.startsWith('/plugins/')
    if (config.webui !== false && hostSession !== undefined && (underPrefix || isApiPath || prefixedAsset !== path || webuiPrefix === '')) {
      const cookie = await hostSession.get()
      if (cookie === undefined) {
        sendJson(res, 503, { ok: false, error: { code: 'webui/host-session-unavailable' } })
        return
      }
      /* Marks the branch that rewrites an origin-root asset URL, so a live 404 can be
         attributed to this proxy rather than the Host. */
      const target = prefixedAsset === path ? hostTarget : `${prefixedAsset}${query}`
      if (prefixedAsset !== path) res.setHeader('x-zt-remote-prefixed-asset', target)
      await forwardRequest(req, res, {
        hostBase: hostSession.hostBase,
        cookie,
        path: target,
        requestFreshCookie: () => hostSession.refresh(),
      })
      return
    }

    try {
      if (req.method === 'GET' && path === '/workspaces') {
        const baseline = await readWorkspaces(gateway, undefined, peer)
        const list = workspacesOf(baseline).map(projectWorkspace).filter(Boolean)
        const diagnostic =
          url.searchParams.get('diagnostic') === '1'
            ? { baselineType: typeof baseline, keys: baseline !== null && typeof baseline === 'object' ? Object.keys(baseline) : [], raw: JSON.stringify(baseline).slice(0, 800) }
            : undefined
        sendJson(res, 200, { ok: true, value: { workspaces: list, ...(diagnostic === undefined ? {} : { diagnostic }) } })
        return
      }

      if (req.method === 'POST' && path === '/workspaces') {
        const body = await readJsonBody(req, config.bodyLimitBytes)
        if (typeof body?.path !== 'string' || body.path === '') {
          sendJson(res, 400, { ok: false, error: { code: 'workspace/path-required' } })
          return
        }
        const value = await caller.createWorkspace(body.path)
        sendJson(res, 200, {
          ok: true,
          value: { workspace: projectWorkspace(value?.workspace), created: value?.created === true },
        })
        return
      }

      if (req.method === 'GET' && path === '/sessions') {
        const cursor = url.searchParams.get('cursor') ?? undefined
        const value = await caller.listSessions(cursor)
        /* `session/list` answers `{ items }`; the other arm keeps a rename from
           silently emptying the roster, the way `workspace.list` did. */
        const rows = Array.isArray(value?.items) ? value.items : Array.isArray(value?.sessions) ? value.sessions : []
        const sessions = rows.map(projectSessionRow).filter(Boolean)
        sendJson(res, 200, { ok: true, value: { sessions, cursor: value?.cursor } })
        return
      }

      if (req.method === 'POST' && path === '/sessions') {
        const body = await readJsonBody(req, config.bodyLimitBytes)
        const request = {}
        if (typeof body?.workspaceId === 'string') request.workspaceId = body.workspaceId
        if (typeof body?.cwd === 'string') request.cwd = body.cwd
        if (typeof body?.agentPreset === 'string') request.agentPreset = body.agentPreset
        const value = await caller.createSession(request)
        sendJson(res, 200, { ok: true, value: { sessionId: value?.sessionId, agentPreset: value?.agentPreset } })
        return
      }

      const match = /^\/sessions\/([^/]+)\/(messages|prompt|cancel|events)$/.exec(path)
      if (match !== null) {
        const sessionId = decodeURIComponent(match[1])
        const action = match[2]

        if (req.method === 'GET' && action === 'messages') {
          const records = await readHistory(gateway, sessionId, undefined, peer)
          sendJson(res, 200, {
            ok: true,
            value: {
              messages: projectHistory(records),
              hasMore: false,
              title: titleOf(records) ?? deriveTitle(records),
            },
          })
          return
        }

        if (req.method === 'POST' && action === 'prompt') {
          const body = await readJsonBody(req, config.bodyLimitBytes)
          if (typeof body?.text !== 'string' || body.text.trim() === '') {
            sendJson(res, 400, { ok: false, error: { code: 'prompt/text-required' } })
            return
          }
          const value = await caller.promptSession({
            requestId: `zt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            mode: body.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text: body.text }],
          })
          sendJson(res, 200, { ok: true, value: { accepted: value?.accepted === true } })
          return
        }

        if (req.method === 'POST' && action === 'cancel') {
          sendJson(res, 200, { ok: true, value: await caller.cancelSession(sessionId) })
          return
        }

        if (req.method === 'GET' && action === 'events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-content-type-options': 'nosniff',
          })
          const abort = new AbortController()
          req.on('close', () => abort.abort())

          /* Flush the response head before awaiting the log stream: without this the
             client waits for the first body write, so an idle session shows nothing. */
          res.flushHeaders()

          const write = (event, payload) => {
            if (!abort.signal.aborted && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
          }
          const onDesk = (notification) => write('approval', notification)

          try {
            for (const ask of desk?.list?.() ?? []) write('approval', { type: 'pending', ask })
            const frames = await openFollow({ address: { kind: 'session', sessionId }, assistantStream: true }, abort.signal)
            /* Subscribe only once the log stream is live: a phone that answered an
               approval while this handler was awaiting would otherwise miss its settle. */
            streams?.add(onDesk)
            for await (const frame of frames) {
              if (abort.signal.aborted) break
              if (frame?.type === 'snapshot') {
                write('snapshot', { messages: projectHistory(frame.records) })
                continue
              }
              write('frame', frame)
            }
          } catch (error) {
            if (!abort.signal.aborted) log?.('zt-remote: follow stream ended', error)
          } finally {
            streams?.delete(onDesk)
            res.end()
          }
          return
        }
      }

      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        })
        const abort = new AbortController()
        req.on('close', () => abort.abort())
        /* Same reason as the session stream: the head must reach the phone now. */
        res.flushHeaders()
        const write = (event, payload) => {
          if (!abort.signal.aborted && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        const onDesk = (notification) => write('approval', notification)
        try {
          for (const ask of desk?.list?.() ?? []) write('approval', { type: 'pending', ask })
          /* Subscribe after the baseline so a settle racing this handler is still delivered. */
          streams?.add(onDesk)
          await new Promise((resolve) => {
            abort.signal.addEventListener('abort', resolve, { once: true })
            const keepalive = setInterval(() => {
              if (abort.signal.aborted) return
              res.write(': keepalive\n\n')
            }, 20_000)
            abort.signal.addEventListener('abort', () => clearInterval(keepalive), { once: true })
          })
        } finally {
          streams?.delete(onDesk)
          res.end()
        }
        return
      }

      if (req.method === 'GET' && path === '/approvals') {
        sendJson(res, 200, { ok: true, value: { pending: desk?.list?.() ?? [] } })
        return
      }

      if (req.method === 'POST' && path === '/answers') {
        const body = await readJsonBody(req, config.bodyLimitBytes)
        if (typeof body?.requestId !== 'string' || typeof body?.allow !== 'boolean') {
          sendJson(res, 400, { ok: false, error: { code: 'answers/requestId-required' } })
          return
        }
        const outcome = desk?.answer(body.requestId, body.allow)
        if (outcome === undefined) {
          sendJson(res, 409, { ok: false, error: { code: 'answers/not-pending' } })
          return
        }
        sendJson(res, 200, { ok: true, value: { outcome } })
        return
      }

      sendJson(res, 404, { ok: false, error: { code: 'request/not-found' } })
    } catch (error) {
      const failure = describeFailure(error)
      sendJson(res, failure.status, {
        ok: false,
        error: { code: failure.code, message: String(error?.message ?? error) },
      })
    }
  }
}

/**
 * Build the WebSocket upgrade handler for the proxied official Web UI.
 *
 * The UI opens upgrades for its live streams, so an upgrade that is not
 * forwarded leaves the page rendered but silent.
 *
 * @param deps - Same dependency bag as {@link createHandler}.
 * @returns A synchronous `(req, socket, head)` handler.
 */
export function createUpgradeHandler(deps) {
  const { registry, config, log } = deps
  const hostSession = deps.hostSession
  const webuiPrefix = normalizePrefix(config.webuiPrefix)

  return function upgrade(req, socket, head) {
    /* `trace` records each admission decision: a refused upgrade leaves no HTTP
       response to inspect, so the reason is the only evidence there is. */
    const trace = deps.trace ?? (() => {})
    let path
    try {
      path = new URL(req.url ?? '/', 'http://zt-remote.invalid').pathname
    } catch {
      trace('reject: unparsable url')
      socket.destroy()
      return
    }
    const isApiPath = path.startsWith('/api/') || path.startsWith('/plugins/')
    const underPrefix = webuiPrefix !== '' && path.startsWith(`${webuiPrefix}/`)
    if (config.webui === false || hostSession === undefined || !(isApiPath || underPrefix || webuiPrefix === '')) {
      trace(`reject: webui=${config.webui} session=${hostSession !== undefined} api=${isApiPath} prefix=${underPrefix}`)
      socket.destroy()
      return
    }
    const device = cookieValue(req.headers.cookie, DEVICE_COOKIE)
    const bearer = bearerToken(req)
    const candidate = bearer ?? device
    if (candidate === undefined) {
      trace('reject: no device credential on the upgrade')
      socket.destroy()
      return
    }
    trace(`admitted candidate (bearer=${bearer !== undefined} cookie=${device !== undefined})`)
    ;(async () => {
      if ((await registry.authenticate(candidate)) === undefined) {
        trace('reject: device credential unknown or expired')
        socket.destroy()
        return
      }
      trace('device authenticated')
      const cookie = await hostSession.get()
      if (cookie === undefined) {
        trace('reject: host session cookie unavailable')
        socket.destroy()
        return
      }
      trace(`host cookie acquired (${cookie.slice(0, 16)}…)`)
      /* Strip only the path prefix: the raw query of an upgrade target must survive. */
      const rawUpgrade = req.url ?? '/'
      const upgradeQueryAt = rawUpgrade.indexOf('?')
      const upgradePath = upgradeQueryAt < 0 ? rawUpgrade : rawUpgrade.slice(0, upgradeQueryAt)
      const upgradeQuery = upgradeQueryAt < 0 ? '' : rawUpgrade.slice(upgradeQueryAt)
      const strippedUpgrade = webuiPrefix !== '' && upgradePath.startsWith(`${webuiPrefix}/`) ? upgradePath.slice(webuiPrefix.length) : upgradePath
      const target = `${strippedUpgrade.startsWith('/') ? strippedUpgrade : `/${strippedUpgrade}`}${upgradeQuery}`
      log?.('zt-remote: proxying upgrade', target)
      /* Pass plain fields: spreading an IncomingMessage does not carry `headers`,
         which lives on its prototype, and the tunnel needs them. */
      pipeUpgrade({ method: req.method, url: target, headers: req.headers }, socket, head, {
        hostBase: hostSession.hostBase,
        cookie,
        log,
        connectSocket: deps.connectSocket,
      })
    })().catch((error) => {
      log?.('zt-remote: upgrade failed', error)
      socket.destroy()
    })
  }
}

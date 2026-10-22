import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { PairingRegistry } from '../auth.js'
import { ApprovalDesk } from '../approvals.js'
import { createCaller } from '../remote.js'
import { createHandler, createUpgradeHandler } from '../server.js'
import { createHostSession } from '../proxy.js'

const OPERATOR_KEY = 'test-operator-key'
const cookieHeader = (token) => ({ cookie: `dsh-zt-token=${token}`, 'content-type': 'application/json' })

/** Minimal Host stand-in: an index page, an API route, and a token exchange. */
async function startFakeHost() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} host=${req.headers.host} cookie=${req.headers.cookie ?? '-'}`)
    if (req.url === '/?token=launch-token') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-abc=session-value; Path=/; HttpOnly', location: './' })
      res.end()
      return
    }
    if (req.url === '/api/hello') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, from: 'host-api' }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>official</title></head><body><div id="root"></div></body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function startSurface(hostBase, options = {}) {
  const registry = new PairingRegistry()
  registry.seed('phone', 'device-token', 30)
  const gateway = {
    async invoke(request) {
      if (request.method === 'create') {
        return { workspace: { workspaceId: 'w2', path: request.args.request.path, sessionIds: [] }, created: true }
      }
      return {}
    },
    async stream(request) {
      if (request.method === 'follow' && request.namespace === 'workspace') {
        return (async function* baseline() {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
        })()
      }
      return (async function* () {})()
    },
  }
  const hostSession = createHostSession({
    hostBase,
    authenticatedUrl: (base) => `${base}?token=launch-token`,
    log: () => {},
  })
  const deps = {
    caller: createCaller(gateway),
    gateway,
    registry,
    openFollow: gateway.stream,
    desk: new ApprovalDesk({ publish: () => {}, timeoutMs: 1000 }),
    streams: new Set(),
    operatorKey: OPERATOR_KEY,
    hostSession,
    config: {
      bodyLimitBytes: 65536,
      historyPageLimit: 60,
      deviceTokenDays: 30,
      pairCodeTtlSeconds: 600,
      webui: true,
      autoAccess: options.autoAccess ?? false,
      hostBase,
      webuiPrefix: '/ui',
    },
    log: () => {},
  }
  const handler = createHandler(deps)
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  server.on('upgrade', createUpgradeHandler(deps))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('auto access opens the official UI with no pairing step and records the device', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base, { autoAccess: true })
  try {
    const root = await fetch(`${surface.base}/`, { redirect: 'manual' })
    assert.equal(root.status, 303)
    assert.equal(root.headers.get('location'), '/ui/')

    /* No cookie, no token: the UI must still answer, and the reply hands out a device row. */
    const page = await fetch(`${surface.base}/ui/`, { redirect: 'manual' })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /official/)
    const cookie = page.headers.get('set-cookie') ?? ''
    assert.match(cookie, /dsh-zt-token=/)
    assert.match(cookie, /HttpOnly/)

    /* The SPA's own API path is open the same way. */
    const api = await fetch(`${surface.base}/api/hello`)
    assert.equal(api.status, 200)
    assert.deepEqual(await api.json(), { ok: true, from: 'host-api' })

    /* Every auto-admitted peer is visible so the operator can revoke it. */
    const devices = await fetch(`${surface.base}/operator/devices`, { headers: { 'x-zt-operator-key': OPERATOR_KEY } })
    const roster = (await devices.json()).value.devices
    assert.ok(roster.some((device) => device.name.startsWith('访问设备')), 'the roster names the peer address')
  } finally {
    await surface.close()
    await host.close()
  }
})

test('auto access can be turned off, restoring the pairing gate', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base, { autoAccess: false })
  try {
    const root = await fetch(`${surface.base}/`, { redirect: 'manual' })
    assert.equal(root.status, 200, 'the pairing page answers when auto access is off')
    const page = await fetch(`${surface.base}/ui/`, { redirect: 'manual' })
    assert.equal(page.status, 401)
  } finally {
    await surface.close()
    await host.close()
  }
})

test('the shell is served unchanged while the plugin page answers', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base, { autoAccess: true })
  try {
    const page = await fetch(`${surface.base}/ui/`)
    const html = await page.text()
    /* The floating management link is gone: the sidebar panel entry replaced it, so
       the proxied shell must arrive byte-for-byte as the Host served it. */
    assert.match(html, /id="root"/)
    assert.doesNotMatch(html, /远程管理/)

    const manage = await fetch(`${surface.base}/ui/manage`)
    const manageHtml = await manage.text()
    assert.equal(manage.status, 200)
    assert.match(manageHtml, /按路径添加工作区/)
    assert.equal(host.seen.some((line) => line.includes('/ui/manage')), false, 'the Host never serves the plugin page')
  } finally {
    await surface.close()
    await host.close()
  }
})

test('the served shell carries no injected management anchor', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base, { autoAccess: true })
  try {
    const shell = await (await fetch(`${surface.base}/ui/`)).text()
    assert.doesNotMatch(shell, /<a [^>]*href="\/ui\/manage"/, 'no anchor may be injected into the Host shell')
    assert.doesNotMatch(shell, /position:fixed;right:12px;bottom:12px/, 'no injected style may remain on the shell')

    /* The standalone page stays a served document rather than a rewrite of the shell. */
    assert.equal((await fetch(`${surface.base}/ui/manage`)).status, 200)
  } finally {
    await surface.close()
    await host.close()
  }
})

test('a typed path creates a workspace through the plugin route', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base, { autoAccess: true })
  try {
    const cookie = (await (await fetch(`${surface.base}/ui/`)).headers.get('set-cookie') ?? '').split(';')[0]
    const created = await fetch(`${surface.base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ path: 'D:\proj' }),
    })
    assert.equal(created.status, 200)
    const value = (await created.json()).value
    assert.equal(value.created, true)
    assert.equal(value.workspace.workspaceId, 'w2')
  } finally {
    await surface.close()
    await host.close()
  }
})

test('an origin-root asset URL is proxied with the prefix stripped', async () => {
  /* The whale pet injects `/dsh-whale/widget.js`; the Host serves it at its own root,
     so the prefix only decides that the request is proxied, never what the Host is
     asked for. Forwarding the prefixed path made the Host answer 404. */
  const host = await startFakeHost()
  const surface = await startSurface(host.base, { autoAccess: true })
  try {
    const cookie = (await (await fetch(`${surface.base}/ui/`)).headers.get('set-cookie') ?? '').split(';')[0]
    const response = await fetch(`${surface.base}/dsh-whale/widget.js`, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.equal(
      host.seen.some((line) => line.startsWith('GET /dsh-whale/widget.js')),
      true,
      `host saw: ${host.seen.join(' | ')}`,
    )
    assert.equal(
      host.seen.some((line) => line.startsWith('GET /ui/dsh-whale/widget.js')),
      false,
      'the Host is never asked for the prefix',
    )
    assert.equal(response.headers.get('x-zt-remote-prefixed-asset'), '/ui/dsh-whale/widget.js')
  } finally {
    await surface.close()
    await host.close()
  }
})

test('the official UI is proxied under the prefix for a paired device', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base)
  try {
    const denied = await fetch(`${surface.base}/ui/`)
    assert.equal(denied.status, 401, 'no device credential must be refused before proxying')

    const page = await fetch(`${surface.base}/ui/`, { headers: cookieHeader('device-token') })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /official/)
    assert.match(host.seen.at(-1), /host=127\.0\.0\.1:/, 'the Host must see its own authority')
    assert.match(host.seen.at(-1), /cookie=dsh-auth-abc=session-value/, 'the proxy replays the Host session cookie')
  } finally {
    await surface.close()
    await host.close()
  }
})

test('the login route exchanges a device token for a cookie', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base)
  try {
    const refused = await fetch(`${surface.base}/ui/login?token=wrong`, { redirect: 'manual' })
    assert.equal(refused.status, 401)

    const accepted = await fetch(`${surface.base}/ui/login?token=device-token`, { redirect: 'manual' })
    assert.equal(accepted.status, 303)
    assert.equal(accepted.headers.get('location'), '/ui/')
    const cookie = accepted.headers.get('set-cookie') ?? ''
    assert.match(cookie, /dsh-zt-token=device-token/)
    assert.match(cookie, /HttpOnly/)

    /* The cookie alone must then open the UI, with no Authorization header. */
    const viaCookie = await fetch(`${surface.base}/ui/`, { headers: { cookie: 'dsh-zt-token=device-token' } })
    assert.equal(viaCookie.status, 200)
  } finally {
    await surface.close()
    await host.close()
  }
})

test('the SPA origin-root API paths are proxied too', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base)
  try {
    const denied = await fetch(`${surface.base}/api/hello`)
    assert.equal(denied.status, 401)

    const response = await fetch(`${surface.base}/api/hello`, { headers: cookieHeader('device-token') })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, from: 'host-api' })
    assert.match(host.seen.at(-1), /GET \/api\/hello/)
  } finally {
    await surface.close()
    await host.close()
  }
})

test('the plugin keeps its own paths when the proxy is on', async () => {
  const host = await startFakeHost()
  const surface = await startSurface(host.base)
  try {
    const hello = await fetch(`${surface.base}/hello`)
    assert.equal((await hello.json()).value.plugin, 'dsh-plugin-zt-remote')
    const notFound = await fetch(`${surface.base}/workspaces`, { headers: cookieHeader('device-token') })
    assert.equal(notFound.status, 200, 'the plugin route answers, not the Host page')
    const hostRequests = host.seen.filter((line) => line.includes('/workspaces')).length
    assert.equal(hostRequests, 0, 'the Host must never see the plugin own paths')
  } finally {
    await surface.close()
    await host.close()
  }
})

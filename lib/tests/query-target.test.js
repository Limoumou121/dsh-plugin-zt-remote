import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PairingRegistry } from '../auth.js'
import { ApprovalDesk } from '../approvals.js'
import { createCaller } from '../remote.js'
import { createHandler } from '../server.js'
import { createHostSession } from '../proxy.js'

const OPERATOR_KEY = 'op-key'

/** A Host stand-in that echoes the request target it received. */
async function startEchoHost() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    if (req.url === '/?token=launch') {
      res.writeHead(303, { 'set-cookie': 'dsh-auth=session; Path=/' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(req.url)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) }
}

async function startSurface(hostBase) {
  const registry = new PairingRegistry()
  registry.seed('phone', 'device-token', 30)
  const gateway = {
    async invoke() {
      return {}
    },
    async stream(request) {
      if (request.namespace === 'workspace') {
        return (async function* () {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
        })()
      }
      return (async function* () {})()
    },
  }
  const hostSession = createHostSession({ hostBase, authenticatedUrl: (base) => `${base}?token=launch`, log: () => {} })
  const server = createServer((req, res) => {
    createHandler({
      caller: createCaller(gateway),
      gateway,
      registry,
      openFollow: gateway.stream,
      desk: new ApprovalDesk({ publish: () => {}, timeoutMs: 1000 }),
      streams: new Set(),
      operatorKey: OPERATOR_KEY,
      hostSession,
      config: { bodyLimitBytes: 65536, historyPageLimit: 60, deviceTokenDays: 30, pairCodeTtlSeconds: 600, webui: true, autoAccess: true, hostBase, webuiPrefix: '/ui' },
      log: () => {},
    })(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

test('a plugin-bundle query target survives the proxy unchanged', async () => {
  const host = await startEchoHost()
  const surface = await startSurface(host.base)
  try {
    /* This is the exact shape the shell uses: the bundle list lives in the query. */
    const target = '/ui/plugins/??@deepseek-ai/dsh-client-modules/client.js,@deepseek-ai/dsh-api-gateway/client.js&rev=abc123'
    const response = await fetch(`${surface.base}${target}`)
    assert.equal(response.status, 200, 'the bundle request must not be dropped by URL parsing')
    assert.equal(await response.text(), '/plugins/??@deepseek-ai/dsh-client-modules/client.js,@deepseek-ai/dsh-api-gateway/client.js&rev=abc123')
    assert.equal(host.seen.at(-1), '/plugins/??@deepseek-ai/dsh-client-modules/client.js,@deepseek-ai/dsh-api-gateway/client.js&rev=abc123')
  } finally {
    await surface.close()
    await host.close()
  }
})

test('ordinary paths and their queries keep working', async () => {
  const host = await startEchoHost()
  const surface = await startSurface(host.base)
  try {
    assert.equal(await (await fetch(`${surface.base}/ui/assets/index.js?v=1`)).text(), '/assets/index.js?v=1')
    assert.equal(await (await fetch(`${surface.base}/ui/api/session/list`)).text(), '/api/session/list')
    assert.equal(await (await fetch(`${surface.base}/ui/`)).text(), '/')
  } finally {
    await surface.close()
    await host.close()
  }
})

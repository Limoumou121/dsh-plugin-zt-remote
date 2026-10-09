import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PairingRegistry } from '../auth.js'
import { ApprovalDesk } from '../approvals.js'
import { createCaller } from '../remote.js'
import { createHandler } from '../server.js'

/** Operator key the tests present; the plugin's listener is never reachable over loopback. */
const OPERATOR_KEY = 'test-operator-key'

/** Wire-shaped fake of the Typert Gateway: records calls and answers like the Host. */
function fakeGateway() {
  const calls = []
  const gateway = {
    calls,
    async invoke(request) {
      calls.push(request)
      const key = `${request.namespace}/${request.method}`
      if (key === 'workspace/create') {
        if (request.args.request.path === '') throw Object.assign(new Error('path required'), { code: 'gateway/arguments-invalid' })
        return { workspace: { workspaceId: 'w2', path: request.args.request.path, sessionIds: [] }, created: true }
      }
      if (key === 'session/list') {
        /* The gateway rejects a wrong wire field name, and the real result is `{ items }`. */
        if (!('_request' in request.args)) throw Object.assign(new Error('missing _request'), { code: 'gateway/arguments-invalid' })
        return { items: [{ sessionId: 's1', title: '旧对话', status: 'running' }] }
      }
      if (key === 'session/create') return { sessionId: 's9', agentPreset: 'ptc' }
      if (key === 'session/page') {
        return {
          hasMore: false,
          records: [
            { seq: 9, event: { type: 'user/message', seq: 9, data: { content: [{ type: 'text', text: '请继续' }], source: { kind: 'user' } } } },
            { seq: 10, event: { type: 'user/message', seq: 10, data: { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'time-context' } } } },
            { seq: 15, event: { type: 'session/title', seq: 15, data: { title: '收到的对话' } } },
            { seq: 20, event: { type: 'assistant/message', seq: 20, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } } },
            { seq: 21, event: { type: 'unknown/e', seq: 21, data: {} } },
          ],
        }
      }
      if (key === 'session/prompt') return { accepted: true }
      if (key === 'session/cancel') return { cancelled: true }
      throw Object.assign(new Error('unexpected endpoint ' + key), { code: 'gateway/method-unavailable' })
    },
    async stream(request) {
      calls.push({ ...request, streamed: true })
      if (request.method === 'follow' && request.namespace === 'workspace') {
        /* The real `WorkspaceBaseline` names its array `items`, not `workspaces`. */
        return (async function* baseline() {
          yield {
            type: 'baseline',
            value: {
              items: [{ workspaceId: 'w1', path: 'D:\proj', title: '项目', sessionIds: ['s1'], createdAt: 'x', updatedAt: 'y' }],
              archivedSessionIds: [],
              pinnedSessionIds: [],
            },
          }
        })()
      }
      /* History reads open the same follow stream, omit assistantStream, and stop at the snapshot. */
      if (request.args?.request?.assistantStream === undefined) {
        return (async function* history() {
          yield {
            type: 'snapshot',
            records: [
              { seq: 9, event: { type: 'user/message', seq: 9, data: { content: [{ type: 'text', text: '请继续' }], source: { kind: 'user' } } } },
              { seq: 10, event: { type: 'user/message', seq: 10, data: { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'time-context' } } } },
              { seq: 15, event: { type: 'session/title', seq: 15, data: { title: '收到的对话' } } },
              { seq: 20, event: { type: 'assistant/message', seq: 20, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } } },
              { seq: 21, event: { type: 'unknown/e', seq: 21, data: {} } },
            ],
          }
        })()
      }
      return (async function* frames() {
        yield {
          type: 'snapshot',
          records: [{ seq: 9, event: { type: 'user/message', seq: 9, data: { content: [{ type: 'text', text: '快照' }], source: { kind: 'user' } } } }],
        }
        yield { type: 'assistant-stream', frame: { kind: 'delta', text: '流' } }
      })()
    },
  }
  return gateway
}

/** Start the handler on an ephemeral loopback port with one seeded device token. */
async function startSurface(gateway) {
  const registry = new PairingRegistry()
  registry.seed('test-phone', 'test-token', 30)
  const streams = new Set()
  const desk = new ApprovalDesk({ publish: (notification) => {
    for (const write of streams) write(notification)
  }, timeoutMs: 5000 })
  const handler = createHandler({
    caller: createCaller(gateway),
    gateway,
    registry,
    openFollow: (request, signal) => gateway.stream({ namespace: 'session', method: 'follow', args: { request }, signal }),
    desk,
    streams,
    operatorKey: OPERATOR_KEY,
    config: { bodyLimitBytes: 65536, historyPageLimit: 60, deviceTokenDays: 30, pairCodeTtlSeconds: 600 },
    log: () => {},
  })
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, registry, desk, streams, close: () => new Promise((resolve) => server.close(resolve)) }
}

const auth = { authorization: 'Bearer test-token', 'content-type': 'application/json' }
const operator = { 'content-type': 'application/json', 'x-zt-operator-key': OPERATOR_KEY }

test('health is public, everything else needs a device token', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    const hello = await fetch(`${surface.base}/hello`)
    assert.equal(hello.status, 200)
    assert.equal((await hello.json()).value.plugin, 'dsh-plugin-zt-remote')

    const denied = await fetch(`${surface.base}/workspaces`)
    assert.equal(denied.status, 401)
    assert.equal((await denied.json()).error.code, 'auth/required')
  } finally {
    await surface.close()
  }
})

test('the phone typography sheet is served and declares its rules', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    const sheet = await fetch(`${surface.base}/phone.css`, { headers: auth })
    assert.equal(sheet.status, 200)
    assert.match(sheet.headers.get('content-type') ?? '', /text\/css/u)
    const css = await sheet.text()
    assert.match(css, /max-width: 768px/u, 'the sheet only applies on a narrow viewport')
    assert.match(css, /font-size: 13px/u, 'session titles tighten to 13px')

    /* The rules are readable as data, so the acceptance script can check them offline. */
    const listed = await (await fetch(`${surface.base}/phone.css?list=1`, { headers: auth })).json()
    assert.equal(listed.ok, true)
    assert.equal(listed.value.rules.length >= 3, true)
    assert.equal(
      listed.value.rules.some((rule) => rule.declarations.includes('font-size: 13px') && rule.declarations.includes('line-height: 18px')),
      true,
      JSON.stringify(listed.value.rules),
    )
  } finally {
    await surface.close()
  }
})

test('workspaces list and create reach the workspace controller', async () => {
  const gateway = fakeGateway()
  const surface = await startSurface(gateway)
  try {
    const list = await fetch(`${surface.base}/workspaces`, { headers: auth })
    const listed = (await list.json()).value.workspaces
    assert.equal(listed.length, 1)
    assert.equal(listed[0].workspaceId, 'w1')
    assert.equal(listed[0].path, 'D:\proj')
    assert.equal(listed[0].sessionCount, 1)

    const created = await fetch(`${surface.base}/workspaces`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ path: 'F:\\新项目' }),
    })
    const createdBody = await created.json()
    assert.equal(createdBody.value.created, true)
    assert.equal(createdBody.value.workspace.workspaceId, 'w2')

    const rejected = await fetch(`${surface.base}/workspaces`, { method: 'POST', headers: auth, body: JSON.stringify({}) })
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).error.code, 'workspace/path-required')

    assert.deepEqual(
      gateway.calls.filter((c) => c.namespace === 'workspace').map((c) => c.method),
      ['follow', 'create'],
    )
  } finally {
    await surface.close()
  }
})

test('sessions list, create, history, prompt, and cancel use the session controller', async () => {
  const gateway = fakeGateway()
  const surface = await startSurface(gateway)
  try {
    const list = await fetch(`${surface.base}/sessions`, { headers: auth })
    assert.equal((await list.json()).value.sessions[0].running, true)

    const created = await fetch(`${surface.base}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: 'w1' }),
    })
    assert.equal((await created.json()).value.sessionId, 's9')

    const messages = await fetch(`${surface.base}/sessions/s1/messages`, { headers: auth })
    const page = (await messages.json()).value
    /* The injected runtime-context message and the unknown event type must both be gone. */
    assert.deepEqual(
      page.messages.map((m) => `${m.role}:${m.text}`),
      ['user:请继续', 'assistant:好的'],
    )
    assert.equal(page.title, '收到的对话')

    const prompted = await fetch(`${surface.base}/sessions/s1/prompt`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '继续跑测试' }),
    })
    assert.equal((await prompted.json()).value.accepted, true)

    const empty = await fetch(`${surface.base}/sessions/s1/prompt`, { method: 'POST', headers: auth, body: JSON.stringify({ text: '  ' }) })
    assert.equal(empty.status, 400)

    const cancelled = await fetch(`${surface.base}/sessions/s1/cancel`, { method: 'POST', headers: auth, body: '{}' })
    assert.equal((await cancelled.json()).ok, true)

    const promptCall = gateway.calls.find((c) => c.method === 'prompt')
    assert.equal(promptCall.args.request.mode, 'queue')
    assert.deepEqual(promptCall.args.request.content, [{ type: 'text', text: '继续跑测试' }])
    assert.match(promptCall.args.request.requestId, /^zt-/)
  } finally {
    await surface.close()
  }
})

test('the event stream opens as SSE and forwards a snapshot plus frames', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    const controller = new AbortController()
    const response = await fetch(`${surface.base}/sessions/s1/events`, { headers: auth, signal: controller.signal })
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (text.split('event: snapshot').length < 3 && text.length < 4096) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    controller.abort()
    assert.match(text, /event: snapshot/)
    assert.match(text, /快照/)
    assert.match(text, /assistant-stream/)
  } finally {
    await surface.close()
  }
})

test('operator endpoints need the operator key and manage devices', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    /* A loopback peer is always admitted (defense in depth for a loopback bind);
       a peer that presents no key is refused. */
    const noKey = await fetch(`${surface.base}/operator/devices`, { headers: { 'x-forwarded-for': '10.20.55.9' } })
    assert.equal(noKey.status, 403)
    assert.equal((await noKey.json()).error.code, 'operator/key-required')

    const wrongKey = await fetch(`${surface.base}/operator/devices`, {
      headers: { 'x-forwarded-for': '10.20.55.9', 'x-zt-operator-key': 'nope' },
    })
    assert.equal(wrongKey.status, 403)

    const rightKey = await fetch(`${surface.base}/operator/devices`, { headers: operator })
    assert.equal(rightKey.status, 200)

    const code = await fetch(`${surface.base}/operator/code`, { headers: operator })
    const issued = (await code.json()).value
    assert.match(issued.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    assert.equal(typeof issued.secret, 'string')

    /* The same material must also be reachable through the query carrier. */
    const viaQuery = await fetch(`${surface.base}/operator/code?key=${OPERATOR_KEY}`)
    assert.equal((await viaQuery.json()).value.code, issued.code)

    const paired = await fetch(`${surface.base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, secret: issued.secret, deviceName: 'phone' }),
    })
    const pairedBody = await paired.json()
    assert.equal(pairedBody.ok, true)

    const reused = await fetch(`${surface.base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issued.code, secret: issued.secret }),
    })
    assert.equal(reused.status, 401)

    const devices = await fetch(`${surface.base}/operator/devices`, { headers: operator })
    assert.ok((await devices.json()).value.devices.some((d) => d.name === 'phone'))

    const revoked = await fetch(`${surface.base}/operator/revoke`, {
      method: 'POST',
      headers: operator,
      body: JSON.stringify({ deviceId: pairedBody.value.device.id }),
    })
    assert.equal((await revoked.json()).value.removed, 1)

    const after = await fetch(`${surface.base}/workspaces`, { headers: { authorization: `Bearer ${pairedBody.value.token}` } })
    assert.equal(after.status, 401)
  } finally {
    await surface.close()
  }
})

test('the phone UI is served at the root', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    const page = await fetch(`${surface.base}/`)
    const html = await page.text()
    assert.match(html, /DSH 远程/)
    assert.match(html, /EventSource/)
  } finally {
    await surface.close()
  }
})

test('a pending approval is listed, answered, and settled over HTTP', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    const denied = await fetch(`${surface.base}/approvals`)
    assert.equal(denied.status, 401)

    const decision = surface.desk.handle({ toolName: 'pwsh', reason: 'run tests', agent: { id: 's1' }, callId: 'c1' })

    const listed = await fetch(`${surface.base}/approvals`, { headers: auth })
    const pending = (await listed.json()).value.pending
    assert.equal(pending.length, 1)
    assert.equal(pending[0].toolName, 'pwsh')
    assert.equal(pending[0].reason, 'run tests')

    const malformed = await fetch(`${surface.base}/answers`, { method: 'POST', headers: auth, body: JSON.stringify({ requestId: pending[0].id }) })
    assert.equal(malformed.status, 400)

    const answered = await fetch(`${surface.base}/answers`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ requestId: pending[0].id, allow: true }),
    })
    assert.equal((await answered.json()).value.outcome, 'allowed-once')
    assert.equal(await decision, 'allowed-once')

    const again = await fetch(`${surface.base}/answers`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ requestId: pending[0].id, allow: true }),
    })
    assert.equal(again.status, 409)

    const after = await fetch(`${surface.base}/approvals`, { headers: auth })
    assert.deepEqual((await after.json()).value.pending, [])
  } finally {
    await surface.close()
  }
})

test('an approval notification reaches an open phone event stream', async () => {
  const surface = await startSurface(fakeGateway())
  try {
    const controller = new AbortController()
    const response = await fetch(`${surface.base}/events`, { headers: auth, signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const reading = (async () => {
      let text = ''
      while (text.length < 2048) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.includes('approval')) return text
      }
      return text
    })()

    const decision = surface.desk.handle({ toolName: 'read', agent: { id: 's1' } })
    const deadline = Date.now() + 2000
    while (surface.streams.size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    const text = await reading
    controller.abort()
    assert.match(text, /event: approval/)
    assert.match(text, /"toolName":"read"/)

    surface.desk.answer(surface.desk.list()[0].id, false)
    assert.equal(await decision, 'rejected')
  } finally {
    await surface.close()
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createUpgradeHandler } from '../server.js'
import { PairingRegistry } from '../auth.js'

/** A socket stand-in that records how it was ended. */
function fakeSocket() {
  const events = []
  return {
    events,
    destroy() {
      events.push('destroy')
    },
    end() {
      events.push('end')
    },
    write() {},
    on() {},
    once() {},
    removeListener() {},
  }
}

function deps(overrides = {}) {
  const registry = new PairingRegistry()
  registry.seed('phone', 'device-token', 30)
  return {
    caller: {},
    gateway: {},
    registry,
    openFollow: async () => (async function* () {})(),
    desk: { list: () => [] },
    streams: new Set(),
    operatorKey: 'op',
    hostSession: { hostBase: 'http://127.0.0.1:1', get: async () => 'dsh-auth-x=1', refresh: async () => 'dsh-auth-x=1' },
    config: { webui: true, webuiPrefix: '/ui', autoAccess: true },
    log: () => {},
    trace: () => {},
    ...overrides,
  }
}

/** Call the handler synchronously; only the refusal paths settle within the call. */
function handle(dependencies, request) {
  const socket = fakeSocket()
  createUpgradeHandler(dependencies)(request, socket, Buffer.alloc(0))
  return socket
}

test('an upgrade without a device credential is refused and never throws', () => {
  const socket = handle(deps(), { method: 'GET', url: '/ui/api/remote.mux', headers: {} })
  assert.deepEqual(socket.events, ['destroy'])
})

test('an upgrade outside the proxied paths is refused', () => {
  const socket = handle(deps(), { method: 'GET', url: '/somewhere/else', headers: { cookie: 'dsh-zt-token=device-token' } })
  assert.deepEqual(socket.events, ['destroy'])
})

test('the proxy stays disabled without a host session', () => {
  const socket = handle(deps({ hostSession: undefined }), {
    method: 'GET',
    url: '/ui/api/remote.mux',
    headers: { cookie: 'dsh-zt-token=device-token' },
  })
  assert.deepEqual(socket.events, ['destroy'])
})

test('an unparsable upgrade target is refused', () => {
  const socket = handle(deps(), { method: 'GET', url: 'http://[', headers: { cookie: 'dsh-zt-token=device-token' } })
  assert.deepEqual(socket.events, ['destroy'])
})

test('the admission decision is traced, so a refusal is never silent', () => {
  const lines = []
  handle(deps({ trace: (line) => lines.push(line) }), { method: 'GET', url: '/ui/api/remote.mux', headers: {} })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /reject: no device credential/)
})

test('a request body stream is untouched by an upgrade decision', () => {
  /* Guards the direction the handler must not take: it must not consume a body it
     does not own, because a proxied request still needs that stream. */
  const body = Readable.from(['x'])
  const socket = handle(deps(), { method: 'GET', url: '/ui/api/remote.mux', headers: { cookie: 'nope' }, body })
  assert.equal(body.readableEnded, false)
  assert.deepEqual(socket.events, ['destroy'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readWebServer, resolveHostBase } from '../host-origin.js'

test('an explicit hostBase wins and loses its trailing slash', () => {
  assert.deepEqual(resolveHostBase('http://127.0.0.1:49406/', { port: 1234 }), {
    base: 'http://127.0.0.1:49406',
    source: 'config',
  })
})

test('an empty hostBase is detected from the live webServer port', () => {
  assert.deepEqual(resolveHostBase('', { protocol: 'http:', port: 49406 }), {
    base: 'http://127.0.0.1:49406',
    source: 'webServer',
  })
})

test('the webServer protocol is normalized whether or not it carries a colon', () => {
  assert.equal(resolveHostBase('', { protocol: 'https', port: 9 }).base, 'https://127.0.0.1:9')
  assert.equal(resolveHostBase('', { protocol: 'http:', port: 9 }).base, 'http://127.0.0.1:9')
})

test('the webServer protocol falls back to http when absent', () => {
  assert.equal(resolveHostBase('', { port: 8080 }).base, 'http://127.0.0.1:8080')
})

test('an unusable webServer port falls back instead of composing a bad origin', () => {
  for (const webServer of [undefined, {}, { port: 0 }, { port: -1 }, { port: 'nope' }, { port: 70_000 }]) {
    const resolved = resolveHostBase('', webServer, 'http://127.0.0.1:19387')
    assert.deepEqual(resolved, { base: 'http://127.0.0.1:19387', source: 'fallback' })
  }
})

test('a whitespace-only hostBase is treated as absent', () => {
  assert.equal(resolveHostBase('   ', { port: 5555 }).source, 'webServer')
})

test('readWebServer returns undefined when the service is absent or the lookup throws', () => {
  assert.equal(readWebServer(undefined), undefined)
  assert.equal(readWebServer({}), undefined)
  assert.equal(readWebServer({ get: () => undefined }), undefined)
  assert.deepEqual(readWebServer({ get: () => ({ port: 7 }) }), { port: 7 })

  const throwing = {
    get: () => {
      throw new Error('service unavailable')
    },
  }
  assert.equal(readWebServer(throwing), undefined, 'a failing lookup must not escape activation')
})

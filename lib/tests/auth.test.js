import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PairingRegistry, hashSecret, verifySecret, hashToken } from '../auth.js'

/** Seconds-scale clock helper so expiry tests do not sleep. */
const now = () => 1_000_000_000_000

test('pairing secret digests verify only the matching secret', () => {
  const stored = hashSecret('correct-horse')
  assert.equal(verifySecret('correct-horse', stored), true)
  assert.equal(verifySecret('wrong-horse', stored), false)
  assert.equal(verifySecret('correct-horse', 'not-a-digest'), false)
})

test('a code pairs once, issues a token, and consumes the code', async () => {
  let persisted
  const registry = new PairingRegistry(async (state) => {
    persisted = state
  })
  const { code, secret } = registry.issueCode(600, now())

  const paired = await registry.pair(code, secret, 'phone', 30, now())
  assert.ok(paired !== undefined)
  assert.equal(paired.device.name, 'phone')
  assert.equal(paired.device.tokenHash, hashToken(paired.token))

  assert.equal(registry.currentCode(), undefined)
  assert.equal(await registry.pair(code, secret, 'phone', 30, now()), undefined)
  assert.equal(persisted.devices.length, 1)
  assert.equal(JSON.stringify(persisted).includes(paired.token), false)
})

test('an expired code and a wrong secret are both refused', async () => {
  const registry = new PairingRegistry()
  const first = registry.issueCode(60, now())
  assert.equal(await registry.pair(first.code, first.secret, 'phone', 30, now() + 61_000), undefined)

  const second = registry.issueCode(60, now())
  assert.equal(await registry.pair(second.code, 'bogus', 'phone', 30, now()), undefined)
  assert.equal(await registry.pair('ZZZZ-ZZZZ', second.secret, 'phone', 30, now()), undefined)
})

test('authentication honours the token lifetime and revocation', async () => {
  const registry = new PairingRegistry()
  const code = registry.issueCode(600, now())
  const paired = await registry.pair(code.code, code.secret, 'phone', 1, now())

  assert.equal(await registry.authenticate('nope', now()), undefined)
  assert.ok((await registry.authenticate(paired.token, now())) !== undefined)
  assert.equal(await registry.authenticate(paired.token, now() + 2 * 86_400_000), undefined)
})

test('pairing attempts are rate limited to ten per rolling minute', () => {
  const registry = new PairingRegistry()
  for (let i = 0; i < 10; i += 1) assert.equal(registry.admitAttempt(now() + i), true)
  assert.equal(registry.admitAttempt(now() + 11), false)
  assert.equal(registry.admitAttempt(now() + 61_000), true)
})

test('seeded device authenticates and revoke removes it', async () => {
  const registry = new PairingRegistry()
  registry.seed('test-phone', 'token-abc', 30, now())
  assert.ok((await registry.authenticate('token-abc', now())) !== undefined)
  assert.equal(await registry.revoke(undefined), 1)
  assert.equal(await registry.authenticate('token-abc', now()), undefined)
  assert.equal(registry.roster().length, 0)
})

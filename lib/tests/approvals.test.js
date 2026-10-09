import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalDesk } from '../approvals.js'

/** Collect published notifications while driving one desk. */
function makeDesk(timeoutMs = 1000) {
  const events = []
  const desk = new ApprovalDesk({ publish: (event) => events.push(event), timeoutMs })
  return { desk, events }
}

test('a phone answer grants exactly one action', async () => {
  const { desk, events } = makeDesk()
  const ask = { toolName: 'pwsh', reason: 'run tests', agent: { id: 's1' }, callId: 'c1' }

  const decision = desk.handle(ask)
  const pending = desk.list()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].toolName, 'pwsh')
  assert.equal(pending[0].sessionId, 's1')
  assert.equal(events[0].type, 'pending')

  assert.equal(desk.answer(pending[0].id, true), 'allowed-once')
  assert.equal(await decision, 'allowed-once')
  assert.equal(desk.list().length, 0)
  assert.equal(events.at(-1).type, 'settled')
})

test('a denial and a second answer on the same ask', async () => {
  const { desk } = makeDesk()
  const decision = desk.handle({ toolName: 'tool', agent: { id: 's1' } })
  const id = desk.list()[0].id

  assert.equal(desk.answer(id, false), 'rejected')
  assert.equal(await decision, 'rejected')
  assert.equal(desk.answer(id, true), undefined)
})

test('an unanswered ask delegates when its budget runs out', async () => {
  const { desk } = makeDesk(30)
  const outcome = await desk.handle({ toolName: 'tool', agent: { id: 's1' } })
  assert.equal(outcome, undefined)
  assert.equal(desk.list().length, 0)
})

test('only one ask is offered at a time, so one phone answer is unambiguous', async () => {
  const { desk } = makeDesk()
  const first = desk.handle({ toolName: 'one', agent: { id: 's1' } })
  const second = await desk.handle({ toolName: 'two', agent: { id: 's1' } })
  assert.equal(second, undefined)

  desk.answer(desk.list()[0].id, true)
  assert.equal(await first, 'allowed-once')
})

test('an aborted ask resolves without a decision', async () => {
  const { desk } = makeDesk(5000)
  const abort = new AbortController()
  const decision = desk.handle({ toolName: 'tool', agent: { id: 's1' }, signal: abort.signal })
  abort.abort()
  assert.equal(await decision, undefined)
})

test('releaseAll delegates every pending ask', async () => {
  const { desk } = makeDesk(5000)
  const decision = desk.handle({ toolName: 'tool', agent: { id: 's1' } })
  desk.releaseAll()
  assert.equal(await decision, undefined)
  assert.equal(desk.list().length, 0)
})
